
const BASE_URL = 'http://127.0.0.1:4000';

async function test() {
    console.log('--- Testing SSE ---');
    try {
        const res = await fetch(`${BASE_URL}/mcp/sse`);
        console.log(`SSE No Key: ${res.status} (Expected: 401)`);
    } catch (e: any) { console.log(`SSE No Key Error: ${e.message}`); }

    try {
        const res = await fetch(`${BASE_URL}/mcp/sse`, {
            headers: { 'Authorization': 'Bearer wrong' }
        });
        console.log(`SSE Wrong Key: ${res.status} (Expected: 401)`);
    } catch (e: any) { console.log(`SSE Wrong Key Error: ${e.message}`); }

    try {
        const res = await fetch(`${BASE_URL}/mcp/sse`, {
            headers: { 'Authorization': 'Bearer your-secret-key-123' }
        });
        console.log(`SSE Correct Key: ${res.status} (Expected: 200)`);
    } catch (e: any) {
        console.log(`SSE Correct Key Error: ${e.message}`);
    }

    console.log('\n--- Testing Messages ---');
    try {
        const res = await fetch(`${BASE_URL}/mcp/messages`, { method: 'POST' });
        console.log(`POST No Key: ${res.status} (Expected: 401)`);
    } catch (e: any) { console.log(`POST No Key Error: ${e.message}`); }

    try {
        const res = await fetch(`${BASE_URL}/mcp/messages`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer your-secret-key-123' }
        });
        console.log(`POST Correct Key (but no session): ${res.status} (Expected: 400 or 401)`);
    } catch (e: any) { console.log(`POST Correct Key Error: ${e.message}`); }
}

test();
