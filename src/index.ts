import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import path from 'node:path';
import { createMcpServer } from './mcp/server.js';
import { config } from './config.js';
import { pino } from 'pino';
import { WindowsEventLogger } from './utils/eventLogger.js';
import { BcClient } from './bcClient.js';
import { BcClientFactory } from './instances/clientFactory.js';
import { EncryptedInstanceRegistry } from './instances/registry.js';
import { connectionConfigSchema, instanceSchema } from './instances/model.js';
import { LogService } from './logging/logService.js';
import { configureMcpActivityLogger, logMcpActivity, runWithMcpActivity, type McpActivityContext } from './mcp/activity.js';
import { executeTool, isRegisteredTool, toolDefinitions } from './mcp/tools.js';

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
            singleLine: true,
            destination: 2, // 2 is stderr
        },
    },
});
configureMcpActivityLogger(logger);

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

const createTransientConnectionClient = (input: unknown): BcClient => {
    const connection = connectionConfigSchema.parse(input);
    const timestamp = new Date().toISOString();
    const instance = instanceSchema.parse({
        ...connection,
        id: randomUUID(),
        name: 'Admin connection test',
        description: '',
        enabled: false,
        technicalCompany: '__connection_test__',
        createdAt: timestamp,
        updatedAt: timestamp,
    });
    return new BcClient(instance);
};

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
    routerOptions: {
        ignoreDuplicateSlashes: true,
        ignoreTrailingSlash: true,
    },
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
    credentials: true,
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
    const configKey = config.JMXQ_MCPAPI_KEY?.trim();

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

const ADMIN_SESSION_COOKIE = 'jmxquery_admin_session';
const adminSessions = new Set<string>();

const getCookieValue = (request: any, name: string): string | undefined => {
    const cookieHeader = request.headers.cookie;
    if (typeof cookieHeader !== 'string') return undefined;

    return cookieHeader
        .split(';')
        .map((entry: string) => entry.trim())
        .find((entry: string) => entry.startsWith(`${name}=`))
        ?.slice(name.length + 1);
};

const hasValidAdminSession = (request: any): boolean => {
    const sessionId = getCookieValue(request, ADMIN_SESSION_COOKIE);
    if (!sessionId) return false;
    return adminSessions.has(sessionId);
};

const adminSessionCookie = (request: any): string => {
    const priorSessionId = getCookieValue(request, ADMIN_SESSION_COOKIE);
    if (priorSessionId) adminSessions.delete(priorSessionId);
    const sessionId = randomUUID();
    adminSessions.add(sessionId);
    const attributes = [
        `${ADMIN_SESSION_COOKIE}=${sessionId}`,
        'HttpOnly',
        'Path=/admin/api',
        'SameSite=Strict',
    ];
    if (request.protocol === 'https') attributes.push('Secure');
    return attributes.join('; ');
};

const clearAdminSessionCookie = (request: any): string => {
    const sessionId = getCookieValue(request, ADMIN_SESSION_COOKIE);
    if (sessionId) adminSessions.delete(sessionId);
    const attributes = [
        `${ADMIN_SESSION_COOKIE}=`,
        'HttpOnly',
        'Path=/admin/api',
        'SameSite=Strict',
        'Max-Age=0',
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ];
    if (request.protocol === 'https') attributes.push('Secure');
    return attributes.join('; ');
};

const getLanAddresses = (): string[] => Array.from(new Set(
    Object.values(networkInterfaces())
        .flatMap(addresses => addresses || [])
        .filter(address => address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))
        .map(address => address.address),
));

const getDisplayHost = (host: string): string => host === '0.0.0.0' ? '127.0.0.1' : host;

const isValidAdminApiKey = (request: any): boolean => {
    const authHeader = request.headers.authorization;
    const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.substring(7).trim()
        : undefined;
    return hasValidAdminKey(bearerToken);
};

const isValidAdminAuthentication = (request: any): boolean => isValidAdminApiKey(request) || hasValidAdminSession(request);

const sendAdminError = (reply: any, error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    const statusCode = message.includes('was not found') ? 404 : 400;
    return reply.code(statusCode).send({ error: statusCode === 404 ? 'Not found.' : 'Invalid request.' });
};

