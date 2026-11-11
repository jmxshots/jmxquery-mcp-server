import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BcClientFactory } from '../src/instances/clientFactory.js';
import type { PublicInstance } from '../src/instances/model.js';
import { migrateLegacyInstanceStore } from '../src/instances/registry.js';
import { LogService } from '../src/logging/logService.js';
import type { LogService } from '../src/logging/logService.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createInstanceSelection, executeTool } from '../src/mcp/tools.js';

const timestamp = '2026-08-04T00:00:00.000Z';

const createInstance = (
    name: string,
    enabled: boolean,
    technicalCompany: string,
): PublicInstance => ({
    id: crypto.randomUUID(),
    name,
    description: '',
    enabled,
    timeoutMs: 60000,
    createdAt: timestamp,
    updatedAt: timestamp,
    authType: 'SSO',
    baseUrl: `https://${name.toLowerCase()}.example.test/odata`,
    technicalCompany,
});

test('legacy instance stores receive a disabled placeholder company', () => {
    const legacyStore = {
        version: 1,
        instances: [{
            id: 'f4cff2cb-d9bf-4f2d-9c04-fb42354db7bf',
            name: 'Production',
            description: '',
            enabled: true,
            timeoutMs: 60000,
            createdAt: timestamp,
            updatedAt: timestamp,
            authType: 'SSO',
            baseUrl: 'https://production.example.test/odata',
        }],
    };

    assert.deepEqual(migrateLegacyInstanceStore(legacyStore), {
        ...legacyStore,
        instances: [{
            ...legacyStore.instances[0],
            technicalCompany: 'Not configured',
            enabled: false,
        }],
    });
});

test('locked expired log files do not break audit log queries', async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), 'jmxquery-log-service-'));
    const logService = new LogService(logDirectory, 30, 1000);
    (logService as any).removeExpiredFiles = async () => {
        throw new Error('EPERM: operation not permitted');
    };

    try {
        await logService.record({
            tool: 'jmxq_listInstances',
            status: 'success',
            durationMs: 12,
            requestId: crypto.randomUUID(),
        });

        assert.equal((await logService.query()).length, 1);
    } finally {
        rmSync(logDirectory, { recursive: true, force: true });
    }
});

test('instance selection exposes only enabled instances', () => {
    const instances = [
        createInstance('Production', true, 'Northwind'),
        createInstance('Sandbox', true, 'Cronus'),
        createInstance('Disabled Instance', false, 'Hidden'),
    ];

    const selection = createInstanceSelection(instances);

    assert.deepEqual(selection.enabledInstances, [
        { bcInstance: 'Production' },
        { bcInstance: 'Sandbox' },
    ]);
    assert.equal(selection.instanceCount, 2);
    assert.equal(selection.selectionRequired, true);
    assert.equal(createInstanceSelection([instances[0]]).selectionRequired, false);
    assert.equal(createInstanceSelection([]).selectionRequired, false);
});

