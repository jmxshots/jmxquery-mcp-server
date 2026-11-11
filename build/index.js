import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createMcpServer } from './mcp/server.js';
import { config } from './config.js';
import { pino } from 'pino';
import { WindowsEventLogger } from './utils/eventLogger.js';
import { BcClientFactory } from './instances/clientFactory.js';
import { EncryptedInstanceRegistry } from './instances/registry.js';
import { LogService } from './logging/logService.js';
import { configureMcpActivityLogger, logMcpActivity, runWithMcpActivity } from './mcp/activity.js';
import { registerAdminApi } from './admin/routes.js';
import { getBearerToken, secretsEqual } from './utils/secureCompare.js';
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
const instanceRegistry = new EncryptedInstanceRegistry(config.INSTANCE_STORE_PATH, config.INSTANCE_MASTER_KEY);
await instanceRegistry.load();
const bcClientFactory = new BcClientFactory(instanceRegistry);
const logService = new LogService(config.LOG_DIR, config.LOG_RETENTION_DAYS, config.LOG_SCRIPT_MAX_LENGTH);
const toSafeEventMessage = (value, maxLen = 400) => {
    const raw = typeof value === 'string'
        ? value
        : (value && typeof value === 'object' && 'message' in value)
            ? String(value.message || '')
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
const normalizeOriginHeader = (origin) => {
    try {
        return new URL(origin).origin;
    }
    catch {
        return origin.replace(/\/+$/, '');
    }
};
const isCorsOriginAllowed = (origin) => {
    // Requests without Origin (CLI/server-to-server) are allowed.
    if (!origin) {
        return true;
    }
    return allowedCorsOrigins.has(normalizeOriginHeader(origin));
};
const corsOriginHandler = (origin, callback) => {
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
}
catch {
    logger.warn({ adminUiRoot }, 'Admin UI build directory is unavailable');
}
if (adminUiAvailable) {
    await fastify.register(fastifyStatic, {
        root: adminUiRoot,
        prefix: '/admin/',
        wildcard: false,
    });
}
// Node server timeouts. They limit how long a client may take to SEND a request (slowloris
// protection); they do not limit response time, so long Business Central calls and open SSE
// streams are unaffected. Socket inactivity stays disabled (connectionTimeout: 0) for SSE.
const applyServerTimeouts = (server) => {
    server.headersTimeout = 30_000;
    server.requestTimeout = 120_000;
    server.keepAliveTimeout = 65_000;
};
fastify.addHook('onReady', () => applyServerTimeouts(fastify.server));
// NOTE: Each transport needs its OWN MCP server instance.
// Protocol.connect() replaces the internal _transport reference,
// so sharing one instance across transports would break all but the last one.
// --- Authentication Middleware ---
const isValidApiKey = (request) => {
    const configKey = config.JMXQ_MCPAPI_KEY?.trim();
    // If not configured, allow all
    if (!configKey) {
        return true;
    }
    return secretsEqual(getBearerToken(request.headers.authorization), configKey);
};
// MCP spec: servers must validate Origin to prevent DNS rebinding. CORS headers alone
// do not stop the server from processing a request, so disallowed origins get 403.
// Requests without an Origin header (CLI, desktop, and server-side MCP clients) pass.
const rejectDisallowedOrigin = (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || isCorsOriginAllowed(origin)) {
        return false;
    }
    logger.warn({ origin, url: request.url }, 'MCP request from disallowed origin rejected');
    reply.code(403).send({ error: 'Forbidden', message: 'Origin is not allowed' });
    return true;
};
const getDisplayHost = (host) => host === '0.0.0.0' ? '127.0.0.1' : host;
if (config.ADMIN_API_ENABLED) {
    fastify.get('/', async (_request, reply) => reply.redirect('/admin'));
    // Authentication is enforced inside the encapsulated Admin API plugin.
    await registerAdminApi(fastify, {
        adminApiKey: config.ADMIN_API_KEY || '',
        mcpApiKey: config.JMXQ_MCPAPI_KEY,
        streamablePort: config.MCP_STREAMABLE_PORT,
        instanceRegistry,
        bcClientFactory,
        logService,
        logger,
        documentationPath: path.resolve(process.cwd(), 'README.md'),
        overviewPath: path.resolve(process.cwd(), 'docs', 'jmxquery-mcp-overview.html'),
        sessionIdleTimeoutMs: config.ADMIN_SESSION_IDLE_MINUTES * 60_000,
        sessionMaxAgeMs: config.ADMIN_SESSION_MAX_HOURS * 3_600_000,
    });
}
const sendAdminNotFound = (reply) => reply.code(404).type('text/plain; charset=utf-8').send('Admin UI not found.');
if (!adminUiAvailable) {
    fastify.get('/admin', async (_request, reply) => sendAdminNotFound(reply));
}
fastify.get('/admin/*', async (request, reply) => {
    const requestPath = request.params['*'] || '';
    if (requestPath === 'api' || requestPath.startsWith('api/')) {
        return reply.code(404).send({ error: 'Not found.' });
    }
    if (!adminUiAvailable)
        return sendAdminNotFound(reply);
    const candidatePath = path.resolve(adminUiRoot, requestPath);
    const relativePath = path.relative(adminUiRoot, candidatePath);
    if (relativePath && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..') {
        try {
            if ((await stat(candidatePath)).isFile()) {
                return reply.sendFile(requestPath);
            }
        }
        catch {
            // A client-side route should receive the SPA entry point.
        }
    }
    return reply.sendFile('index.html');
});
const activeTransports = new Map();
const toMcpClientLabel = (value, fallback) => {
    if (typeof value !== 'string' || !value.trim()) {
        return fallback;
    }
    return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
};
const getMcpRequestMethod = (request) => {
    const method = request.body?.method;
    return typeof method === 'string' ? method : undefined;
};
const getMcpClientContext = (request, fallback) => {
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
const logMcpProtocolActivity = (method) => {
    if (method === 'initialize') {
        logMcpActivity('connected');
    }
    else if (method === 'tools/list') {
        logMcpActivity('requested tool catalog');
    }
};
fastify.get('/mcp/sse', async (request, reply) => {
    if (rejectDisallowedOrigin(request, reply))
        return;
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
    }
    catch (error) {
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
    if (rejectDisallowedOrigin(request, reply))
        return;
    if (!isValidApiKey(request)) {
        logger.warn('Unauthorized Message attempt');
        reply.code(401)
            .send({ error: 'Unauthorized', message: 'Invalid or missing API Key' });
        return;
    }
    const sessionId = request.query?.sessionId;
    const activeTransport = sessionId ? activeTransports.get(sessionId) : null;
    if (!activeTransport) {
        logger.warn({ sessionId }, 'POST /mcp/messages: No active transport found for session');
        reply.code(400).send({ error: 'SERVER_NO_ACTIVE_TRANSPORT', sessionId });
        return;
    }
    try {
        const message = request.body;
        const context = getMcpClientContext(request, activeTransport.context);
        activeTransport.context = context;
        // Use the SDK's handleMessage for better robustness
        await runWithMcpActivity(context, async () => {
            logMcpProtocolActivity(getMcpRequestMethod(request));
            await activeTransport.transport.handleMessage(message);
        });
        reply.code(202).send('Accepted');
    }
    catch (error) {
        logger.error({ error, sessionId }, 'Error accepting POST message');
        if (!reply.raw.headersSent) {
            reply.code(500).send({ error: `SERVER_POST_ERROR: ${error.message}` });
        }
    }
});
// --- Streamable HTTP Transport (New Protocol) ---
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
    streamableFastify.addHook('onReady', () => applyServerTimeouts(streamableFastify.server));
}
const handleStreamableRequest = async (request, reply) => {
    if (rejectDisallowedOrigin(request, reply))
        return;
    if (!isValidApiKey(request)) {
        logger.warn('Unauthorized Streamable HTTP attempt');
        reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing API Key' });
        return;
    }
    // Stateless transports must not be reused; the SDK rejects a second request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = createMcpServer(bcClientFactory, logService);
    transport.onerror = () => {
        logger.error('MCP stream transport error');
    };
    try {
        // We MUST hijack the reply for the transport to work correctly with streaming
        reply.hijack();
        reply.raw.on('close', () => {
            void transport.close();
            void mcpServer.close();
        });
        const context = getMcpClientContext(request);
        await mcpServer.connect(transport);
        // Pass the body if it was already parsed by Fastify (for POST requests)
        // For GET requests, request.body will be undefined which is correct.
        await runWithMcpActivity(context, async () => {
            logMcpProtocolActivity(getMcpRequestMethod(request));
            await transport.handleRequest(request.raw, reply.raw, request.body);
        });
    }
    catch (error) {
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
// MCP_STDIO=auto starts stdio only when stdin is not a terminal, i.e. when an MCP client
// launched this process and talks over pipes. In a terminal (npm start) stdin is a TTY, and
// the Windows service sets MCP_STDIO=off (see scripts/install-service.js).
const isStdioEnabled = () => {
    if (config.MCP_STDIO === 'on')
        return true;
    if (config.MCP_STDIO === 'off')
        return false;
    return !process.stdin.isTTY;
};
const startStdio = async () => {
    try {
        const stdioMcpServer = createMcpServer(bcClientFactory, logService);
        const stdioTransport = new StdioServerTransport();
        await stdioMcpServer.connect(stdioTransport);
        logger.info('MCP Stdio transport ready');
    }
    catch (err) {
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
        if (isStdioEnabled()) {
            // Start Stdio transport in parallel
            startStdio();
        }
        else {
            logger.info(`MCP Stdio transport disabled (MCP_STDIO=${config.MCP_STDIO})`);
        }
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
    }
    catch (err) {
        logger.error(err);
        WindowsEventLogger.error(`MCP server startup failed: ${toSafeEventMessage(err)}`);
        process.exit(1);
    }
};
start();
// Graceful shutdown handler
const shutdown = async (signal) => {
    logger.info({ signal }, 'Received shutdown signal, closing server...');
    try {
        // Close all active SSE transports
        for (const [sessionId, activeTransport] of activeTransports.entries()) {
            try {
                await activeTransport.transport.close();
                logger.info({ sessionId }, 'SSE Transport closed');
            }
            catch (err) {
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
    }
    catch (err) {
        logger.error({ err }, 'Error during shutdown');
        WindowsEventLogger.error(`MCP server shutdown failed: ${toSafeEventMessage(err)}`);
        process.exit(1);
    }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
