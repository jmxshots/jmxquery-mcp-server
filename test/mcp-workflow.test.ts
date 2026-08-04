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
    companies: Array<{ name: string; enabled: boolean }>,
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
    companies: companies.map(company => ({
        id: crypto.randomUUID(),
        name: company.name,
        company: company.name,
        executionContextCode: 'DEFAULT',
        enabled: company.enabled,
        createdAt: timestamp,
        updatedAt: timestamp,
    })),
});

test('instance selection exposes only enabled target pairs', () => {
    const instances = [
        createInstance('Production', true, [
            { name: 'Northwind', enabled: true },
            { name: 'Disabled Company', enabled: false },
        ]),
        createInstance('Sandbox', true, [{ name: 'Cronus', enabled: true }]),
        createInstance('Disabled Instance', false, [{ name: 'Hidden', enabled: true }]),
    ];

    const selection = createInstanceSelection(instances);

    assert.deepEqual(selection.enabledTargets, [
        { bcInstance: 'Production', bcCompany: 'Northwind', executionContextCode: 'DEFAULT' },
        { bcInstance: 'Sandbox', bcCompany: 'Cronus', executionContextCode: 'DEFAULT' },
    ]);
    assert.equal(selection.targetCount, 2);
    assert.equal(selection.selectionRequired, true);
    assert.equal(createInstanceSelection([instances[0]]).selectionRequired, false);
    assert.equal(createInstanceSelection([]).selectionRequired, false);
});

test('MCP protocol teaches the workflow and returns structured targets', async () => {
    const instances = [createInstance('Production', true, [{ name: 'Northwind', enabled: true }])];
    const clientFactory = {
        listInstances: () => instances,
        resolve: () => {
            throw new Error('Unexpected target resolution.');
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
        const executeScriptTool = listedTools.tools.find(tool => tool.name === 'jmxq_executeScript');
        assert.equal(listInstancesTool?.annotations?.readOnlyHint, true);
        assert.ok(listInstancesTool?.outputSchema);
        assert.equal(executeScriptTool?.annotations?.readOnlyHint, false);
        assert.equal(executeScriptTool?.annotations?.destructiveHint, true);

        const instanceResult = await client.callTool({ name: 'jmxq_listInstances', arguments: {} });
        assert.deepEqual(instanceResult.structuredContent, {
            instances,
            enabledTargets: [
                { bcInstance: 'Production', bcCompany: 'Northwind', executionContextCode: 'DEFAULT' },
            ],
            targetCount: 1,
            selectionRequired: false,
        });
        assert.equal(JSON.parse((instanceResult.content[0] as { text: string }).text)[0].name, 'Production');

        const missingTargetResult = await client.callTool({ name: 'jmxq_getGrammar', arguments: {} });
        assert.equal(missingTargetResult.isError, true);
        assert.match((missingTargetResult.content[0] as { text: string }).text, /structuredContent\.enabledTargets/);

        const invalidTargetResult = await client.callTool({
            name: 'jmxq_getGrammar',
            arguments: { bcInstance: 'Unknown', bcCompany: 'Unknown' },
        });
        assert.equal(invalidTargetResult.isError, true);
        assert.match((invalidTargetResult.content[0] as { text: string }).text, /use an enabled target exactly/);
    } finally {
        await client.close();
        await server.close();
    }
});