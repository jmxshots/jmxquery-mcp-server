import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { BcClientFactory } from '../instances/clientFactory.js';
import { LogService } from '../logging/logService.js';
import { executeTool, toolDefinitions } from './tools.js';

export function createMcpServer(clientFactory: BcClientFactory, logService: LogService) {
    const mcpServer = new Server(
        {
            name: 'jmxq-mcp-server',
            version: '1.0.0',
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    // Register Tools
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: toolDefinitions,
        };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const result = await executeTool(
            request.params.name,
            (request.params.arguments || {}) as Record<string, unknown>,
            clientFactory,
            logService,
        );
        return result.isError
            ? { content: result.content, isError: true }
            : { content: result.content };
    });

    return mcpServer;
}
