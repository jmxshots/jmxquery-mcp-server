import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { pino } from 'pino';
import { registerAdminApi, type AdminApiDependencies } from '../src/admin/routes.js';
import { BcClient } from '../src/bcClient.js';
import { BcClientFactory } from '../src/instances/clientFactory.js';
import { EncryptedInstanceRegistry } from '../src/instances/registry.js';
import { LogService } from '../src/logging/logService.js';
import { runPowerShell } from '../src/utils/powershell.js';
import { getBearerToken, secretsEqual } from '../src/utils/secureCompare.js';

const ADMIN_KEY = 'admin-key-for-tests-0123456789';
const MCP_KEY = 'mcp-key-for-tests-0123456789abcdef';
const isWindows = process.platform === 'win32';

const createAdminApp = async (t: test.TestContext, options: Partial<AdminApiDependencies> = {}) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jmxq-admin-security-'));
    const registry = new EncryptedInstanceRegistry(path.join(directory, 'instances.enc'), 'x'.repeat(40));
    await registry.load();
    await registry.createInstance({
        name: 'Production',
        authType: 'BASIC',
        baseUrl: 'https://bc.example.test/ODataV4/',
        username: 'svc',
        password: 'top-secret-password',
        technicalCompany: 'CRONUS',
    });

    // Same router options as the production server, which made the old URL-prefix check bypassable.
    const app = Fastify({ routerOptions: { ignoreDuplicateSlashes: true, ignoreTrailingSlash: true } });
    await registerAdminApi(app, {
        adminApiKey: ADMIN_KEY,
        mcpApiKey: MCP_KEY,
        instanceRegistry: registry,
        bcClientFactory: new BcClientFactory(registry),
        logService: new LogService(path.join(directory, 'logs'), 30, 4000),
        logger: pino({ level: 'silent' }),
        documentationPath: path.join(directory, 'README.md'),
        ...options,
    });
    await app.ready();

    t.after(async () => {
        await app.close();
        rmSync(directory, { recursive: true, force: true });
    });
    return app;
};

const PROTECTED_REQUESTS: Array<{ method: 'GET' | 'POST'; url: string }> = [
    { method: 'GET', url: '/admin/api/instances' },
    { method: 'GET', url: '//admin/api/instances' },
    { method: 'GET', url: '/admin//api/instances' },
    { method: 'GET', url: '/admin/api//instances' },
    { method: 'GET', url: '/admin/api/instances/' },
    { method: 'GET', url: '///admin///api///instances///' },
    { method: 'POST', url: '/admin/api/mcp-connection/api-key/reveal' },
    { method: 'POST', url: '//admin/api/mcp-connection/api-key/reveal' },
    { method: 'POST', url: '/admin//api/mcp-connection/api-key/reveal' },
    { method: 'POST', url: '//admin/api/instances/Production/secrets/password/reveal' },
    { method: 'POST', url: '//admin/api/session' },
];

test('admin API rejects unauthenticated requests for every URL spelling', async t => {
    const app = await createAdminApp(t);

    for (const { method, url } of PROTECTED_REQUESTS) {
        const response = await app.inject({ method, url });
        assert.equal(response.statusCode, 401, `${method} ${url} must require authentication`);
        assert.doesNotMatch(response.body, /top-secret-password|mcp-key-for-tests/, `${method} ${url} leaked a secret`);
    }
});

test('admin API rejects wrong or malformed keys', async t => {
    const app = await createAdminApp(t);
    const headers = [
        `Bearer ${ADMIN_KEY}x`,
        `Bearer ${ADMIN_KEY.slice(0, -1)}`,
        `Bearer ${MCP_KEY}`,
        ADMIN_KEY,
        `Basic ${ADMIN_KEY}`,
        'Bearer ',
    ];

    for (const authorization of headers) {
        const response = await app.inject({ method: 'GET', url: '//admin/api/instances', headers: { authorization } });
        assert.equal(response.statusCode, 401, `authorization "${authorization}" must be rejected`);
    }
});

