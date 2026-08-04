import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createMcpServer } from './mcp/server.js';
import { config } from './config.js';
import { pino } from 'pino';
import { WindowsEventLogger } from './utils/eventLogger.js';
import { BcClientFactory } from './instances/clientFactory.js';
import { EncryptedInstanceRegistry } from './instances/registry.js';
import { LogService } from './logging/logService.js';

if (config.ADMIN_API_ENABLED && !config.ADMIN_API_KEY?.trim()) {
    throw new Error('ADMIN_API_KEY must be configured when ADMIN_API_ENABLED is true.');
}

// IMPORTANT: Logs MUST go to stderr when using Stdio transport to avoid corrupting the protocol
const logger = pino({
    level: config.LOG_LEVEL,
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'HH:MM:ss Z',
            destination: 2, // 2 is stderr
        },
    },
});

const instanceRegistry = new EncryptedInstanceRegistry(
    config.INSTANCE_STORE_PATH,
    config.INSTANCE_MASTER_KEY,
);
await instanceRegistry.load();
const bcClientFactory = new BcClientFactory(instanceRegistry);
const logService = new LogService(
    config.LOG_DIR,
    config.LOG_RETENTION_DAYS,
    config.LOG_SCRIPT_MAX_LENGTH,
);

const toSafeEventMessage = (value: unknown, maxLen = 400) => {
    const raw = typeof value === 'string'
        ? value
        : (value && typeof value === 'object' && 'message' in (value as any))
            ? String((value as any).message || '')
            : String(value || 'Unknown error');

    const redacted = raw
        .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
        .replace(/(Authorization\s*:\s*Basic\s+)[^\s,;]+/gi, '$1[REDACTED]')
        .replace(/("?(?:password|client_secret|api_key|token)"?\s*[:=]\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
        .replace(/("?(?:password|client_secret|api_key|token)"?\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
        .replace(/[\r\n\t]+/g, ' ')
        .trim();

    if (redacted.length <= maxLen) {
        return redacted;
    }
    return `${redacted.slice(0, maxLen)}...`;
};

const fastify = Fastify({
    logger: false,
    connectionTimeout: 0,
    // Helps when reverse proxies (or clients) accidentally create URLs like "//mcp/messages".
    ignoreDuplicateSlashes: true,
    ignoreTrailingSlash: true,
});

const allowedCorsOrigins = new Set(config.resolvedCorsOrigins);

const normalizeOriginHeader = (origin: string) => {
    try {
        return new URL(origin).origin;
    } catch {
        return origin.replace(/\/+$/, '');
    }
};

const isCorsOriginAllowed = (origin?: string) => {
    // Requests without Origin (CLI/server-to-server) are allowed.
    if (!origin) {
        return true;
    }

    return allowedCorsOrigins.has(normalizeOriginHeader(origin));
};

const corsOriginHandler = (origin: string | undefined, callback: (error: Error | null, allow: boolean) => void) => {
    if (isCorsOriginAllowed(origin)) {
        callback(null, true);
        return;
    }

    logger.warn({ origin }, 'CORS origin rejected');
    callback(null, false);
};

await fastify.register(cors, {
    origin: corsOriginHandler,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS', 'DELETE'],
    allowedHeaders: [
        'Content-Type',
        'X-MCP-ClientId',
        'Authorization',
        'mcp-session-id',
        'mcp-protocol-version',
        'x-mcp-protocol-version'
    ],
    exposedHeaders: ['mcp-session-id', 'mcp-protocol-version'],
});

const adminUiRoot = path.resolve(process.cwd(), 'admin-ui');
let adminUiAvailable = false;
try {
    adminUiAvailable = (await stat(adminUiRoot)).isDirectory();
} catch {
    logger.warn({ adminUiRoot }, 'Admin UI build directory is unavailable');
}

if (adminUiAvailable) {
    await fastify.register(fastifyStatic, {
        root: adminUiRoot,
        prefix: '/admin/',
        wildcard: false,
    });
}

// Configure the underlying Node server timeouts
fastify.addHook('onReady', () => {
    fastify.server.keepAliveTimeout = 0;
    fastify.server.headersTimeout = 0;
    fastify.server.requestTimeout = 0;
});

// NOTE: Each transport needs its OWN MCP server instance.
// Protocol.connect() replaces the internal _transport reference,
// so sharing one instance across transports would break all but the last one.

// --- Authentication Middleware ---
const isValidApiKey = (request: any) => {
    const configKey = config.MCP_API_KEY?.trim();

    // If not configured, allow all
    if (!configKey) {
        return true;
    }

    const authHeader = request.headers.authorization;
    const bearerToken = (typeof authHeader === 'string' && authHeader.startsWith('Bearer '))
        ? authHeader.substring(7).trim()
        : null;

    return bearerToken === configKey;
};

const hasValidAdminKey = (providedKey: unknown): boolean => {
    const configuredKey = config.ADMIN_API_KEY?.trim();
    if (!configuredKey || typeof providedKey !== 'string' || providedKey.length !== configuredKey.length) {
        return false;
    }
    return timingSafeEqual(Buffer.from(providedKey), Buffer.from(configuredKey));
};

const isValidAdminApiKey = (request: any): boolean => {
    const authHeader = request.headers.authorization;
    const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.substring(7).trim()
        : undefined;
    return hasValidAdminKey(bearerToken);
};

const sendAdminError = (reply: any, error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    const statusCode = message.includes('was not found') ? 404 : 400;
    return reply.code(statusCode).send({ error: statusCode === 404 ? 'Not found.' : 'Invalid request.' });
};

if (config.ADMIN_API_ENABLED) {
    fastify.addHook('onRequest', async (request, reply) => {
        if (request.url.startsWith('/admin/api') && !isValidAdminApiKey(request)) {
            return reply.code(401).send({ error: 'Unauthorized.' });
        }
    });

    fastify.get('/', async (_request, reply) => reply.redirect('/admin'));

    fastify.get('/admin/api/instances', async (_request, reply) => {
        reply.header('cache-control', 'no-store');
        return instanceRegistry.listPublicInstances();
    });

    fastify.post('/admin/api/instances', async (request, reply) => {
        try {
            const instance = await instanceRegistry.createInstance(request.body);
            reply.code(201).header('cache-control', 'no-store');
            return instance;
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.patch('/admin/api/instances/:instanceName', async (request, reply) => {
        try {
            const instance = await instanceRegistry.updateInstance((request.params as any).instanceName, request.body);
            reply.header('cache-control', 'no-store');
            return instance;
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.delete('/admin/api/instances/:instanceName', async (request, reply) => {
        try {
            await instanceRegistry.deleteInstance((request.params as any).instanceName);
            return reply.code(204).send();
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.patch('/admin/api/instances/:instanceName/enabled', async (request, reply) => {
        try {
            const instance = await instanceRegistry.setInstanceEnabled(
                (request.params as any).instanceName,
                (request.body as any)?.enabled,
            );
            reply.header('cache-control', 'no-store');
            return instance;
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.post('/admin/api/instances/:instanceName/companies', async (request, reply) => {
        try {
            const company = await instanceRegistry.createCompany((request.params as any).instanceName, request.body);
            reply.code(201).header('cache-control', 'no-store');
            return company;
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.patch('/admin/api/instances/:instanceName/companies/:companyName', async (request, reply) => {
        try {
            const company = await instanceRegistry.updateCompany(
                (request.params as any).instanceName,
                (request.params as any).companyName,
                request.body,
            );
            reply.header('cache-control', 'no-store');
            return company;
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.delete('/admin/api/instances/:instanceName/companies/:companyName', async (request, reply) => {
        try {
            await instanceRegistry.deleteCompany((request.params as any).instanceName, (request.params as any).companyName);
            return reply.code(204).send();
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.patch('/admin/api/instances/:instanceName/companies/:companyName/enabled', async (request, reply) => {
        try {
            const company = await instanceRegistry.setCompanyEnabled(
                (request.params as any).instanceName,
                (request.params as any).companyName,
                (request.body as any)?.enabled,
            );
            reply.header('cache-control', 'no-store');
            return company;
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.post('/admin/api/instances/:instanceName/companies/:companyName/test-connection', async (request, reply) => {
        const { instanceName, companyName } = request.params as { instanceName: string; companyName: string };
        const requestId = randomUUID();
        const startedAt = Date.now();
        let target: ReturnType<typeof bcClientFactory.resolve> | undefined;

        try {
            target = bcClientFactory.resolve(instanceName, companyName);
            await target.client.callAction('JMXQ_ApiInfoService', 'ListExecutionContexts', target.company.company, {});

            try {
                await logService.record({
                    instanceId: target.instance.id,
                    instanceName: target.instance.name,
                    companyId: target.company.id,
                    companyName: target.company.name,
                    tool: 'admin_testConnection',
                    status: 'success',
                    durationMs: Date.now() - startedAt,
                    requestId,
                    executionContextCode: target.company.executionContextCode,
                });
            } catch {
                logger.error({ tool: 'admin_testConnection', requestId }, 'Admin connection test log write failed');
            }

            reply.header('cache-control', 'no-store');
            return { status: 'ok', durationMs: Date.now() - startedAt };
        } catch (error: any) {
            try {
                await logService.record({
                    instanceId: target?.instance.id,
                    instanceName: target?.instance.name || instanceName,
                    companyId: target?.company.id,
                    companyName: target?.company.name || companyName,
                    tool: 'admin_testConnection',
                    status: 'error',
                    durationMs: Date.now() - startedAt,
                    requestId,
                    executionContextCode: target?.company.executionContextCode,
                    errorType: error?.name || 'Error',
                    errorMessage: error?.message || 'Connection test failed.',
                });
            } catch {
                logger.error({ tool: 'admin_testConnection', requestId }, 'Admin connection test failure log write failed');
            }

            logger.error({ tool: 'admin_testConnection', requestId, errorType: error?.name || 'Error' }, 'Admin connection test failed');
            return reply.code(400).send({ error: 'Invalid request.' });
        }
    });

    fastify.post('/admin/api/instances/:instanceName/secrets/:field/reveal', async (request, reply) => {
        const body = request.body as { confirmAdminKey?: unknown } | undefined;
        if (!hasValidAdminKey(body?.confirmAdminKey)) {
            return reply.code(403).send({ error: 'Forbidden.' });
        }
        const field = (request.params as any).field;
        if (field !== 'password' && field !== 'clientSecret') {
            return reply.code(400).send({ error: 'Invalid request.' });
        }
        try {
            const value = instanceRegistry.getSecret((request.params as any).instanceName, field);
            reply.header('cache-control', 'no-store');
            return { field, value };
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.get('/admin/api/logs', async (request, reply) => {
        const { limit, status, ...filters } = request.query as Record<string, string | undefined>;
        const parsedLimit = limit === undefined ? undefined : Number(limit);
        if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
            return reply.code(400).send({ error: 'Invalid request.' });
        }
        if (status && status !== 'success' && status !== 'error') {
            return reply.code(400).send({ error: 'Invalid request.' });
        }
        reply.header('cache-control', 'no-store');
        return logService.query({ ...filters, status: status as 'success' | 'error' | undefined, limit: parsedLimit });
    });

    fastify.get('/admin/api/logs/metrics', async (request, reply) => {
        const { limit: _limit, status, ...filters } = request.query as Record<string, string | undefined>;
        if (status && status !== 'success' && status !== 'error') {
            return reply.code(400).send({ error: 'Invalid request.' });
        }
        reply.header('cache-control', 'no-store');
        return logService.getMetrics({ ...filters, status: status as 'success' | 'error' | undefined });
    });

    fastify.get('/admin/api/logs/events', async (_request, reply) => {
        reply.hijack();
        const response = reply.raw;
        response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
        });
        response.write(': connected\n\n');
        const unsubscribe = logService.subscribe(record => {
            if (!response.destroyed) {
                response.write(`data: ${JSON.stringify(record)}\n\n`);
            }
        });
        const heartbeat = setInterval(() => {
            if (!response.destroyed) response.write(': keepalive\n\n');
        }, 30000);
        response.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
        });
    });

    fastify.get('/admin/api/documentation', async (_request, reply) => {
        try {
            const documentation = await readFile(path.resolve(process.cwd(), 'README.md'), 'utf8');
            return reply
                .header('cache-control', 'no-store')
                .type('text/markdown; charset=utf-8')
                .send(documentation);
        } catch {
            return reply.code(404).send({ error: 'Documentation is unavailable.' });
        }
    });
}

const sendAdminNotFound = (reply: any) => reply.code(404).type('text/plain; charset=utf-8').send('Admin UI not found.');

if (!adminUiAvailable) {
    fastify.get('/admin', async (_request, reply) => sendAdminNotFound(reply));
}

fastify.get('/admin/*', async (request, reply) => {
    const requestPath = (request.params as { '*': string })['*'] || '';
    if (requestPath === 'api' || requestPath.startsWith('api/')) {
        return reply.code(404).send({ error: 'Not found.' });
    }
    if (!adminUiAvailable) return sendAdminNotFound(reply);

    const candidatePath = path.resolve(adminUiRoot, requestPath);
    const relativePath = path.relative(adminUiRoot, candidatePath);
    if (relativePath && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..') {
        try {
            if ((await stat(candidatePath)).isFile()) {
                return reply.sendFile(requestPath);
            }
        } catch {
            // A client-side route should receive the SPA entry point.
        }
    }
    return reply.sendFile('index.html');
});

// --- SSE Transport (for HTTP/Web Clients) ---
const activeTransports = new Map<string, SSEServerTransport>();

fastify.get('/mcp/sse', async (request, reply) => {
    logger.info('New SSE Connection attempt');

    if (!isValidApiKey(request)) {
        logger.warn('Unauthorized SSE Connection attempt');
        reply.code(401)
            .send({ error: 'Unauthorized', message: 'Invalid or missing API Key' });
        return;
    }

    try {
        reply.hijack();
        const res = reply.raw;

        const requestOrigin = request.headers.origin;
        if (typeof requestOrigin === 'string' && isCorsOriginAllowed(requestOrigin)) {
            res.setHeader('Access-Control-Allow-Origin', requestOrigin);
            res.setHeader('Vary', 'Origin');
        }
        res.setTimeout(0);

        // The SDK will automatically append ?sessionId=... to this endpoint.
        // Authentication must be provided via Authorization: Bearer <key> header.
        const transport = new SSEServerTransport('/mcp/messages', res);
        const sessionId = transport.sessionId;

        activeTransports.set(sessionId, transport);
        logger.info({ sessionId }, 'New SSE Transport created');

        request.raw.on('close', () => {
            logger.info({ sessionId }, 'SSE Connection Closed');
            activeTransports.delete(sessionId);
        });

        // Each SSE session gets its own MCP server instance
        const sessionMcpServer = createMcpServer(bcClientFactory, logService);
        await sessionMcpServer.connect(transport);
        logger.info({ sessionId }, 'MCP Server SSE session connected');
    } catch (error: any) {
        logger.error({ error }, 'Error in SSE connection handler');
        if (reply.raw && !reply.raw.writableEnded) {
            if (!reply.raw.headersSent) {
                reply.raw.writeHead(500);
            }
            reply.raw.end(`Server Error: ${error.message}`);
        }
    }
});

fastify.post('/mcp/messages', async (request, reply) => {
    if (request.method === 'OPTIONS') {
        reply.code(204).send();
        return;
    }

    if (!isValidApiKey(request)) {
        logger.warn('Unauthorized Message attempt');
        reply.code(401)
            .send({ error: 'Unauthorized', message: 'Invalid or missing API Key' });
        return;
    }

    const sessionId = (request.query as any)?.sessionId;
    const transport = sessionId ? activeTransports.get(sessionId) : null;

    if (!transport) {
        logger.warn({ sessionId }, 'POST /mcp/messages: No active transport found for session');
        reply.code(400).send({ error: 'SERVER_NO_ACTIVE_TRANSPORT', sessionId });
        return;
    }

    try {
        const message = request.body as any;
        // Use the SDK's handleMessage for better robustness
        await transport.handleMessage(message);
        reply.code(202).send('Accepted');
    } catch (error: any) {
        logger.error({ error, sessionId }, 'Error accepting POST message');
        if (!reply.raw.headersSent) {
            reply.code(500).send({ error: `SERVER_POST_ERROR: ${error.message}` });
        }
    }
});

// --- Streamable HTTP Transport (New Protocol) ---
const streamableTransport = new StreamableHTTPServerTransport();

streamableTransport.onmessage = (message) => {
    const method = (message as any).method || 'notification/response';
    logger.info({ method }, 'Streamable HTTP transport received message');
};

streamableTransport.onerror = (error) => {
    logger.error({ error }, 'Streamable HTTP transport error');
};

// Determine which Fastify instance hosts the Streamable HTTP routes
const streamablePort = config.MCP_STREAMABLE_PORT;
const streamableFastify = streamablePort
    ? Fastify({
        logger: false,
        connectionTimeout: 0,
        ignoreDuplicateSlashes: true,
        ignoreTrailingSlash: true,
    })
    : fastify;

if (streamablePort) {
    // Separate server needs its own CORS and timeout config
    await streamableFastify.register(cors, {
        origin: corsOriginHandler,
        methods: ['GET', 'POST', 'PATCH', 'OPTIONS', 'DELETE'],
        allowedHeaders: [
            'Content-Type',
            'X-MCP-ClientId',
            'Authorization',
            'mcp-session-id',
            'mcp-protocol-version',
            'x-mcp-protocol-version'
        ],
        exposedHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    });
    streamableFastify.addHook('onReady', () => {
        streamableFastify.server.keepAliveTimeout = 0;
        streamableFastify.server.headersTimeout = 0;
        streamableFastify.server.requestTimeout = 0;
    });
}

// Handle all methods for the streaming endpoint
streamableFastify.all('/mcp/stream', async (request, reply) => {
    logger.info({ method: request.method, url: request.url }, 'Streamable HTTP request received');

    if (!isValidApiKey(request)) {
        logger.warn('Unauthorized Streamable HTTP attempt');
        reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing API Key' });
        return;
    }

    try {
        // We MUST hijack the reply for the transport to work correctly with streaming
        reply.hijack();

        // Pass the body if it was already parsed by Fastify (for POST requests)
        // For GET requests, request.body will be undefined which is correct.
        await streamableTransport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error: any) {
        logger.error({ error }, 'Error in Streamable HTTP handler');
        if (reply.raw && !reply.raw.writableEnded) {
            if (!reply.raw.headersSent) {
                reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
            }
            reply.raw.end(JSON.stringify({ error: `STREAMABLE_ERROR: ${error.message}` }));
        }
    }
});

// Also support sub-paths (if needed)
streamableFastify.all('/mcp/stream/*', async (request, reply) => {
    if (!isValidApiKey(request)) {
        reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing API Key' });
        return;
    }
    reply.hijack();
    await streamableTransport.handleRequest(request.raw, reply.raw, request.body);
});

// --- Stdio Transport (for AI Agents like Claude Desktop/Cline) ---
const startStdio = async () => {
    // Check if we are in a TTY. If not, we probably want Stdio support.
    // However, it's safer to always try to connect it if it's not a terminal
    // or if the user explicitly wants it. For MCP servers, adding it doesn't hurt.
    try {
        const stdioMcpServer = createMcpServer(bcClientFactory, logService);
        const stdioTransport = new StdioServerTransport();
        await stdioMcpServer.connect(stdioTransport);
        logger.info('MCP Server Stdio transport connected');
    } catch (err) {
        logger.error({ err }, 'Failed to start Stdio transport');
        WindowsEventLogger.error(`Stdio transport startup failed: ${toSafeEventMessage(err)}`);
    }
};

const start = async () => {
    try {
        // Start Stdio transport in parallel
        startStdio();

        // Connect Streamable transport with its own MCP server instance
        const streamableMcpServer = createMcpServer(bcClientFactory, logService);
        await streamableMcpServer.connect(streamableTransport);
        logger.info('MCP Server Streamable transport connected');

        // Start HTTP server for SSE (and Streamable HTTP if no separate port)
        await fastify.listen({ port: config.MCP_PORT, host: config.MCP_HOST });
        logger.info(`JMX-QUERY MCP Server running at http://${config.MCP_HOST}:${config.MCP_PORT}`);
        logger.info(`SSE Endpoint: http://${config.MCP_HOST}:${config.MCP_PORT}/mcp/sse`);

        // Start separate Streamable HTTP server if configured
        if (streamablePort) {
            await streamableFastify.listen({ port: streamablePort, host: config.MCP_HOST });
            logger.info(`Streamable HTTP Endpoint: http://${config.MCP_HOST}:${streamablePort}/mcp/stream`);
        } else {
            logger.info(`Streamable HTTP Endpoint: http://${config.MCP_HOST}:${config.MCP_PORT}/mcp/stream`);
        }

        WindowsEventLogger.info('JMX-QUERY MCP Server started successfully');

        const isAuthActive = !!config.MCP_API_KEY;
        if (isAuthActive) {
            logger.info('*** SECURITY: API Key Authentication is ENABLED ***');
        } else {
            logger.warn('*** SECURITY: API Key Authentication is DISABLED (Unsecured) ***');
        }

        logger.info({
            securityActive: isAuthActive,
            keyLength: config.MCP_API_KEY?.length || 0
        }, 'Authentication status');
    } catch (err) {
        logger.error(err);
        WindowsEventLogger.error(`MCP server startup failed: ${toSafeEventMessage(err)}`);
        process.exit(1);
    }
};

start();

// Graceful shutdown handler
const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal, closing server...');

    try {
        // Close all active SSE transports
        for (const [sessionId, transport] of activeTransports.entries()) {
            try {
                await transport.close();
                logger.info({ sessionId }, 'SSE Transport closed');
            } catch (err) {
                logger.error({ err, sessionId }, 'Error closing SSE transport');
            }
        }
        activeTransports.clear();

        // Close Fastify servers
        if (streamablePort) {
            await streamableFastify.close();
            logger.info('Streamable HTTP server closed successfully');
        }
        await fastify.close();
        logger.info('Fastify server closed successfully');

        WindowsEventLogger.info('JMX-QUERY MCP Server stopped');
        process.exit(0);
    } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        WindowsEventLogger.error(`MCP server shutdown failed: ${toSafeEventMessage(err)}`);
        process.exit(1);
    }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