test('MCP protocol teaches the workflow and returns structured targets', async () => {
    const instances = [createInstance('Production', true, 'Northwind')];
    let grammarCompany: string | undefined;
    let executedScript = false;
    const clientFactory = {
        listInstances: () => instances,
        resolve: () => {
            throw new Error('Unexpected target resolution.');
        },
        resolveEnabledInstance: (instanceName: string) => {
            if (instanceName !== 'Production') {
                throw new Error(`Instance '${instanceName}' was not found.`);
            }
            return {
                instance: instances[0],
                client: {
                    callAction: async (_serviceName: string, actionName: string, company: string | undefined) => {
                        grammarCompany = company;
                        if (actionName === 'DescribeExecutionContext') {
                            return { result: { companies: ['Allowed'] } };
                        }
                        if (actionName === 'ExecuteScript') {
                            executedScript = true;
                            return { result: [] };
                        }
                        return 'grammar';
                    },
                },
            };
        },
    } as unknown as BcClientFactory;
    const logService = {
        record: async () => undefined,
    } as unknown as LogService;
    const server = createMcpServer(clientFactory, logService);
    const client = new Client({ name: 'mcp-workflow-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
        assert.match(client.getInstructions() || '', /Call jmxq_listInstances/);
        assert.match(client.getInstructions() || '', /ask the user/);

        const listedTools = await client.listTools();
        const listInstancesTool = listedTools.tools.find(tool => tool.name === 'jmxq_listInstances');
        const grammarTool = listedTools.tools.find(tool => tool.name === 'jmxq_getGrammar');
        const executeScriptTool = listedTools.tools.find(tool => tool.name === 'jmxq_executeScript');
        assert.equal(listInstancesTool?.annotations?.readOnlyHint, true);
        assert.ok(listInstancesTool?.outputSchema);
        assert.deepEqual(grammarTool?.inputSchema.required, ['bcInstance']);
        assert.deepEqual(executeScriptTool?.inputSchema.required, ['bcInstance', 'executionContextCode', 'executionCompany', 'script']);
        assert.equal(executeScriptTool?.annotations?.readOnlyHint, false);
        assert.equal(executeScriptTool?.annotations?.destructiveHint, true);

        const instanceResult = await client.callTool({ name: 'jmxq_listInstances', arguments: {} });
        assert.deepEqual(instanceResult.structuredContent, {
            instances,
            enabledInstances: [
                { bcInstance: 'Production' },
            ],
            instanceCount: 1,
            selectionRequired: false,
        });
        assert.equal(JSON.parse((instanceResult.content[0] as { text: string }).text)[0].name, 'Production');

        const missingTargetResult = await client.callTool({ name: 'jmxq_getGrammar', arguments: {} });
        assert.equal(missingTargetResult.isError, true);
        assert.match((missingTargetResult.content[0] as { text: string }).text, /structuredContent\.enabledInstances/);

        const grammarResult = await client.callTool({
            name: 'jmxq_getGrammar',
            arguments: { bcInstance: 'Production' },
        });
        assert.equal(grammarResult.isError, undefined);
        assert.equal(grammarCompany, 'Northwind');

        const blockedExecutionResult = await client.callTool({
            name: 'jmxq_executeScript',
            arguments: {
                bcInstance: 'Production',
                executionContextCode: 'ALL',
                executionCompany: 'Blocked',
                script: 'FROM Item AS i | SELECT COUNT(*) AS ArticleCount',
            },
        });
        assert.equal(blockedExecutionResult.isError, true);
        assert.match((blockedExecutionResult.content[0] as { text: string }).text, /not allowed/);
        assert.equal(executedScript, false);

        const invalidTargetResult = await client.callTool({
            name: 'jmxq_getGrammar',
            arguments: { bcInstance: 'Unknown' },
        });
        assert.equal(invalidTargetResult.isError, true);
        assert.match((invalidTargetResult.content[0] as { text: string }).text, /use an enabled Instance exactly/);
    } finally {
        await client.close();
        await server.close();
    }
});
test('JMX-QUERY error envelopes become MCP tool errors and are audited as errors', async t => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), 'jmxquery-tool-errors-'));
    t.after(() => rmSync(logDirectory, { recursive: true, force: true }));
    const logService = new LogService(logDirectory, 30, 1000);
    const instance = createInstance('Production', true, 'Cronus');
    const responses: Record<string, unknown> = {
        DescribeExecutionContext: { result: { companies: ['Cronus'] } },
        ExecuteScript: { error: { code: 'JMXQ_Error', message: 'FILTER: Expected quoted field name.' } },
        SearchTables: { result: { tables: [] } },
    };
    const clientFactory = {
        listInstances: () => [instance],
        resolveEnabledInstance: () => ({
            instance,
            client: { callAction: async (_service: string, action: string) => responses[action] },
        }),
    } as unknown as BcClientFactory;

    const failed = await executeTool('jmxq_executeScript', {
        bcInstance: 'Production',
        executionContextCode: 'ALL',
        executionCompany: 'Cronus',
        script: 'FROM Customer AS c | FILTER c.Name = \'x\'',
    }, clientFactory, logService);
    assert.equal(failed.isError, true);
    assert.equal(failed.content[0].text, 'Error: FILTER: Expected quoted field name. (JMXQ_Error)');

    const succeeded = await executeTool('jmxq_searchTables', {
        bcInstance: 'Production',
        executionContextCode: 'ALL',
        searchPattern: '*cust*',
    }, clientFactory, logService);
    assert.equal(succeeded.isError, undefined);

    const records = await logService.query();
    const scriptRecord = records.find(record => record.tool === 'jmxq_executeScript');
    assert.equal(scriptRecord?.status, 'error');
    assert.equal(scriptRecord?.errorType, 'JmxqError');
    assert.equal(records.find(record => record.tool === 'jmxq_searchTables')?.status, 'success');
});
