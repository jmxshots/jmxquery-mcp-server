import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BcClientFactory } from '../src/instances/clientFactory.js';
import type { PublicInstance } from '../src/instances/model.js';
import type { LogService } from '../src/logging/logService.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createInstanceSelection } from '../src/mcp/tools.js';

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