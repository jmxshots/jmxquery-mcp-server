import { randomUUID } from 'node:crypto';
import { logMcpActivity } from './activity.js';
const instanceSelectionProperties = {
    bcInstance: { type: 'string', description: 'Exact enabledInstances[].bcInstance value returned by jmxq_listInstances.' },
};
const createInstanceToolInputSchema = (properties = {}, required = []) => ({
    type: 'object',
    properties: {
        ...instanceSelectionProperties,
        ...properties,
    },
    required: ['bcInstance', ...required],
});
const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
};
const instanceListOutputSchema = {
    type: 'object',
    properties: {
        instances: {
            type: 'array',
            description: 'All configured public instances, including disabled instances and companies.',
            items: { type: 'object', additionalProperties: true },
        },
        enabledInstances: {
            type: 'array',
            description: 'Enabled Business Central instances that may be passed to subsequent tools.',
            items: {
                type: 'object',
                properties: {
                    bcInstance: { type: 'string' },
                },
                required: ['bcInstance'],
                additionalProperties: false,
            },
        },
        instanceCount: { type: 'integer', minimum: 0 },
        selectionRequired: {
            type: 'boolean',
            description: 'True when multiple enabled instances exist and the user must choose one.',
        },
    },
    required: ['instances', 'enabledInstances', 'instanceCount', 'selectionRequired'],
};
export const toolDefinitions = [
    {
        name: 'jmxq_ping',
        description: 'A simple connectivity test that returns "pong".',
        inputSchema: { type: 'object', properties: {} },
        annotations: { ...readOnlyAnnotations, openWorldHint: false },
    },
    {
        name: 'jmxq_listInstances',
        description: 'Call this before the first Business Central action. Returns all configured instances plus enabledInstances containing the exact bcInstance values for subsequent tools. Use the sole enabled instance automatically; when multiple enabled instances exist, ask the user which one to use.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: instanceListOutputSchema,
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_getGrammar',
        description: 'Returns the JMX-QUERY grammar (EBNF) for the selected instance. Use it before composing unfamiliar or complex scripts.',
        inputSchema: createInstanceToolInputSchema(),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_getExamples',
        description: 'Returns JMX-QUERY script examples for the selected instance. Use examples to verify syntax before executing a script.',
        inputSchema: createInstanceToolInputSchema(),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_getReadmeApi',
        description: 'Returns the API-oriented README for the selected instance.',
        inputSchema: createInstanceToolInputSchema(),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_listExecutionContexts',
        description: 'Lists execution contexts available to the selected instance through its configured technical company.',
        inputSchema: createInstanceToolInputSchema(),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_describeExecutionContext',
        description: 'Describes the execution context, including execution companies allowed by Business Central.',
        inputSchema: createInstanceToolInputSchema({
            executionContextCode: { type: 'string', description: 'Execution context code returned by jmxq_listExecutionContexts.' },
        }, ['executionContextCode']),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_describeTableFields',
        description: 'Describes fields and the primary key of a table. For unknown table names, call jmxq_searchTables first and use its exact table reference.',
        inputSchema: createInstanceToolInputSchema({
            executionContextCode: { type: 'string', description: 'Execution context code returned by jmxq_listExecutionContexts.' },
            tableRef: { type: 'string', description: 'Table name or #ID (e.g. Customer, #18)' },
        }, ['executionContextCode', 'tableRef']),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_searchTables',
        description: 'Searches tables within an execution context. Use this before jmxq_describeTableFields when the correct Business Central table name or ID is unknown.',
        inputSchema: createInstanceToolInputSchema({
            executionContextCode: { type: 'string', description: 'Execution context code returned by jmxq_listExecutionContexts.' },
            searchPattern: { type: 'string', description: 'Table search pattern with wildcards, e.g. *cust*' },
        }, ['executionContextCode', 'searchPattern']),
        annotations: readOnlyAnnotations,
    },
    {
        name: 'jmxq_executeScript',
        description: 'Executes a single or multi-part JMX-QUERY script in an execution company allowed by the selected execution context. Scripts may contain read operations or mutating INSERT, MODIFY, DELETE, and RUN CODEUNIT operations. Clearly communicate mutation risk when applicable.',
        inputSchema: createInstanceToolInputSchema({
            executionContextCode: { type: 'string', description: 'Execution context code returned by jmxq_listExecutionContexts.' },
            executionCompany: { type: 'string', description: 'Exact Business Central company allowed by the selected execution context.' },
            script: { type: 'string', description: 'The JMX-QUERY script to execute' },
        }, ['executionContextCode', 'executionCompany', 'script']),
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
];
export function createInstanceSelection(instances) {
    const enabledInstances = instances
        .filter(instance => instance.enabled)
        .map(instance => ({ bcInstance: instance.name }));
    return {
        instances,
        enabledInstances,
        instanceCount: enabledInstances.length,
        selectionRequired: enabledInstances.length > 1,
    };
}
const bcToolNames = new Set(toolDefinitions.slice(2).map(tool => tool.name));
export const isRegisteredTool = (name) => toolDefinitions.some(tool => tool.name === name);
export const isBusinessCentralTool = (name) => bcToolNames.has(name);
export function stripJmxqComments(script) {
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
            if (!inSingleQuote && !inDoubleQuote && ((char === '-' && line[i + 1] === '-') || (char === '/' && line[i + 1] === '/'))) {
                return line.substring(0, i).trimEnd();
            }
        }
        return line;
    });
    return cleanedLines.filter(line => line.trim().length > 0).join('\n');
}
function getAllowedExecutionCompanies(description) {
    if (!description || typeof description !== 'object')
        return [];
    const result = description.result;
    if (!result || typeof result !== 'object')
        return [];
    const companies = result.companies;
    return Array.isArray(companies)
        ? companies.filter((company) => typeof company === 'string' && company.trim().length > 0)
        : [];
}
/** An error reported by the JMX-QUERY extension in an otherwise successful HTTP response. */
export class JmxqError extends Error {
    code;
    constructor(message, code) {
        super(code ? `${message} (${code})` : message);
        this.code = code;
        this.name = 'JmxqError';
    }
}
/** Returns the JMX-QUERY error envelope ({ "error": { code, message } }) of a BC result, if any. */
export function getJmxqError(result) {
    if (!result || typeof result !== 'object')
        return undefined;
    const error = result.error;
    if (!error)
        return undefined;
    if (typeof error === 'string')
        return new JmxqError(error);
    if (typeof error !== 'object')
        return undefined;
    const { message, code } = error;
    return new JmxqError(typeof message === 'string' && message.trim() ? message : 'JMX-QUERY rejected the request.', typeof code === 'string' && code.trim() ? code : undefined);
}
export async function executeTool(name, args, clientFactory, logService) {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const isBcTool = isBusinessCentralTool(name);
    let instanceTarget;
    let executionContextCode;
    let structuredContent;
    try {
        const getRequiredString = (argumentName) => {
            const value = args[argumentName];
            if (typeof value !== 'string' || !value.trim()) {
                throw new Error(`'${argumentName}' is required. Call jmxq_listInstances and use the exact bcInstance value from structuredContent.enabledInstances.`);
            }
            return value;
        };
        if (isBcTool) {
            const bcInstance = getRequiredString('bcInstance');
            try {
                instanceTarget = clientFactory.resolveEnabledInstance(bcInstance);
            }
            catch (error) {
                throw new Error(`${error.message} Call jmxq_listInstances and use an enabled Instance exactly as returned in structuredContent.enabledInstances.`);
            }
        }
        executionContextCode = typeof args.executionContextCode === 'string' && args.executionContextCode.trim() ? args.executionContextCode : undefined;
        const executionCompany = typeof args.executionCompany === 'string' && args.executionCompany.trim() ? args.executionCompany : undefined;
        const resolvedInstance = instanceTarget?.instance;
        const activityTarget = executionCompany ? `${resolvedInstance?.name} / ${executionCompany}` : resolvedInstance?.name;
        const activityPrefix = activityTarget ? `${name} | ${activityTarget}` : name;
        logMcpActivity(`${activityPrefix} | started`);
        const callBcAction = async (serviceName, actionName, payload) => {
            if (!instanceTarget)
                throw new Error('A Business Central instance must be selected.');
            return instanceTarget.client.callAction(serviceName, actionName, instanceTarget.instance.technicalCompany, payload);
        };
        let result;
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
                if (!executionContextCode || !executionCompany) {
                    throw new Error("'executionContextCode' and 'executionCompany' are required for jmxq_executeScript.");
                }
                const contextDescription = await callBcAction('JMXQ_ApiInfoService', 'DescribeExecutionContext', { executionContextCode });
                const contextError = getJmxqError(contextDescription);
                if (contextError)
                    throw contextError;
                const allowedCompanies = getAllowedExecutionCompanies(contextDescription);
                if (!allowedCompanies.includes(executionCompany)) {
                    throw new Error(`Execution Company '${executionCompany}' is not allowed by Execution Context '${executionContextCode}'. Allowed companies: ${allowedCompanies.join(', ') || 'none'}.`);
                }
                result = await instanceTarget.client.callAction('JMXQ_ApiService', 'ExecuteScript', executionCompany, { executionContextCode, script: stripJmxqComments(args.script) });
                break;
            default:
                throw new Error(`Tool not found: ${name}`);
        }
        // JMX-QUERY reports script and validation errors inside an HTTP 200 response.
        // Surface them as tool errors so MCP clients see isError and the audit log records them.
        const jmxqError = isBcTool ? getJmxqError(result) : undefined;
        if (jmxqError)
            throw jmxqError;
        const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const durationMs = Date.now() - startedAt;
        if (isBcTool) {
            try {
                await logService.record({
                    instanceId: resolvedInstance?.id,
                    instanceName: resolvedInstance?.name,
                    companyName: executionCompany || resolvedInstance?.technicalCompany,
                    tool: name,
                    status: 'success',
                    durationMs,
                    requestId,
                    executionContextCode,
                    script: name === 'jmxq_executeScript' && typeof args.script === 'string' ? args.script : undefined,
                });
            }
            catch {
                logMcpActivity(`${activityPrefix} | audit log unavailable`);
            }
        }
        logMcpActivity(`${activityPrefix} | completed in ${durationMs} ms`);
        return { content: [{ type: 'text', text: resultText }], structuredContent, requestId, durationMs, executionContextCode };
    }
    catch (error) {
        const durationMs = Date.now() - startedAt;
        const resolvedInstance = instanceTarget?.instance;
        const executionCompany = typeof args.executionCompany === 'string' && args.executionCompany.trim() ? args.executionCompany : undefined;
        const activityTarget = executionCompany ? `${resolvedInstance?.name} / ${executionCompany}` : resolvedInstance?.name;
        const activityPrefix = activityTarget ? `${name} | ${activityTarget}` : name;
        if (isBcTool) {
            try {
                await logService.record({
                    instanceId: resolvedInstance?.id,
                    instanceName: resolvedInstance?.name,
                    companyName: executionCompany || resolvedInstance?.technicalCompany,
                    tool: name,
                    status: 'error',
                    durationMs,
                    requestId,
                    executionContextCode,
                    errorType: error?.name || 'Error',
                    errorMessage: error?.message || 'Tool execution failed.',
                    script: name === 'jmxq_executeScript' && typeof args.script === 'string' ? args.script : undefined,
                });
            }
            catch {
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
