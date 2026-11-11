import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    applyBootstrapSettings,
    createInitialConfiguration,
    enableLanAccess,
    getAdminUrl,
    hasInstalledDependencies,
    maskSecret,
    parseArguments,
    provisionConfiguration,
    runBootstrap,
    secretPlaceholders,
    validateConfiguration,
} from '../scripts/bootstrap.js';

const template = [
    'JMXQ_MCPAPI_KEY=replace_with_a_long_random_mcp_key',
    'ADMIN_API_ENABLED=true',
    'ADMIN_API_KEY=replace_with_a_long_random_admin_key',
    'INSTANCE_MASTER_KEY=replace_with_a_long_random_master_key_at_least_32_characters',
].join('\n');

const validConfiguration = [
    'JMXQ_MCPAPI_KEY=mcp-key-that-is-long-enough-to-be-secure',
    'ADMIN_API_ENABLED=true',
    'ADMIN_API_KEY=admin-key-that-is-long-enough-to-be-secure',
    'INSTANCE_MASTER_KEY=master-key-that-is-long-enough-to-be-secure',
].join('\n');

const withTemporaryProject = (callback: (rootDirectory: string) => void) => {
    const rootDirectory = mkdtempSync(path.join(tmpdir(), 'jmxquery-bootstrap-'));
    try {
        writeFileSync(path.join(rootDirectory, '.env.example'), template);
        callback(rootDirectory);
    } finally {
        rmSync(rootDirectory, { recursive: true, force: true });
    }
};

test('provisionConfiguration creates three distinct secure initial secrets', () => {
    withTemporaryProject(rootDirectory => {
        const generatedValues = [
            'a'.repeat(96),
            'b'.repeat(96),
            'c'.repeat(96),
        ];
        const result = provisionConfiguration(rootDirectory, {
            generateSecret: () => generatedValues.shift()!,
        });
        const contents = readFileSync(path.join(rootDirectory, '.env'), 'utf8');

        assert.equal(result.created, true);
        assert.match(contents, /^JMXQ_MCPAPI_KEY=a{96}$/m);
        assert.match(contents, /^ADMIN_API_KEY=b{96}$/m);
        assert.match(contents, /^INSTANCE_MASTER_KEY=c{96}$/m);
        assert.deepEqual(validateConfiguration(contents), []);
    });
});

test('provisionConfiguration preserves an existing valid configuration', () => {
    withTemporaryProject(rootDirectory => {
        const envPath = path.join(rootDirectory, '.env');
        writeFileSync(envPath, validConfiguration);

        const result = provisionConfiguration(rootDirectory);

        assert.deepEqual(result, { created: false, envPath });
        assert.equal(readFileSync(envPath, 'utf8'), validConfiguration);
    });
});

test('provisionConfiguration rejects invalid existing configuration without changing it', () => {
    withTemporaryProject(rootDirectory => {
        const envPath = path.join(rootDirectory, '.env');
        writeFileSync(envPath, template);

        assert.throws(() => provisionConfiguration(rootDirectory), /Existing \.env is invalid/);
        assert.equal(readFileSync(envPath, 'utf8'), template);
    });
});

test('provisionConfiguration can prepare placeholders before validating an existing file', () => {
    withTemporaryProject(rootDirectory => {
        const envPath = path.join(rootDirectory, '.env');
        writeFileSync(envPath, template);

        provisionConfiguration(rootDirectory, {
            prepareContents: contents => applyBootstrapSettings(
                contents.replace(secretPlaceholders.INSTANCE_MASTER_KEY, 'm'.repeat(96)),
                {
                    adminApiKey: 'generated-admin-key-that-is-at-least-32-characters',
                    mcpApiKey: 'generated-mcp-key-that-is-at-least-32-characters',
                },
            ),
        });

        const contents = readFileSync(envPath, 'utf8');
        assert.match(contents, /^INSTANCE_MASTER_KEY=m{96}$/m);
        assert.deepEqual(validateConfiguration(contents), []);
    });
});

