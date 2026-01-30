import Fastify from 'fastify';
import cors from '@fastify/cors';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpServer } from './mcp/server.js';
import { config } from './config.js';
import { pino } from 'pino';
const logger = pino({
    level: config.LOG_LEVEL,
});
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
// Store only ONE active transport for simplicity
let activeTransport = null;
fastify.get('/mcp/sse', async (request, reply) => {
    logger.info('New SSE Connection attempt');
    try {
        // Hijack gives us control over the raw response for Fastify 5
        reply.hijack();
        const res = reply.raw;
        // Set CORS. Standard SSE headers will be set by SSEServerTransport.start()
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setTimeout(0);
        const transport = new SSEServerTransport('/mcp/messages', res);
        const server = createMcpServer();
        activeTransport = transport;
        request.raw.on('close', () => {
            logger.info('SSE Connection Closed');
            if (activeTransport === transport)
                activeTransport = null;
        });
        // This calls transport.start() internally which sends headers and the initial endpoint message
        await server.connect(transport);
        logger.info('MCP Server session connected');
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
    // Manually set CORS headers for the POST response
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
        // Since Fastify already parsed the body, we don't use transport.handlePostMessage.
        // We push the parsed message directly to the transport.
        const message = request.body;
        if (activeTransport.onmessage) {
            // Processing async to allow 202 Accepted response immediately
            Promise.resolve(activeTransport.onmessage(message)).catch(err => {
                logger.error({ err, msgId: message.id }, 'Async message processing failed');
            });
        }
        logger.debug({ msgId: message.id }, 'POST message accepted');
        reply.code(202).send('Accepted');
    }
    catch (error) {
        logger.error({ error }, 'Error accepting POST message');
        if (!reply.raw.headersSent) {
            reply.code(500).send({ error: `SERVER_POST_ERROR: ${error.message}` });
        }
    }
});
const start = async () => {
    try {
        await fastify.listen({ port: config.MCP_PORT, host: config.MCP_HOST });
        logger.info(`JMX-QUERY MCP Server running at http://${config.MCP_HOST}:${config.MCP_PORT}`);
        logger.info(`SSE Endpoint: http://${config.MCP_HOST}:${config.MCP_PORT}/mcp/sse?clientId=<id>`);
        logger.info(`Message Endpoint: http://${config.MCP_HOST}:${config.MCP_PORT}/mcp/messages (requires X-MCP-ClientId header)`);
    }
    catch (err) {
        logger.error(err);
        process.exit(1);
    }
};
start();
