import { randomUUID } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { BcClientFactory } from '../instances/clientFactory.js';
import type { PublicInstance } from '../instances/model.js';
import { LogService } from '../logging/logService.js';
import { logMcpActivity } from './activity.js';

export type ToolDefinition = Tool;

export interface ToolExecutionResult {
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: true;
    requestId: string;
    durationMs: number;
    executionContextCode?: string;
}

const instanceSelectionProperties = {
    bcInstance: { type: 'string', description: 'Exact enabledTargets[].bcInstance value returned by jmxq_listInstances.' },
    bcCompany: { type: 'string', description: 'Exact enabledTargets[].bcCompany value returned by jmxq_listInstances.' },
};

const createBcToolInputSchema = (properties: Record<string, object> = {}, required: string[] = []): Tool['inputSchema'] => ({
    type: 'object',
    properties: {
        ...instanceSelectionProperties,
        ...properties,
    },
    required: ['bcInstance', 'bcCompany', ...required],
});

const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
};

const instanceListOutputSchema: NonNullable<Tool['outputSchema']> = {
    type: 'object',
    properties: {
        instances: {
            type: 'array',
            description: 'All configured public instances, including disabled instances and companies.',
            items: { type: 'object', additionalProperties: true },
        },
        enabledTargets: {
            type: 'array',
            description: 'Enabled Business Central target pairs that may be passed to subsequent tools.',
            items: {
                type: 'object',
                properties: {
                    bcInstance: { type: 'string' },
                    bcCompany: { type: 'string' },
                    executionContextCode: { type: 'string' },
                },
                required: ['bcInstance', 'bcCompany', 'executionContextCode'],
                additionalProperties: false,
            },
        },
        targetCount: { type: 'integer', minimum: 0 },
        selectionRequired: {
            type: 'boolean',
            description: 'True when multiple enabled targets exist and the user must choose one.',
        },
    },
    required: ['instances', 'enabledTargets', 'targetCount', 'selectionRequired'],
};

export const toolDefinitions: ToolDefinition[] = [
    {
        name: 'jmxq_ping',
        description: 'A simple connectivity test that returns "pong".',
        inputSchema: { type: 'object', properties: {} },
        annotations: { ...readOnlyAnnotations, openWorldHint: false },
    },
    {
        name: 'jmxq_listInstances',
        description: 'Call this before the first Business Central action. Returns all configured instances plus enabledTargets containing the exact bcInstance and bcCompany values for subsequent tools. Use the sole enabled target automatically; when multiple enabled targets exist, ask the user which one to use.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: instanceListOutputSchema,
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_getGrammar',
        description: 'Returns the JMX-QUERY grammar (EBNF) for the selected target. Use it before composing unfamiliar or complex scripts.',
        inputSchema: createBcToolInputSchema(),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_getExamples',
        description: 'Returns JMX-QUERY script examples for the selected target. Use examples to verify syntax before executing a script.',
        inputSchema: createBcToolInputSchema(),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_getReadmeApi',
        description: 'Returns the API-oriented README for JMX-QUERY.',
        inputSchema: createBcToolInputSchema(),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_listExecutionContexts',
        description: 'Lists execution contexts available to the selected instance and Company. This tool does not take an execution context; use a returned code in later calls, or omit it to use the selected Company default.',
        inputSchema: createBcToolInputSchema(),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_describeExecutionContext',
        description: 'Describes the execution context (tables, permissions).',
        inputSchema: createBcToolInputSchema({
            executionContextCode: { type: 'string', description: 'Optional context code. Defaults to the selected Company execution context.' },
        }),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_describeTableFields',
        description: 'Describes fields and the primary key of a table. For unknown table names, call jmxq_searchTables first and use its exact table reference.',
        inputSchema: createBcToolInputSchema({
            executionContextCode: { type: 'string', description: 'Optional context code. Defaults to the selected Company execution context.' },
            tableRef: { type: 'string', description: 'Table name or #ID (e.g. Customer, #18)' },
        }, ['tableRef']),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_searchTables',
        description: 'Searches tables within an execution context. Use this before jmxq_describeTableFields when the correct Business Central table name or ID is unknown.',
        inputSchema: createBcToolInputSchema({
            executionContextCode: { type: 'string', description: 'Optional context code. Defaults to the selected Company execution context.' },
            searchPattern: { type: 'string', description: 'Table search pattern with wildcards, e.g. *cust*' },
        }, ['searchPattern']),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_executeScript',
        description: 'Executes a single or multi-part JMX-QUERY script against the selected target. Scripts may contain read operations or mutating INSERT, MODIFY, DELETE, and RUN CODEUNIT operations. Clearly communicate mutation risk when applicable.',
        inputSchema: createBcToolInputSchema({
            executionContextCode: { type: 'string', description: 'Optional context code. Defaults to the selected Company execution context.' },
            script: { type: 'string', description: 'The JMX-QUERY script to execute' },
        }, ['script']),
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
];

export function createInstanceSelection(instances: PublicInstance[]): Record<string, unknown> {
    const enabledTargets = instances
        .filter(instance => instance.enabled)
        .flatMap(instance => instance.companies
            .filter(company => company.enabled)
            .map(company => ({
                bcInstance: instance.name,
                bcCompany: company.name,
                executionContextCode: company.executionContextCode,
            })));

    return {
        instances,
        enabledTargets,
        targetCount: enabledTargets.length,
        selectionRequired: enabledTargets.length > 1,
    };
}

const bcToolNames = new Set(toolDefinitions.slice(2).map(tool => tool.name));

export const isRegisteredTool = (name: string): boolean => toolDefinitions.some(tool => tool.name === name);

export const isBusinessCentralTool = (name: string): boolean => bcToolNames.has(name);

export function stripJmxqComments(script: string): string {
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
            if (!inSingleQuote && !inDoubleQuote && ((char === '-' && line[i + 1] === '-') || (char === '/' && line[i + 1] === '/'))) {
                return line.substring(0, i).trimEnd();
            }
        }
        return line;
    });

    return cleanedLines.filter(line => line.trim().length > 0).join('\n');
}