test('admin API accepts the admin key and session cookies, and logout revokes the session', async t => {
    const app = await createAdminApp(t);
    const authorization = `Bearer ${ADMIN_KEY}`;

    const listed = await app.inject({ method: 'GET', url: '/admin/api/instances', headers: { authorization } });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json()[0].name, 'Production');
    assert.doesNotMatch(listed.body, /top-secret-password/);

    const login = await app.inject({ method: 'POST', url: '/admin/api/session', headers: { authorization } });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    assert.match(cookie, /^jmxquery_admin_session=[0-9a-f-]{36}$/);

    const withSession = await app.inject({ method: 'GET', url: '/admin/api/instances', headers: { cookie } });
    assert.equal(withSession.statusCode, 200);

    const logout = await app.inject({ method: 'POST', url: '/admin/api/session/logout', headers: { cookie } });
    assert.equal(logout.statusCode, 204);

    const afterLogout = await app.inject({ method: 'GET', url: '/admin/api/instances', headers: { cookie } });
    assert.equal(afterLogout.statusCode, 401);

    const forged = await app.inject({
        method: 'GET',
        url: '/admin/api/instances',
        headers: { cookie: 'jmxquery_admin_session=00000000-0000-0000-0000-000000000000' },
    });
    assert.equal(forged.statusCode, 401);
});

test('secretsEqual compares exactly and rejects missing values', () => {
    assert.equal(secretsEqual('abc', 'abc'), true);
    assert.equal(secretsEqual('abc', 'abd'), false);
    assert.equal(secretsEqual('abc', 'abcd'), false);
    assert.equal(secretsEqual('', 'abc'), false);
    assert.equal(secretsEqual(undefined, 'abc'), false);
    assert.equal(secretsEqual('abc', undefined), false);
    assert.equal(secretsEqual('abc', ''), false);
    assert.equal(getBearerToken('Bearer  token '), 'token');
    assert.equal(getBearerToken('Basic token'), undefined);
    assert.equal(getBearerToken(undefined), undefined);
});

// Strings that broke the previous quoting: typographic quotes end single-quoted
// PowerShell strings, and $() / backticks expand inside double-quoted strings.
const createHostileValue = (markerFile: string) => [
    `’); New-Item -ItemType File -Path '${markerFile}' | Out-Null; #`,
    `'; New-Item -ItemType File -Path '${markerFile}' | Out-Null; '`,
    `"; New-Item -ItemType File -Path '${markerFile}' | Out-Null; "`,
    `$(New-Item -ItemType File -Path '${markerFile}')`,
    `“$(New-Item -ItemType File -Path '${markerFile}')”`,
    '`n `$ ‘x’ Grüße 漢字',
].join(' | ');

test('runPowerShell passes hostile input through unchanged without executing it', { skip: !isWindows && 'Windows only' }, async t => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jmxq-ps-security-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const markerFile = path.join(directory, 'injected.txt');
    const value = createHostileValue(markerFile);

    const output = await runPowerShell('Write-Output ([string]$JmxqInput.value)', { input: { value }, timeoutMs: 60000 });

    assert.equal(output, value);
    assert.equal(existsSync(markerFile), false, 'input must never be executed as PowerShell code');
});

test('SSO callAction sends the script body unchanged and never executes it', { skip: !isWindows && 'Windows only' }, async t => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jmxq-sso-security-'));
    const markerFile = path.join(directory, 'injected.txt');
    const received: Array<{ method?: string; url?: string; body: string; requestId?: string }> = [];

    const server = createServer((request: IncomingMessage, response) => {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            received.push({
                method: request.method,
                url: request.url,
                body: Buffer.concat(chunks).toString('utf8'),
                requestId: request.headers['x-request-id'] as string | undefined,
            });
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ value: JSON.stringify({ ok: true, echo: 'Grüße' }) }));
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.close();
        rmSync(directory, { recursive: true, force: true });
    });
    const { port } = server.address() as AddressInfo;

    const client = new BcClient({
        id: crypto.randomUUID(),
        name: 'SSO test',
        description: '',
        enabled: true,
        timeoutMs: 60000,
        technicalCompany: 'CRONUS',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        authType: 'SSO',
        baseUrl: `http://127.0.0.1:${port}/BC/ODataV4/`,
    });
    const payload = { executionContextCode: 'DEFAULT', script: createHostileValue(markerFile) };

    const result = await client.callAction('JMXQ_ApiService', 'ExecuteScript', `Company ’$(x)'"`, payload);

    assert.deepEqual(result, { ok: true, echo: 'Grüße' });
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.deepEqual(JSON.parse(received[0].body), payload);
    assert.match(received[0].requestId || '', /^[0-9a-f-]{36}$/);
    const requestUrl = new URL(received[0].url || '', 'http://localhost');
    assert.equal(requestUrl.pathname, '/BC/ODataV4/JMXQ_ApiService_ExecuteScript');
    assert.equal(requestUrl.searchParams.get('company'), `Company ’$(x)'"`);
    assert.equal(existsSync(markerFile), false, 'script content must never be executed as PowerShell code');
});