if (config.ADMIN_API_ENABLED) {
    fastify.addHook('onRequest', async (request, reply) => {
        if (request.url.startsWith('/admin/api') && !isValidAdminAuthentication(request)) {
            return reply.code(401).send({ error: 'Unauthorized.' });
        }
    });

    fastify.get('/', async (_request, reply) => reply.redirect('/admin'));

    fastify.post('/admin/api/session', async (request, reply) => {
        reply.header('set-cookie', adminSessionCookie(request));
        reply.header('cache-control', 'no-store');
        return { authenticated: true };
    });

    fastify.get('/admin/api/session', async (_request, reply) => {
        reply.header('cache-control', 'no-store');
        return { authenticated: true };
    });

    fastify.get('/admin/api/mcp-connection', async (_request, reply) => {
        reply.header('cache-control', 'no-store');
        return {
            streamablePort: config.MCP_STREAMABLE_PORT ?? null,
            apiKeyRequired: Boolean(config.JMXQ_MCPAPI_KEY?.trim()),
            hostname: hostname(),
            lanAddresses: getLanAddresses(),
            workingDirectory: process.cwd(),
            nodePath: process.execPath,
        };
    });

    fastify.post('/admin/api/mcp-connection/api-key/reveal', async (_request, reply) => {
        const value = config.JMXQ_MCPAPI_KEY?.trim();
        if (!value) return reply.code(404).send({ error: 'MCP API key is not configured.' });
        reply.header('cache-control', 'no-store');
        return { value };
    });

    fastify.post('/admin/api/session/logout', async (request, reply) => {
        reply.header('set-cookie', clearAdminSessionCookie(request));
        reply.header('cache-control', 'no-store');
        return reply.code(204).send();
    });

    fastify.get('/admin/api/instances', async (_request, reply) => {
        reply.header('cache-control', 'no-store');
        return instanceRegistry.listPublicInstances();
    });

    fastify.post('/admin/api/instances', async (request, reply) => {
        try {
            const instance = await instanceRegistry.createInstance(request.body);
            reply.header('cache-control', 'no-store');
            return reply.code(201).send(instance);
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.patch('/admin/api/instances/:instanceName', async (request, reply) => {
        try {
            const { instanceName } = request.params as { instanceName: string };
            const instance = await instanceRegistry.updateInstance(instanceName, request.body);
            reply.header('cache-control', 'no-store');
            return instance;
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.patch('/admin/api/instances/:instanceName/enabled', async (request, reply) => {
        try {
            const { instanceName } = request.params as { instanceName: string };
            const { enabled } = request.body as { enabled?: unknown };
            const instance = await instanceRegistry.setInstanceEnabled(instanceName, enabled as boolean);
            reply.header('cache-control', 'no-store');
            return instance;
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.delete('/admin/api/instances/:instanceName', async (request, reply) => {
        try {
            const { instanceName } = request.params as { instanceName: string };
            await instanceRegistry.deleteInstance(instanceName);
            return reply.code(204).send();
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    fastify.post('/admin/api/instance-connection/test', async (request, reply) => {
        const startedAt = Date.now();
        const requestId = randomUUID();
        try {
            await createTransientConnectionClient(request.body).testConnection();
            reply.header('cache-control', 'no-store');
            return { status: 'ok', durationMs: Date.now() - startedAt, requestId };
        } catch (error: any) {
            return reply.code(400).send({
                error: 'Connection test failed.',
                detail: error?.message || 'Unknown connection error.',
                errorType: error?.name || 'Error',
                durationMs: Date.now() - startedAt,
                requestId,
            });
        }
    });

    fastify.post('/admin/api/instance-connection/companies', async (request, reply) => {
        const startedAt = Date.now();
        const requestId = randomUUID();
        try {
            const client = createTransientConnectionClient(request.body);
            await client.testConnection();
            const companies = await client.listCompanies();
            reply.header('cache-control', 'no-store');
            return { companies, durationMs: Date.now() - startedAt, requestId };
        } catch (error: any) {
            return reply.code(400).send({
                error: 'Company discovery failed.',
                detail: error?.message || 'Unable to connect to Business Central.',
                errorType: error?.name || 'Error',
                durationMs: Date.now() - startedAt,
                requestId,
            });
        }
    });

    fastify.post('/admin/api/instances/:instanceName/test-connection', async (request, reply) => {
        const { instanceName } = request.params as { instanceName: string };
        const requestId = randomUUID();
        const startedAt = Date.now();
        let target: ReturnType<typeof bcClientFactory.resolveEnabledInstance> | undefined;

        try {
            target = bcClientFactory.resolveEnabledInstance(instanceName);
            await target.client.testConnection();
            await logService.record({
                instanceId: target.instance.id,
                instanceName: target.instance.name,
                companyName: target.instance.technicalCompany,
                tool: 'admin_testInstanceConnection',
                status: 'success',
                durationMs: Date.now() - startedAt,
                requestId,
            }).catch(() => undefined);

            reply.header('cache-control', 'no-store');
            return { status: 'ok', durationMs: Date.now() - startedAt, requestId };
        } catch (error: any) {
            await logService.record({
                instanceId: target?.instance.id,
                instanceName: target?.instance.name || instanceName,
                companyName: target?.instance.technicalCompany,
                tool: 'admin_testInstanceConnection',
                status: 'error',
                durationMs: Date.now() - startedAt,
                requestId,
                errorType: error?.name || 'Error',
                errorMessage: error?.message || 'Connection test failed.',
            }).catch(() => undefined);

            return reply.code(400).send({
                error: 'Connection test failed.',
                detail: error?.message || 'Unknown connection error.',
                errorType: error?.name || 'Error',
                durationMs: Date.now() - startedAt,
                requestId,
            });
        }
    });

    fastify.get('/admin/api/tools', async (_request, reply) => {
        reply.header('cache-control', 'no-store');
        return toolDefinitions;
    });

    fastify.post('/admin/api/tools/call', async (request, reply) => {
        const body = request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return reply.code(400).send({ error: 'Invalid request.' });
        }
        const { name, arguments: args } = body as { name?: unknown; arguments?: unknown };
        if (typeof name !== 'string' || !isRegisteredTool(name) || !args || typeof args !== 'object' || Array.isArray(args)) {
            return reply.code(400).send({ error: 'Invalid request.' });
        }

        const result = await executeTool(name, args as Record<string, unknown>, bcClientFactory, logService);
        reply.header('cache-control', 'no-store');
        return result;
    });

    fastify.post('/admin/api/instances/:instanceName/test-technical-company', async (request, reply) => {
        const { instanceName } = request.params as { instanceName: string };
        const requestId = randomUUID();
        const startedAt = Date.now();
        let target: ReturnType<typeof bcClientFactory.resolveEnabledInstance> | undefined;

        try {
            target = bcClientFactory.resolveEnabledInstance(instanceName);
            await target.client.callAction('JMXQ_ApiInfoService', 'ListExecutionContexts', target.instance.technicalCompany, {});
            await logService.record({
                instanceId: target.instance.id,
                instanceName: target.instance.name,
                companyName: target.instance.technicalCompany,
                tool: 'admin_testTechnicalCompany',
                status: 'success',
                durationMs: Date.now() - startedAt,
                requestId,
            }).catch(() => undefined);

            reply.header('cache-control', 'no-store');
            return { status: 'ok', durationMs: Date.now() - startedAt };
        } catch (error: any) {
            await logService.record({
                instanceId: target?.instance.id,
                instanceName: target?.instance.name || instanceName,
                companyName: target?.instance.technicalCompany,
                tool: 'admin_testTechnicalCompany',
                status: 'error',
                durationMs: Date.now() - startedAt,
                requestId,
                errorType: error?.name || 'Error',
                errorMessage: error?.message || 'Technical company test failed.',
            }).catch(() => undefined);

            return reply.code(400).send({
                error: 'Technical company test failed.',
                detail: error?.message || 'Unknown error.',
                errorType: error?.name || 'Error',
                durationMs: Date.now() - startedAt,
                requestId,
            });
        }
    });

    fastify.get('/admin/api/instances/:instanceName/available-companies', async (request, reply) => {
        const { instanceName } = request.params as { instanceName: string };

        try {
            const target = bcClientFactory.resolveEnabledInstance(instanceName);
            const companies = await target.client.listCompanies();
            reply.header('cache-control', 'no-store');
            return companies;
        } catch (error: any) {
            logger.error({ tool: 'admin_listAvailableCompanies', errorType: error?.name || 'Error' }, 'Admin company discovery failed');
            return reply.code(400).send({
                error: 'Company discovery failed.',
                detail: error?.message || 'Unknown company discovery error.',
                errorType: error?.name || 'Error',
            });
        }
    });


    fastify.post('/admin/api/instances/:instanceName/secrets/:field/reveal', async (request, reply) => {
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

    fastify.delete('/admin/api/logs', async (request, reply) => {
        const { retentionDays } = request.query as Record<string, string | undefined>;
        const parsedRetentionDays = retentionDays === undefined ? undefined : Number(retentionDays);
        if (parsedRetentionDays !== undefined
            && (!Number.isInteger(parsedRetentionDays) || parsedRetentionDays < 0 || parsedRetentionDays > 3650)) {
            return reply.code(400).send({ error: 'Invalid request.' });
        }
        reply.header('cache-control', 'no-store');
        return logService.clear(parsedRetentionDays);
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
interface ActiveSseTransport {
    transport: SSEServerTransport;
    context: McpActivityContext;
}

const activeTransports = new Map<string, ActiveSseTransport>();

const toMcpClientLabel = (value: unknown, fallback: string): string => {
    if (typeof value !== 'string' || !value.trim()) {
        return fallback;
    }

    return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
};

const getMcpRequestMethod = (request: any): string | undefined => {
    const method = request.body?.method;
    return typeof method === 'string' ? method : undefined;
};

const getMcpClientContext = (request: any, fallback?: McpActivityContext): McpActivityContext => {
    const clientInfo = request.body?.params?.clientInfo;
    if (clientInfo && typeof clientInfo.name === 'string') {
        const version = typeof clientInfo.version === 'string' ? ` ${clientInfo.version}` : '';
        return { client: toMcpClientLabel(`${clientInfo.name}${version}`, 'MCP client') };
    }

    const clientId = request.headers['x-mcp-clientid'] ?? request.headers['x-mcp-client-id'];
    if (typeof clientId === 'string' && clientId.trim()) {
        return { client: toMcpClientLabel(clientId, 'MCP client') };
    }

    const userAgent = request.headers['user-agent'];
    if (typeof userAgent === 'string' && /vscode/i.test(userAgent)) {
        return { client: 'VS Code' };
    }
    if (typeof userAgent === 'string' && /copilot/i.test(userAgent)) {
        return { client: 'GitHub Copilot' };
    }
    if (typeof userAgent === 'string' && /inspector/i.test(userAgent)) {
        return { client: 'MCP Inspector' };
    }

    return fallback || { client: toMcpClientLabel(userAgent, request.ip || 'MCP client') };
};

const logMcpProtocolActivity = (method: string | undefined) => {
    if (method === 'initialize') {
        logMcpActivity('connected');
    } else if (method === 'tools/list') {
        logMcpActivity('requested tool catalog');
    }
};

fastify.get('/mcp/sse', async (request, reply) => {
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
        const context = getMcpClientContext(request);

        activeTransports.set(sessionId, { transport, context });
        runWithMcpActivity(context, () => logMcpActivity('SSE connection opened'));

        request.raw.on('close', () => {
            runWithMcpActivity(context, () => logMcpActivity('SSE connection closed'));
            activeTransports.delete(sessionId);
        });

        // Each SSE session gets its own MCP server instance
        const sessionMcpServer = createMcpServer(bcClientFactory, logService);
        await sessionMcpServer.connect(transport);
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
    const activeTransport = sessionId ? activeTransports.get(sessionId) : null;

    if (!activeTransport) {
        logger.warn({ sessionId }, 'POST /mcp/messages: No active transport found for session');
        reply.code(400).send({ error: 'SERVER_NO_ACTIVE_TRANSPORT', sessionId });
        return;
    }

    try {
        const message = request.body as any;
        const context = getMcpClientContext(request, activeTransport.context);
        activeTransport.context = context;
        // Use the SDK's handleMessage for better robustness
        await runWithMcpActivity(context, async () => {
            logMcpProtocolActivity(getMcpRequestMethod(request));
            await activeTransport.transport.handleMessage(message);
        });
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

streamableTransport.onerror = (error) => {
    logger.error('MCP stream transport error');
};

// Determine which Fastify instance hosts the Streamable HTTP routes
const streamablePort = config.MCP_STREAMABLE_PORT;
const streamableFastify = streamablePort
    ? Fastify({
        logger: false,
        connectionTimeout: 0,
        routerOptions: {
            ignoreDuplicateSlashes: true,
            ignoreTrailingSlash: true,
        },
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

const handleStreamableRequest = async (request: any, reply: any) => {
    if (!isValidApiKey(request)) {
        logger.warn('Unauthorized Streamable HTTP attempt');
        reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing API Key' });
        return;
    }

    try {
        // We MUST hijack the reply for the transport to work correctly with streaming
        reply.hijack();
        const context = getMcpClientContext(request);

        // Pass the body if it was already parsed by Fastify (for POST requests)
        // For GET requests, request.body will be undefined which is correct.
        await runWithMcpActivity(context, async () => {
            logMcpProtocolActivity(getMcpRequestMethod(request));
            await streamableTransport.handleRequest(request.raw, reply.raw, request.body);
        });
    } catch (error: any) {
        logger.error('MCP stream request failed');
        if (reply.raw && !reply.raw.writableEnded) {
            if (!reply.raw.headersSent) {
                reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
            }
            reply.raw.end(JSON.stringify({ error: `STREAMABLE_ERROR: ${error.message}` }));
        }
    }
};

// Handle all methods for the streaming endpoint
streamableFastify.all('/mcp/stream', handleStreamableRequest);

// Also support sub-paths (if needed)
streamableFastify.all('/mcp/stream/*', handleStreamableRequest);

// --- Stdio Transport (for AI Agents like Claude Desktop/Cline) ---
const startStdio = async () => {
    // Check if we are in a TTY. If not, we probably want Stdio support.
    // However, it's safer to always try to connect it if it's not a terminal
    // or if the user explicitly wants it. For MCP servers, adding it doesn't hurt.
    try {
        const stdioMcpServer = createMcpServer(bcClientFactory, logService);
        const stdioTransport = new StdioServerTransport();
        await stdioMcpServer.connect(stdioTransport);
        logger.info('MCP Stdio transport ready');
    } catch (err) {
        logger.error({ err }, 'Failed to start Stdio transport');
        WindowsEventLogger.error(`Stdio transport startup failed: ${toSafeEventMessage(err)}`);
    }
};

const start = async () => {
    try {
        if (process.env.JMXQ_STDIO_ONLY?.toLowerCase() === 'true') {
            await startStdio();
            logger.info('MCP Stdio-only transport ready');
            return;
        }

        // Start Stdio transport in parallel
        startStdio();

        // Connect Streamable transport with its own MCP server instance
        const streamableMcpServer = createMcpServer(bcClientFactory, logService);
        await streamableMcpServer.connect(streamableTransport);
        logger.info('MCP Streamable HTTP transport ready');

        // Start HTTP server for SSE (and Streamable HTTP if no separate port)
        await fastify.listen({ port: config.MCP_PORT, host: config.MCP_HOST });
        const displayHost = getDisplayHost(config.MCP_HOST);
        logger.info(`HTTP listener ready | http://${displayHost}:${config.MCP_PORT}`);
        logger.info(`SSE endpoint | http://${displayHost}:${config.MCP_PORT}/mcp/sse`);
        if (config.ADMIN_API_ENABLED) {
            logger.info(`Admin GUI | http://${displayHost}:${config.MCP_PORT}/admin`);
            logger.info(`Admin API | http://${displayHost}:${config.MCP_PORT}/admin/api`);
        }

        // Start separate Streamable HTTP server if configured
        if (streamablePort) {
            await streamableFastify.listen({ port: streamablePort, host: config.MCP_HOST });
        }

        WindowsEventLogger.info('JMX-QUERY MCP Server started successfully');

        const isAuthActive = !!config.JMXQ_MCPAPI_KEY;
    const streamableEndpoint = `http://${displayHost}:${streamablePort || config.MCP_PORT}/mcp/stream`;
        logger.info(`Streamable HTTP endpoint | ${streamableEndpoint}`);
        logger.info(`API key authentication ${isAuthActive ? 'enabled' : 'disabled'}`);
        if (!isAuthActive) {
            logger.warn('MCP access is unsecured');
        }
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
        for (const [sessionId, activeTransport] of activeTransports.entries()) {
            try {
            await activeTransport.transport.close();
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
