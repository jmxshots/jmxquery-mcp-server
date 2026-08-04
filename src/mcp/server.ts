import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { BcClientFactory } from '../instances/clientFactory.js';
import { LogService } from '../logging/logService.js';
import { executeTool, toolDefinitions } from './tools.js';

export const MCP_WORKFLOW_INSTRUCTIONS = `JMX-QUERY workflow:
1. Call jmxq_listInstances before the first Business Central action.
2. Use only entries from enabledTargets. If exactly one target is enabled, use it automatically. If multiple targets are enabled, ask the user which one to use.
    If no target is enabled, tell the user to configure and enable an Instance and Company in the Admin GUI.
3. Send the exact bcInstance and bcCompany values with every Business Central tool call. Do not retain an implicit active target between calls.
4. For unknown tables, call jmxq_searchTables and then jmxq_describeTableFields before composing a script.
5. For unfamiliar or complex JMX-QUERY syntax, call jmxq_getGrammar or jmxq_getExamples before jmxq_executeScript.
6. jmxq_executeScript may contain INSERT, MODIFY, DELETE, or RUN CODEUNIT operations that change Business Central data. Treat it as potentially mutating and clearly communicate that risk.`;

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
            instructions: MCP_WORKFLOW_INSTRUCTIONS,
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
            : { content: result.content, structuredContent: result.structuredContent };
    });

    return mcpServer;
}
