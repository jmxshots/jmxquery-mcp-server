import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function test() {
    console.log('Starting test...');
    const url = new URL('http://127.0.0.1:5006/mcp/stream');
    console.log(`Connecting to ${url.toString()}...`);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    try {
        console.log('Calling client.connect...');
        await client.connect(transport);
        console.log('Connected to Streamable HTTP!');
        const tools = await client.listTools();
        console.log('Available tools:', tools.tools.map(t => t.name));
        await client.close();
        console.log('Client closed.');
    } catch (error) {
        console.error('Connection failed:', error);
    }
}

test();