test('admin sessions expire after the idle timeout and the maximum age', async t => {
    let clock = 1_000_000;
    const minute = 60_000;
    const app = await createAdminApp(t, { now: () => clock, sessionIdleTimeoutMs: 10 * minute, sessionMaxAgeMs: 60 * minute });
    const login = async () => {
        const response = await app.inject({ method: 'POST', url: '/admin/api/session', headers: { authorization: `Bearer ${ADMIN_KEY}` } });
        assert.match(String(response.headers['set-cookie']), /Max-Age=3600/);
        return String(response.headers['set-cookie']).split(';')[0];
    };
    const status = async (cookie: string) => (await app.inject({ method: 'GET', url: '/admin/api/session', headers: { cookie } })).statusCode;

    // Idle timeout: activity keeps the session alive, inactivity ends it.
    let cookie = await login();
    clock += 9 * minute;
    assert.equal(await status(cookie), 200, 'active within the idle timeout');
    clock += 9 * minute;
    assert.equal(await status(cookie), 200, 'the previous request restarted the idle timer');
    clock += 10 * minute;
    assert.equal(await status(cookie), 401, 'expired after 10 idle minutes');
    assert.equal(await status(cookie), 401, 'stays expired');

    // Maximum age: ends even with continuous activity.
    cookie = await login();
    for (let elapsed = 0; elapsed < 55; elapsed += 5) {
        clock += 5 * minute;
        assert.equal(await status(cookie), 200, `active after ${elapsed + 5} minutes`);
    }
    clock += 5 * minute;
    assert.equal(await status(cookie), 401, 'expired after the maximum age despite activity');

    // The admin key itself is not affected by session expiry.
    assert.equal((await app.inject({ method: 'GET', url: '/admin/api/instances', headers: { authorization: `Bearer ${ADMIN_KEY}` } })).statusCode, 200);
});

test('visual overview requires an admin session and is served with a locked-down CSP', async t => {
    const overviewPath = path.resolve('docs', 'jmxquery-mcp-overview.html');
    const app = await createAdminApp(t, { overviewPath });
    const url = '/admin/api/documentation/overview';

    const anonymous = await app.inject({ method: 'GET', url });
    assert.equal(anonymous.statusCode, 401);
    assert.doesNotMatch(anonymous.body, /<html/i);

    const login = await app.inject({ method: 'POST', url: '/admin/api/session', headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const response = await app.inject({ method: 'GET', url, headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /^text\/html/);
    assert.match(String(response.headers['content-security-policy']), /default-src 'none'/);
    assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.body, /<title>JMX-QUERY MCP Server Guide<\/title>/);
});

test('visual overview returns 404 when the page is not configured or missing', async t => {
    const authorization = `Bearer ${ADMIN_KEY}`;
    const url = '/admin/api/documentation/overview';

    const unset = await createAdminApp(t);
    assert.equal((await unset.inject({ method: 'GET', url, headers: { authorization } })).statusCode, 404);

    const missing = await createAdminApp(t, { overviewPath: path.join(tmpdir(), 'jmxq-missing-overview.html') });
    assert.equal((await missing.inject({ method: 'GET', url, headers: { authorization } })).statusCode, 404);
});
