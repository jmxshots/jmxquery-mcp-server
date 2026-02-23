import Fastify from 'fastify';
import cors from '@fastify/cors';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp/server.js';
import { config } from './config.js';
import { pino } from 'pino';
import { WindowsEventLogger } from './utils/eventLogger.js';

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

const fastify = Fastify({
    logger: false,
    connectionTimeout: 0,
});

await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
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

    const authHeader = request.headers['authorization'] || request.headers['Authorization'];
    const bearerToken = (typeof authHeader === 'string' && authHeader.startsWith('Bearer '))
        ? authHeader.substring(7).trim()
        : null;

    const queryKey = (request.query as any)?.apiKey;
    const trimmedQueryKey = (typeof queryKey === 'string') ? queryKey.trim() : null;

    const providedKey = bearerToken || trimmedQueryKey;
    const isValid = providedKey === configKey;

    logger.info({
        path: request.url,
        hasAuthHeader: !!authHeader,
        hasQueryKey: !!queryKey,
        providedKeyLength: providedKey?.length || 0,
        expectedKeyLength: configKey.length,
        isValid
    }, 'Authentication Validation Detail');

    if (!isValid) {
        logger.warn({
            path: request.url,
            providedKeyType: typeof providedKey
        }, 'API Key Validation Failed');
    }

    return isValid;
};

// --- SSE Transport (for HTTP/Web Clients) ---
const activeTransports = new Map<string, SSEServerTransport>();

fastify.get('/mcp/sse', async (request, reply) => {
    logger.info('New SSE Connection attempt');

    if (!isValidApiKey(request)) {
        logger.warn('Unauthorized SSE Connection attempt');
        reply.code(401)
            .header('Access-Control-Allow-Origin', '*')
            .send({ error: 'Unauthorized', message: 'Invalid or missing API Key' });
        return;
    }

    try {
        reply.hijack();
        const res = reply.raw;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setTimeout(0);

        // The SDK will automatically append ?sessionId=... to this endpoint
        // If an API Key is configured, we append it here so that clients (like MCP Inspector)
        // automatically use it for all subsequent POST requests.
        const configKey = config.MCP_API_KEY?.trim();
        const endpointBase = '/mcp/messages';
        const messageEndpoint = configKey
            ? `${endpointBase}?apiKey=${encodeURIComponent(configKey)}`
            : endpointBase;

        const transport = new SSEServerTransport(messageEndpoint, res);
        const sessionId = transport.sessionId;

        activeTransports.set(sessionId, transport);
        logger.info({ sessionId }, 'New SSE Transport created');

        request.raw.on('close', () => {
            logger.info({ sessionId }, 'SSE Connection Closed');
            activeTransports.delete(sessionId);
        });

        // Each SSE session gets its own MCP server instance
        const sessionMcpServer = createMcpServer();
        await sessionMcpServer.connect(transport);
        logger.info({ sessionId }, 'MCP Server SSE session connected');
    } catch (error: any) {
        logger.error({ error }, 'Error in SSE connection handler');
        if (reply.raw && !reply.raw.writableEnded) {
            if (!reply.raw.headersSent) {
                reply.raw.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
            }
            reply.raw.end(`Server Error: ${error.message}`);
        }
    }
});

fastify.post('/mcp/messages', async (request, reply) => {
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');
    reply.raw.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    reply.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MCP-ClientId, Authorization');

    if (request.method === 'OPTIONS') {
        reply.code(204).send();
        return;
    }

    if (!isValidApiKey(request)) {
        logger.warn('Unauthorized Message attempt');
        reply.code(401)
            .header('Access-Control-Allow-Origin', '*')
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
const streamableFastify = streamablePort ? Fastify({ logger: false, connectionTimeout: 0 }) : fastify;

if (streamablePort) {
    // Separate server needs its own CORS and timeout config
    await streamableFastify.register(cors, {
        origin: true,
        methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
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
        const stdioMcpServer = createMcpServer();
        const stdioTransport = new StdioServerTransport();
        await stdioMcpServer.connect(stdioTransport);
        logger.info('MCP Server Stdio transport connected');
    } catch (err) {
        logger.error({ err }, 'Failed to start Stdio transport');
    }
};

const start = async () => {
    try {
        // Start Stdio transport in parallel
        startStdio();

        // Connect Streamable transport with its own MCP server instance
        const streamableMcpServer = createMcpServer();
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
        process.exit(1);
    }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
