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
// --- SSE Transport (for HTTP/Web Clients) ---
let activeTransport = null;
fastify.get('/mcp/sse', async (request, reply) => {
    logger.info('New SSE Connection attempt');
    try {
        reply.hijack();
        const res = reply.raw;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setTimeout(0);
        const transport = new SSEServerTransport('/mcp/messages', res);
        activeTransport = transport;
        request.raw.on('close', () => {
            logger.info('SSE Connection Closed');
            if (activeTransport === transport)
                activeTransport = null;
        });
        await mcpServer.connect(transport);
        logger.info('MCP Server SSE session connected');
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
    reply.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MCP-ClientId');
    if (request.method === 'OPTIONS') {
        reply.code(204).send();
        return;
    }
    if (!activeTransport) {
        logger.warn('POST /mcp/messages: No active SSE transport');
        reply.code(400).send({ error: 'SERVER_NO_ACTIVE_TRANSPORT' });
        return;
    }
    try {
        const message = request.body;
        if (activeTransport.onmessage) {
            Promise.resolve(activeTransport.onmessage(message)).catch(err => {
                logger.error({ err, msgId: message.id }, 'Async message processing failed');
            });
        }
        reply.code(202).send('Accepted');
    }
    catch (error) {
        logger.error({ error }, 'Error accepting POST message');
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
    }
    catch (err) {
        logger.error(err);
        process.exit(1);
    }
};
start();
