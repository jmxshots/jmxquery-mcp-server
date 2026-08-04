import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { BcClientFactory } from '../instances/clientFactory.js';
import { config } from '../config.js';
import { LogService } from '../logging/logService.js';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';

const logger = pino({
    level: config.LOG_LEVEL,
});

/**
 * Strips single-line comments (-- or //) from a JMXQuery script.
 * Correcty handles comments outside of single or double quoted strings.
 */
function stripJmxqComments(script: string): string {
    if (!script) return script;

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

const instanceSelectionProperties = {
    bcInstance: { type: 'string', description: 'Configured Business Central instance name.' },
    bcCompany: { type: 'string', description: 'Configured company name within the Business Central instance.' },
};

const createBcToolInputSchema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
    type: 'object',
    properties: {
        ...instanceSelectionProperties,
        ...properties,
    },
    required: ['bcInstance', 'bcCompany', ...required],
});

const bcToolNames = new Set([
    'jmxq_getGrammar',
    'jmxq_getExamples',
    'jmxq_getReadmeApi',
    'jmxq_listExecutionContexts',
    'jmxq_describeExecutionContext',
    'jmxq_describeTableFields',
    'jmxq_searchTables',
    'jmxq_executeScript',
]);

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
            tools: [
                {
                    name: 'jmxq_ping',
                    description: 'A simple connectivity test that returns "pong".',
                    inputSchema: { type: 'object', properties: {} },
                },
                {
                    name: 'jmxq_listInstances',
                    description: 'Lists configured Business Central instances and companies available to this server.',
                    inputSchema: { type: 'object', properties: {} },
                },
                {
                    name: 'jmxq_getGrammar',
                    description: 'Returns the JMX-QUERY grammar (EBNF).',
                    inputSchema: createBcToolInputSchema(),
                },
                {
                    name: 'jmxq_getExamples',
                    description: 'Returns JMX-QUERY script examples.',
                    inputSchema: createBcToolInputSchema(),
                },
                {
                    name: 'jmxq_getReadmeApi',
                    description: 'Returns the API-oriented README for JMX-QUERY.',
                    inputSchema: createBcToolInputSchema(),
                },
                {
                    name: 'jmxq_listExecutionContexts',
                    description: 'Lists all available execution contexts.',
                    inputSchema: createBcToolInputSchema(),
                },
                {
                    name: 'jmxq_describeExecutionContext',
                    description: 'Describes the execution context (tables, permissions).',
                    inputSchema: createBcToolInputSchema({
                        executionContextCode: { type: 'string', description: 'Optional context code. Defaults to the selected Company execution context.' },
                    }),
                },
                {
                    name: 'jmxq_describeTableFields',
                    description: 'Describes fields and primary key of a specific table.',
                    inputSchema: createBcToolInputSchema({
                        executionContextCode: { type: 'string', description: 'Optional context code. Defaults to the selected Company execution context.' },
                        tableRef: { type: 'string', description: 'Table name or #ID (e.g. Customer, #18)' },
                    }, ['tableRef']),
                },
                {
                    name: 'jmxq_searchTables',
                    description: 'Searches tables within an execution context by a search pattern, e.g. *cust*.',
                    inputSchema: createBcToolInputSchema({
                        executionContextCode: { type: 'string', description: 'Optional context code. Defaults to the selected Company execution context.' },
                        searchPattern: { type: 'string', description: 'Table search pattern with wildcards, e.g. *cust*' },
                    }, ['searchPattern']),
                },
                {
                    name: 'jmxq_executeScript',
                    description: 'Executes a single or multi-part JMX-QUERY script.',
                    inputSchema: createBcToolInputSchema({
                        executionContextCode: { type: 'string', description: 'Optional context code. Defaults to the selected Company execution context.' },
                        script: { type: 'string', description: 'The JMX-QUERY script to execute' },
                    }, ['script']),
                },
            ],
        };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name } = request.params;
        const args = (request.params.arguments || {}) as Record<string, unknown>;
        const requestId = randomUUID();
        const startedAt = Date.now();
        const isBcTool = bcToolNames.has(name);
        let target: ReturnType<BcClientFactory['resolve']> | undefined;
        let executionContextCode: string | undefined;

        logger.info({ tool: name, requestId }, 'Tool Call Received');

        try {
            const getRequiredString = (argumentName: string): string => {
                const value = args[argumentName];
                if (typeof value !== 'string' || !value.trim()) {
                    throw new Error(`'${argumentName}' is required.`);
                }
                return value;
            };
            target = isBcTool
                ? clientFactory.resolve(getRequiredString('bcInstance'), getRequiredString('bcCompany'))
                : undefined;
            executionContextCode = typeof args.executionContextCode === 'string' && args.executionContextCode.trim()
                ? args.executionContextCode
                : target?.company.executionContextCode;
            const callBcAction = async (serviceName: string, actionName: string, payload: Record<string, unknown>) => {
                if (!target) {
                    throw new Error('A Business Central instance and company must be selected.');
                }
                return target.client.callAction(serviceName, actionName, target.company.company, payload);
            };

            let result: any;
            switch (name) {
                case 'jmxq_ping':
                    result = { status: 'ok', message: 'pong', timestamp: new Date().toISOString() };
                    break;
                case 'jmxq_listInstances':
                    result = clientFactory.listInstances();
                    break;
                case 'jmxq_getGrammar':
                    result = await callBcAction('JMXQ_ApiInfoService', 'GetGrammar', {});
                    break;
                case 'jmxq_getExamples':
                    result = await callBcAction('JMXQ_ApiInfoService', 'GetExamples', {});
                    break;
                case 'jmxq_getReadmeApi':
                    result = await callBcAction('JMXQ_ApiInfoService', 'GetReadmeApi', {});
                    break;
                case 'jmxq_listExecutionContexts':
                    result = await callBcAction('JMXQ_ApiInfoService', 'ListExecutionContexts', {});
                    break;
                case 'jmxq_describeExecutionContext':
                    result = await callBcAction('JMXQ_ApiInfoService', 'DescribeExecutionContext', { executionContextCode });
                    break;
                case 'jmxq_describeTableFields':
                    result = await callBcAction('JMXQ_ApiInfoService', 'DescribeTableFields', {
                        executionContextCode,
                        tableRef: args.tableRef,
                    });
                    break;
                case 'jmxq_searchTables':
                    result = await callBcAction('JMXQ_ApiInfoService', 'SearchTables', {
                        executionContextCode,
                        searchPattern: args.searchPattern,
                    });
                    break;
                case 'jmxq_executeScript':
                    result = await callBcAction('JMXQ_ApiService', 'ExecuteScript', {
                        executionContextCode,
                        script: stripJmxqComments(args.script as string),
                    });
                    break;
                default:
                    throw new Error(`Tool not found: ${name}`);
            }

            const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            if (isBcTool) {
                try {
                    await logService.record({
                        instanceId: target?.instance.id,
                        instanceName: target?.instance.name,
                        companyId: target?.company.id,
                        companyName: target?.company.name,
                        tool: name,
                        status: 'success',
                        durationMs: Date.now() - startedAt,
                        requestId,
                        executionContextCode,
                        script: name === 'jmxq_executeScript' && typeof args.script === 'string' ? args.script : undefined,
                    });
                } catch {
                    logger.error({ tool: name, requestId }, 'Tool log write failed');
                }
            }
            logger.info({ tool: name, requestId, resultLength: resultText.length, durationMs: Date.now() - startedAt }, 'Tool Call Success');

            return {
                content: [{ type: 'text', text: resultText }]
            };
        } catch (error: any) {
            if (isBcTool) {
                try {
                    await logService.record({
                        instanceId: target?.instance.id,
                        instanceName: target?.instance.name,
                        companyId: target?.company.id,
                        companyName: target?.company.name,
                        tool: name,
                        status: 'error',
                        durationMs: Date.now() - startedAt,
                        requestId,
                        executionContextCode,
                        errorType: error?.name || 'Error',
                        errorMessage: error?.message || 'Tool execution failed.',
                        script: name === 'jmxq_executeScript' && typeof args.script === 'string' ? args.script : undefined,
                    });
                } catch {
                    logger.error({ tool: name, requestId }, 'Tool failure log write failed');
                }
            }
            logger.error({ tool: name, requestId, errorType: error?.name || 'Error' }, 'Tool Call Failed');
            return {
                content: [{ type: 'text', text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });

    return mcpServer;
}