export async function executeTool(
    name: string,
    args: Record<string, unknown>,
    clientFactory: BcClientFactory,
    logService: LogService,
): Promise<ToolExecutionResult> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const isBcTool = isBusinessCentralTool(name);
    let target: ReturnType<BcClientFactory['resolve']> | undefined;
    let executionContextCode: string | undefined;
    let structuredContent: Record<string, unknown> | undefined;

    try {
        const getRequiredString = (argumentName: string): string => {
            const value = args[argumentName];
            if (typeof value !== 'string' || !value.trim()) {
                throw new Error(`'${argumentName}' is required. Call jmxq_listInstances and use the exact bcInstance and bcCompany values from structuredContent.enabledTargets.`);
            }
            return value;
        };
        if (isBcTool) {
            const bcInstance = getRequiredString('bcInstance');
            const bcCompany = getRequiredString('bcCompany');
            try {
                target = clientFactory.resolve(bcInstance, bcCompany);
            } catch (error: any) {
                throw new Error(`${error.message} Call jmxq_listInstances and use an enabled target exactly as returned in structuredContent.enabledTargets.`);
            }
        }
        executionContextCode = typeof args.executionContextCode === 'string' && args.executionContextCode.trim()
            ? args.executionContextCode
            : target?.company.executionContextCode;
        const activityTarget = target ? `${target.instance.name} / ${target.company.name}` : undefined;
        const activityPrefix = activityTarget ? `${name} | ${activityTarget}` : name;
        logMcpActivity(`${activityPrefix} | started`);
        const callBcAction = async (serviceName: string, actionName: string, payload: Record<string, unknown>) => {
            if (!target) throw new Error('A Business Central instance and company must be selected.');
            return target.client.callAction(serviceName, actionName, target.company.company, payload);
        };

        let result: unknown;
        switch (name) {
            case 'jmxq_ping':
                result = { status: 'ok', message: 'pong', timestamp: new Date().toISOString() };
                break;
            case 'jmxq_listInstances': {
                const instances = clientFactory.listInstances();
                result = instances;
                structuredContent = createInstanceSelection(instances);
                break;
            }
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
                result = await callBcAction('JMXQ_ApiInfoService', 'DescribeTableFields', { executionContextCode, tableRef: args.tableRef });
                break;
            case 'jmxq_searchTables':
                result = await callBcAction('JMXQ_ApiInfoService', 'SearchTables', { executionContextCode, searchPattern: args.searchPattern });
                break;
            case 'jmxq_executeScript':
                result = await callBcAction('JMXQ_ApiService', 'ExecuteScript', { executionContextCode, script: stripJmxqComments(args.script as string) });
                break;
            default:
                throw new Error(`Tool not found: ${name}`);
        }

        const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const durationMs = Date.now() - startedAt;
        if (isBcTool) {
            try {
                await logService.record({
                    instanceId: target?.instance.id,
                    instanceName: target?.instance.name,
                    companyId: target?.company.id,
                    companyName: target?.company.name,
                    tool: name,
                    status: 'success',
                    durationMs,
                    requestId,
                    executionContextCode,
                    script: name === 'jmxq_executeScript' && typeof args.script === 'string' ? args.script : undefined,
                });
            } catch {
                logMcpActivity(`${activityPrefix} | audit log unavailable`);
            }
        }
        logMcpActivity(`${activityPrefix} | completed in ${durationMs} ms`);
        return { content: [{ type: 'text', text: resultText }], structuredContent, requestId, durationMs, executionContextCode };
    } catch (error: any) {
        const durationMs = Date.now() - startedAt;
        const activityTarget = target ? `${target.instance.name} / ${target.company.name}` : undefined;
        const activityPrefix = activityTarget ? `${name} | ${activityTarget}` : name;
        if (isBcTool) {
            try {
                await logService.record({
                    instanceId: target?.instance.id,
                    instanceName: target?.instance.name,
                    companyId: target?.company.id,
                    companyName: target?.company.name,
                    tool: name,
                    status: 'error',
                    durationMs,
                    requestId,
                    executionContextCode,
                    errorType: error?.name || 'Error',
                    errorMessage: error?.message || 'Tool execution failed.',
                    script: name === 'jmxq_executeScript' && typeof args.script === 'string' ? args.script : undefined,
                });
            } catch {
                logMcpActivity(`${activityPrefix} | audit log unavailable`);
            }
        }
        logMcpActivity(`${activityPrefix} | failed after ${durationMs} ms`);
        return {
            content: [{ type: 'text', text: `Error: ${error.message}` }],
            isError: true,
            requestId,
            durationMs,
            executionContextCode,
        };
    }
}