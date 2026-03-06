import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { bcClient } from '../bcClient.js';
import { config } from '../config.js';
import { pino } from 'pino';
const logger = pino({
    level: config.LOG_LEVEL,
});
/**
 * Strips single-line comments (-- or //) from a JMXQuery script.
 * Correcty handles comments outside of single or double quoted strings.
 */
function stripJmxqComments(script) {
    if (!script)
        return script;
    const lines = script.split(/\r?\n/);
    const cleanedLines = lines.map(line => {
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let escaped = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === "'" && !inDoubleQuote) {
                inSingleQuote = !inSingleQuote;
                continue;
            }
            if (char === '"' && !inSingleQuote) {
                inDoubleQuote = !inDoubleQuote;
                continue;
            }
            if (!inSingleQuote && !inDoubleQuote) {
                // Check for -- or //
                if ((char === '-' && line[i + 1] === '-') || (char === '/' && line[i + 1] === '/')) {
                    return line.substring(0, i).trimEnd();
                }
            }
        }
        return line;
    });
    return cleanedLines.filter(line => line.trim().length > 0).join('\n');
}
export function createMcpServer() {
    const mcpServer = new Server({
        name: 'jmxq-mcp-server',
        version: '1.0.0',
    }, {
        capabilities: {
            tools: {},
        },
    });
    // Register Tools
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: 'jmxq_ping',
                    description: 'A simple connectivity test that returns "pong".',
                    inputSchema: { type: 'object', properties: {} },
                },
                {
                    name: 'jmxq_getGrammar',
                    description: 'Returns the JMX-QUERY grammar (EBNF).',
                    inputSchema: { type: 'object', properties: {} },
                },
                {
                    name: 'jmxq_getExamples',
                    description: 'Returns JMX-QUERY script examples.',
                    inputSchema: { type: 'object', properties: {} },
                },
                {
                    name: 'jmxq_getReadmeApi',
                    description: 'Returns the API-oriented README for JMX-QUERY.',
                    inputSchema: { type: 'object', properties: {} },
                },
                {
                    name: 'jmxq_listExecutionContexts',
                    description: 'Lists all available execution contexts.',
                    inputSchema: { type: 'object', properties: {} },
                },
                {
                    name: 'jmxq_describeExecutionContext',
                    description: 'Describes the execution context (tables, permissions).',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            executionContextCode: { type: 'string', description: 'Context code (e.g. DEFAULT)' },
                        },
                    },
                },
                {
                    name: 'jmxq_describeTableFields',
                    description: 'Describes fields and primary key of a specific table.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            executionContextCode: { type: 'string', description: 'Context code' },
                            tableRef: { type: 'string', description: 'Table name or #ID (e.g. Customer, #18)' },
                        },
                        required: ['tableRef'],
                    },
                },
                {
                    name: 'jmxq_searchTables',
                    description: 'Searches tables within an execution context by a search pattern, e.g. *cust*.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            executionContextCode: { type: 'string', description: 'Context code' },
                            searchPattern: { type: 'string', description: 'Table search pattern with wildcards, e.g. *cust*' },
                        },
                        required: ['searchPattern'],
                    },
                },
                {
                    name: 'jmxq_executeScript',
                    description: 'Executes a single or multi-part JMX-QUERY script.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            executionContextCode: { type: 'string', description: 'Context code' },
                            script: { type: 'string', description: 'The JMX-QUERY script to execute' },
                        },
                        required: ['script'],
                    },
                },
            ],
        };
    });
    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const ctx = args?.executionContextCode || config.JMXQ_EXECUTION_CONTEXT_CODE;
        logger.info({ tool: name, args }, 'Tool Call Received');
        try {
            let result;
            switch (name) {
                case 'jmxq_ping':
                    result = { status: 'ok', message: 'pong', timestamp: new Date().toISOString() };
                    break;
                case 'jmxq_getGrammar':
                    result = await bcClient.callAction('JMXQ_ApiInfoService', 'GetGrammar', {});
                    break;
                case 'jmxq_getExamples':
                    result = await bcClient.callAction('JMXQ_ApiInfoService', 'GetExamples', {});
                    break;
                case 'jmxq_getReadmeApi':
                    result = await bcClient.callAction('JMXQ_ApiInfoService', 'GetReadmeApi', {});
                    break;
                case 'jmxq_listExecutionContexts':
                    result = await bcClient.callAction('JMXQ_ApiInfoService', 'ListExecutionContexts', {});
                    break;
                case 'jmxq_describeExecutionContext':
                    result = await bcClient.callAction('JMXQ_ApiInfoService', 'DescribeExecutionContext', { executionContextCode: ctx });
                    break;
                case 'jmxq_describeTableFields':
                    result = await bcClient.callAction('JMXQ_ApiInfoService', 'DescribeTableFields', {
                        executionContextCode: ctx,
                        tableRef: args?.tableRef
                    });
                    break;
                case 'jmxq_searchTables':
                    result = await bcClient.callAction('JMXQ_ApiInfoService', 'SearchTables', {
                        executionContextCode: ctx,
                        searchPattern: args?.searchPattern
                    });
                    break;
                case 'jmxq_executeScript':
                    result = await bcClient.callAction('JMXQ_ApiService', 'ExecuteScript', {
                        executionContextCode: ctx,
                        script: stripJmxqComments(args?.script)
                    });
                    break;
                default:
                    throw new Error(`Tool not found: ${name}`);
            }
            const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            logger.info({ tool: name, resultLength: resultText.length }, 'Tool Call Success');
            return {
                content: [{ type: 'text', text: resultText }]
            };
        }
        catch (error) {
            logger.error({ err: error, tool: name }, 'Tool Call Failed');
            return {
                content: [{ type: 'text', text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    return mcpServer;
}
