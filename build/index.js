import Fastify from 'fastify';
import cors from '@fastify/cors';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp/server.js';
import { config } from './config.js';
import { pino } from 'pino';
// IMPORTANT: Logs MUST go to stderr when using Stdio transport
const logger = pino({
    level: config.LOG_LEVEL,
}, process.stderr);
const fastify = Fastify({
    logger: false,
    connectionTimeout: 0,
});
await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-MCP-ClientId', 'Authorization'],
});
// Configure the underlying Node server timeouts
fastify.addHook('onReady', () => {
    fastify.server.keepAliveTimeout = 0;
    fastify.server.headersTimeout = 0;
    fastify.server.requestTimeout = 0;
});
// Create the core MCP server instance
const mcpServer = createMcpServer();
// --- Authentication Middleware ---
const isValidApiKey = (request) => {
    const configKey = config.MCP_API_KEY?.trim();
    // If not configured, allow all
    if (!configKey) {
        return true;
    }
    const authHeader = request.headers['authorization'] || request.headers['Authorization'];
    const bearerToken = (typeof authHeader === 'string' && authHeader.startsWith('Bearer '))
        ? authHeader.substring(7).trim()
        : null;
    const queryKey = request.query?.apiKey;
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
const activeTransports = new Map();
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
        const transport = new SSEServerTransport('/mcp/messages', res);
        const sessionId = transport.sessionId;
        activeTransports.set(sessionId, transport);
        logger.info({ sessionId }, 'New SSE Transport created');
        request.raw.on('close', () => {
            logger.info({ sessionId }, 'SSE Connection Closed');
            activeTransports.delete(sessionId);
        });
        await mcpServer.connect(transport);
        logger.info({ sessionId }, 'MCP Server SSE session connected');
    }
    catch (error) {
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
    const sessionId = request.query?.sessionId;
    const transport = sessionId ? activeTransports.get(sessionId) : null;
    if (!transport) {
        logger.warn({ sessionId }, 'POST /mcp/messages: No active transport found for session');
        reply.code(400).send({ error: 'SERVER_NO_ACTIVE_TRANSPORT', sessionId });
        return;
    }
    try {
        const message = request.body;
        // Use the SDK's handleMessage for better robustness
        await transport.handleMessage(message);
        reply.code(202).send('Accepted');
    }
    catch (error) {
        logger.error({ error, sessionId }, 'Error accepting POST message');
        if (!reply.raw.headersSent) {
            reply.code(500).send({ error: `SERVER_POST_ERROR: ${error.message}` });
        }
    }
});
// --- Stdio Transport (for AI Agents like Claude Desktop/Cline) ---
const startStdio = async () => {
    // Check if we are in a TTY. If not, we probably want Stdio support.
    // However, it's safer to always try to connect it if it's not a terminal
    // or if the user explicitly wants it. For MCP servers, adding it doesn't hurt.
    try {
        const stdioTransport = new StdioServerTransport();
        await mcpServer.connect(stdioTransport);
        logger.info('MCP Server Stdio transport connected');
    }
    catch (err) {
        logger.error({ err }, 'Failed to start Stdio transport');
    }
};
const start = async () => {
    try {
        // Start Stdio transport in parallel
        startStdio();
        // Start HTTP server for SSE
        await fastify.listen({ port: config.MCP_PORT, host: config.MCP_HOST });
        logger.info(`JMX-QUERY MCP Server running at http://${config.MCP_HOST}:${config.MCP_PORT}`);
        logger.info(`SSE Endpoint: http://${config.MCP_HOST}:${config.MCP_PORT}/mcp/sse`);
        logger.info({
            securityActive: !!config.MCP_API_KEY,
            keyDefined: config.MCP_API_KEY !== undefined,
            keyLength: config.MCP_API_KEY?.length || 0
        }, 'Authentication status');
    }
    catch (err) {
        logger.error(err);
        process.exit(1);
    }
};
start();