test('runBootstrap executes the dependency, build, and service phases in order', () => {
    withTemporaryProject(rootDirectory => {
        writeFileSync(path.join(rootDirectory, '.env'), validConfiguration);
        const commands: Array<{ command: string; args: string[] }> = [];
        const messages: string[] = [];
        const clipboardWrites: string[] = [];

        runBootstrap({
            rootDirectory,
            platform: 'win32',
            nodeExecutable: 'node.exe',
            clipboard: (text: string) => { clipboardWrites.push(text); return true; },
            commandShell: 'cmd.exe',
            machineHostname: 'jmxquery-host',
            bootstrapSettings: {
                mcpPort: '5100',
                streamablePort: '5101',
                adminApiKey: 'new-admin-key-that-is-long-enough-to-be-secure',
                mcpApiKey: 'new-mcp-key-that-is-long-enough-to-be-secure',
                copyAdminKeyToClipboard: true,
            },
            logger: message => messages.push(message),
            runCommand: (command, args) => {
                commands.push({ command, args });
                return { status: 0 };
            },
        });

        assert.deepEqual(commands, [
            { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd ci'] },
            { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd --prefix test-client ci'] },
            { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd run build'] },
            { command: 'node.exe', args: [path.join(rootDirectory, 'scripts', 'install-service.js')] },
        ]);
        assert.ok(messages.includes('Bootstrap completed.'));
        assert.ok(messages.includes('Admin GUI (local): http://127.0.0.1:5100/admin'));
        assert.ok(messages.includes('Admin GUI (LAN): http://jmxquery-host:5100/admin'));
        assert.ok(messages.some(message => message.includes('Windows Firewall')));
        assert.ok(messages.includes(`Keys and service configuration: ${path.join(rootDirectory, '.env')}`));
        assert.ok(messages.includes('MCP port: 5100'));
        assert.ok(messages.includes('Streamable HTTP port: 5101'));
        // Keys never appear in the console output; the admin key goes to the clipboard on request.
        assert.deepEqual(clipboardWrites, ['new-admin-key-that-is-long-enough-to-be-secure']);
        assert.ok(messages.some(message => message.startsWith('ADMIN_API_KEY ...cure: copied to the clipboard.')));
        assert.ok(messages.some(message => message.startsWith('JMXQ_MCPAPI_KEY ...cure: after login, open Connect')));
        for (const secret of ['new-admin-key-that-is-long-enough-to-be-secure', 'new-mcp-key-that-is-long-enough-to-be-secure']) {
            assert.ok(messages.every(message => !message.includes(secret)), 'a key was written to the console');
        }
        assert.ok(messages.some(message => message.includes('stored encrypted in the Instance Store')));
        assert.ok(messages.every(message => !message.includes('master-key-that-is-long-enough-to-be-secure')));
    });
});

test('applyBootstrapSettings changes ports and API keys but preserves the master key', () => {
    const configured = applyBootstrapSettings(validConfiguration, {
        mcpPort: '6000',
        streamablePort: '6001',
        adminApiKey: 'generate',
        mcpApiKey: 'manual-mcp-key-that-is-at-least-32-characters',
    }, () => 'generated-admin-key-that-is-at-least-32-characters');

    assert.match(configured, /^MCP_PORT=6000$/m);
    assert.match(configured, /^MCP_STREAMABLE_PORT=6001$/m);
    assert.match(configured, /^ADMIN_API_KEY=generated-admin-key-that-is-at-least-32-characters$/m);
    assert.match(configured, /^JMXQ_MCPAPI_KEY=manual-mcp-key-that-is-at-least-32-characters$/m);
    assert.match(configured, /^INSTANCE_MASTER_KEY=master-key-that-is-long-enough-to-be-secure$/m);
    assert.throws(() => applyBootstrapSettings(validConfiguration, { mcpPort: '70000' }), /MCP_PORT/);
    assert.throws(
        () => applyBootstrapSettings(validConfiguration, { mcpPort: '6000', streamablePort: '6000' }),
        /must use different ports/,
    );
    assert.match(
        applyBootstrapSettings(validConfiguration, { adminApiKey: 'admin-key1' }),
        /^ADMIN_API_KEY=admin-key1$/m,
    );
    assert.throws(
        () => applyBootstrapSettings(validConfiguration, { adminApiKey: 'short-key' }),
        /ADMIN_API_KEY must contain at least 10 characters/,
    );
    assert.throws(
        () => applyBootstrapSettings(validConfiguration, { mcpApiKey: 'mcp-key-10' }),
        /JMXQ_MCPAPI_KEY must contain at least 32 characters/,
    );
});

test('getAdminUrl returns a browser-usable URL for configured listener addresses', () => {
    assert.equal(getAdminUrl('MCP_HOST=0.0.0.0\nMCP_PORT=8080'), 'http://127.0.0.1:8080/admin');
    assert.equal(getAdminUrl('MCP_HOST=::1\nMCP_PORT=5000'), 'http://[::1]:5000/admin');
});

test('bootstrap rejects unsupported platforms and unknown arguments', () => {
    assert.throws(() => runBootstrap({ platform: 'linux' }), /must be run on Windows/);
    assert.deepEqual(parseArguments(['--help']), { help: true });
    assert.throws(() => parseArguments(['--unknown']), /Unknown bootstrap option/);
    assert.throws(
        () => createInitialConfiguration('INSTANCE_MASTER_KEY=missing'),
        /missing one or more required secret placeholders/,
    );
});

test('enableLanAccess binds externally and adds the hostname origin once', () => {
    const initial = [
        'MCP_HOST=127.0.0.1',
        'MCP_PORT=5000',
        'MCP_CORS_ORIGINS=http://127.0.0.1:5000,http://localhost:5000',
    ].join('\n');

    const first = enableLanAccess(initial, 'P4D-Python');
    const second = enableLanAccess(first.contents, 'P4D-Python');

    assert.match(first.contents, /^MCP_HOST=0\.0\.0\.0$/m);
    assert.match(first.contents, /http:\/\/P4D-Python:5000/);
    assert.equal(second.contents, first.contents);
    assert.equal(second.changed, false);
});

test('enableLanAccess updates managed origins when the main port changes', () => {
    const result = enableLanAccess([
        'MCP_HOST=0.0.0.0',
        'MCP_PORT=5100',
        'MCP_CORS_ORIGINS=http://127.0.0.1:5000,http://localhost:5000,http://P4D-Python:5000,https://proxy.example',
    ].join('\n'), 'P4D-Python');

    assert.match(result.contents, /MCP_CORS_ORIGINS=https:\/\/proxy\.example,http:\/\/127\.0\.0\.1:5100,http:\/\/localhost:5100,http:\/\/P4D-Python:5100/);
    assert.doesNotMatch(result.contents, /P4D-Python:5000/);
});

test('runBootstrap skips matching dependencies and service installation when requested', () => {
    withTemporaryProject(rootDirectory => {
        writeFileSync(path.join(rootDirectory, '.env'), validConfiguration);
        const commands: Array<{ command: string; args: string[] }> = [];
        const messages: string[] = [];
        const clipboardWrites: string[] = [];

        runBootstrap({
            rootDirectory,
            platform: 'win32',
            commandShell: 'cmd.exe',
            clipboard: (text: string) => { clipboardWrites.push(text); return true; },
            machineHostname: 'jmxquery-host',
            bootstrapSettings: { installWindowsService: false },
            dependencyCheck: () => true,
            logger: message => messages.push(message),
            runCommand: (command, args) => {
                commands.push({ command, args });
                return { status: 0 };
            },
        });

        assert.deepEqual(commands, [
            { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd run build'] },
        ]);
        assert.ok(messages.includes('Server dependencies already match package-lock.json.'));
        assert.ok(messages.includes('Admin GUI dependencies already match package-lock.json.'));
        assert.ok(messages.includes('5/5 Windows service installation skipped.'));
        assert.ok(messages.includes('Start manually: npm start'));
        // Without an explicit opt-in nothing is copied, and the console points to the .env file.
        assert.deepEqual(clipboardWrites, []);
        assert.ok(messages.includes(`ADMIN_API_KEY ...cure: read it from ${path.join(rootDirectory, '.env')} for the Admin GUI login.`));
        assert.ok(messages.every(message => !message.includes('admin-key-that-is-long-enough-to-be-secure')));
    });
});

test('hasInstalledDependencies compares installed packages with the lockfile', () => {
    withTemporaryProject(rootDirectory => {
        const lockfile = {
            lockfileVersion: 3,
            packages: {
                '': { name: 'test-project' },
                'node_modules/example': { version: '1.0.0', integrity: 'sha512-example' },
            },
        };
        mkdirSync(path.join(rootDirectory, 'node_modules'));
        mkdirSync(path.join(rootDirectory, 'node_modules', 'example'));
        writeFileSync(path.join(rootDirectory, 'package-lock.json'), JSON.stringify(lockfile));
        writeFileSync(path.join(rootDirectory, 'node_modules', '.package-lock.json'), JSON.stringify(lockfile));

        assert.equal(hasInstalledDependencies(rootDirectory), true);

        rmSync(path.join(rootDirectory, 'node_modules', 'example'), { recursive: true });
        assert.equal(hasInstalledDependencies(rootDirectory), false);

        mkdirSync(path.join(rootDirectory, 'node_modules', 'example'));
        lockfile.packages['node_modules/example'].version = '2.0.0';
        writeFileSync(path.join(rootDirectory, 'package-lock.json'), JSON.stringify(lockfile));
        assert.equal(hasInstalledDependencies(rootDirectory), false);
    });
});

test('hasInstalledDependencies ignores optional packages skipped for this platform', () => {
    withTemporaryProject(rootDirectory => {
        const example = { version: '1.0.0', integrity: 'sha512-example' };
        const platformPackage = { version: '1.0.0', integrity: 'sha512-darwin', optional: true, os: ['darwin'] };
        mkdirSync(path.join(rootDirectory, 'node_modules', 'example'), { recursive: true });
        writeFileSync(path.join(rootDirectory, 'package-lock.json'), JSON.stringify({
            packages: { 'node_modules/example': example, 'node_modules/@esbuild/darwin-arm64': platformPackage },
        }));
        writeFileSync(path.join(rootDirectory, 'node_modules', '.package-lock.json'), JSON.stringify({
            packages: { 'node_modules/example': example },
        }));
        assert.equal(hasInstalledDependencies(rootDirectory), true);

        // A required package that is missing still counts as outdated.
        writeFileSync(path.join(rootDirectory, 'package-lock.json'), JSON.stringify({
            packages: { 'node_modules/example': example, 'node_modules/required': { version: '1.0.0' } },
        }));
        assert.equal(hasInstalledDependencies(rootDirectory), false);
    });
});
test('maskSecret shows only the last four characters', () => {
    assert.equal(maskSecret('abcdefghijkl'), '...ijkl');
    assert.equal(maskSecret(''), '(not set)');
    assert.equal(maskSecret(undefined), '(not set)');
});

test('runBootstrap falls back to the .env hint when the clipboard is unavailable', () => {
    withTemporaryProject(rootDirectory => {
        writeFileSync(path.join(rootDirectory, '.env'), validConfiguration);
        const messages: string[] = [];
        runBootstrap({
            rootDirectory,
            platform: 'win32',
            commandShell: 'cmd.exe',
            machineHostname: 'jmxquery-host',
            bootstrapSettings: { installWindowsService: false, copyAdminKeyToClipboard: true },
            dependencyCheck: () => true,
            clipboard: () => false,
            logger: message => messages.push(message),
            runCommand: () => ({ status: 0 }),
        });
        assert.ok(messages.some(message => message.startsWith('ADMIN_API_KEY ...cure: read it from ')));
        assert.ok(messages.every(message => !message.includes('admin-key-that-is-long-enough-to-be-secure')));
    });
});
