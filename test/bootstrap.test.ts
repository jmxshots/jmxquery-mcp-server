import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    createInitialConfiguration,
    parseArguments,
    provisionConfiguration,
    runBootstrap,
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

test('runBootstrap executes the dependency, build, and service phases in order', () => {
    withTemporaryProject(rootDirectory => {
        writeFileSync(path.join(rootDirectory, '.env'), validConfiguration);
        const commands: Array<{ command: string; args: string[] }> = [];
        const messages: string[] = [];

        runBootstrap({
            rootDirectory,
            platform: 'win32',
            nodeExecutable: 'node.exe',
            commandShell: 'cmd.exe',
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
        assert.match(messages.at(-1)!, /Bootstrap completed/);
    });
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