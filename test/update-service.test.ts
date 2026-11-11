import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArguments, runServiceUpdate } from '../scripts/update-service.js';

const validConfiguration = [
    'JMXQ_MCPAPI_KEY=mcp-key-that-is-long-enough-to-be-secure',
    'ADMIN_API_ENABLED=true',
    'ADMIN_API_KEY=admin-key-that-is-long-enough-to-be-secure',
    'INSTANCE_MASTER_KEY=master-key-that-is-long-enough-to-be-secure',
].join('\n');

const withTemporaryProject = (envContents: string | null, callback: (rootDirectory: string) => void) => {
    const rootDirectory = mkdtempSync(path.join(tmpdir(), 'jmxquery-update-'));
    try {
        if (envContents !== null) writeFileSync(path.join(rootDirectory, '.env'), envContents);
        callback(rootDirectory);
    } finally {
        rmSync(rootDirectory, { recursive: true, force: true });
    }
};

const recordingOptions = (rootDirectory: string, commands: Array<{ command: string; args: string[] }>) => ({
    rootDirectory,
    platform: 'win32',
    nodeExecutable: 'node.exe',
    commandShell: 'cmd.exe',
    elevationCheck: () => true,
    logger: () => {},
    runCommand: (command: string, args: string[]) => {
        commands.push({ command, args });
        return { status: 0 };
    },
});

test('runServiceUpdate installs stale dependencies, builds, and re-applies the service', () => {
    withTemporaryProject(validConfiguration, rootDirectory => {
        const commands: Array<{ command: string; args: string[] }> = [];
        runServiceUpdate({ ...recordingOptions(rootDirectory, commands), dependencyCheck: () => false });

        assert.deepEqual(commands, [
            { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd ci'] },
            { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd --prefix test-client ci'] },
            { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd run build'] },
            { command: 'node.exe', args: [path.join(rootDirectory, 'scripts', 'install-service.js')] },
        ]);
    });
});

test('runServiceUpdate skips matching dependencies', () => {
    withTemporaryProject(validConfiguration, rootDirectory => {
        const commands: Array<{ command: string; args: string[] }> = [];
        runServiceUpdate({ ...recordingOptions(rootDirectory, commands), dependencyCheck: () => true });

        assert.deepEqual(commands.map(({ args }) => args.at(-1)), [
            'npm.cmd run build',
            path.join(rootDirectory, 'scripts', 'install-service.js'),
        ]);
    });
});

test('runServiceUpdate does not restart the service when the build fails', () => {
    withTemporaryProject(validConfiguration, rootDirectory => {
        const commands: Array<{ command: string; args: string[] }> = [];
        assert.throws(() => runServiceUpdate({
            ...recordingOptions(rootDirectory, commands),
            dependencyCheck: () => true,
            runCommand: (command: string, args: string[]) => {
                commands.push({ command, args });
                return { status: 2 };
            },
        }), /run build failed with exit code 2/);
        assert.equal(commands.length, 1);
    });
});

test('runServiceUpdate stops before any command without elevation or a valid .env', () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    withTemporaryProject(validConfiguration, rootDirectory => {
        assert.throws(
            () => runServiceUpdate({ ...recordingOptions(rootDirectory, commands), elevationCheck: () => false }),
            /Administrator rights are required/,
        );
    });
    withTemporaryProject(null, rootDirectory => {
        assert.throws(() => runServiceUpdate(recordingOptions(rootDirectory, commands)), /npm run bootstrap/);
    });
    withTemporaryProject('INSTANCE_MASTER_KEY=short', rootDirectory => {
        assert.throws(() => runServiceUpdate(recordingOptions(rootDirectory, commands)), /\.env is invalid/);
    });
    assert.throws(() => runServiceUpdate({ platform: 'linux' }), /must be run on Windows/);
    assert.equal(commands.length, 0);
});

const fakeGit = (responses: Record<string, string | { status: number; output: string }>) =>
    (_command: string, args: string[]) => {
        const response = responses[args.join(' ')];
        if (response === undefined) throw new Error(`unexpected git ${args.join(' ')}`);
        return typeof response === 'string' ? { status: 0, output: response } : response;
    };

test('runServiceUpdate --pull fast-forwards a clean checkout before building', () => {
    withTemporaryProject(validConfiguration, rootDirectory => {
        const commands: Array<{ command: string; args: string[] }> = [];
        const messages: string[] = [];
        let head = 'aaaaaaa';
        runServiceUpdate({
            ...recordingOptions(rootDirectory, commands),
            pull: true,
            gitExecutable: 'git.exe',
            dependencyCheck: () => true,
            logger: (message: string) => messages.push(message),
            readCommand: (command: string, args: string[]) => args.join(' ') === 'rev-parse --short HEAD'
                ? { status: 0, output: head }
                : fakeGit({ 'rev-parse --is-inside-work-tree': 'true', 'status --porcelain --untracked-files=no': '', 'rev-parse --abbrev-ref HEAD': 'main' })(command, args),
            runCommand: (command: string, args: string[]) => {
                commands.push({ command, args });
                if (command === 'git.exe') head = 'bbbbbbb';
                return { status: 0 };
            },
        });

        assert.deepEqual(commands[0], { command: 'git.exe', args: ['pull', '--ff-only'] });
        assert.equal(commands[1].args.at(-1), 'npm.cmd run build');
        assert.ok(messages.includes('Updated aaaaaaa -> bbbbbbb.'));
    });
});

test('runServiceUpdate --pull refuses local changes and non-Git folders without running commands', () => {
    withTemporaryProject(validConfiguration, rootDirectory => {
        const commands: Array<{ command: string; args: string[] }> = [];
        assert.throws(() => runServiceUpdate({
            ...recordingOptions(rootDirectory, commands),
            pull: true,
            readCommand: fakeGit({
                'rev-parse --is-inside-work-tree': 'true',
                'status --porcelain --untracked-files=no': ' M README.md',
            }),
        }), /Local changes in tracked files prevent --pull[\s\S]*README\.md/);
        assert.throws(() => runServiceUpdate({
            ...recordingOptions(rootDirectory, commands),
            pull: true,
            readCommand: fakeGit({
                'rev-parse --is-inside-work-tree': { status: 128, output: 'fatal: not a git repository' },
            }),
        }), /requires a Git checkout/);
        assert.equal(commands.length, 0);
    });
});

test('runServiceUpdate --pull discards regenerated build output but keeps blocking other changes', () => {
    withTemporaryProject(validConfiguration, rootDirectory => {
        const gitResponses = (status: string) => fakeGit({
            'rev-parse --is-inside-work-tree': 'true',
            'status --porcelain --untracked-files=no': status,
            'rev-parse --abbrev-ref HEAD': 'main',
            'rev-parse --short HEAD': 'aaaaaaa',
        });

        const commands: Array<{ command: string; args: string[] }> = [];
        runServiceUpdate({
            ...recordingOptions(rootDirectory, commands),
            pull: true,
            gitExecutable: 'git.exe',
            dependencyCheck: () => true,
            readCommand: gitResponses(' M THIRD_PARTY_NOTICES.md\n M build/bcClient.js\nM  build/utils/eventLogger.js'),
        });
        assert.deepEqual(commands.slice(0, 2), [
            { command: 'git.exe', args: ['checkout', 'HEAD', '--', 'build/', 'THIRD_PARTY_NOTICES.md'] },
            { command: 'git.exe', args: ['pull', '--ff-only'] },
        ]);

        const blocked: Array<{ command: string; args: string[] }> = [];
        assert.throws(() => runServiceUpdate({
            ...recordingOptions(rootDirectory, blocked),
            pull: true,
            readCommand: gitResponses(' M build/bcClient.js\n M src/bcClient.ts\n M buildnotes.md'),
        }), error => error instanceof Error
            && error.message.includes(' M src/bcClient.ts')
            && error.message.includes(' M buildnotes.md')
            && !error.message.includes('build/bcClient.js'));
        assert.equal(blocked.length, 0);
    });
});

test('parseArguments accepts --pull and --help and rejects unknown options', () => {
    assert.deepEqual(parseArguments([]), { help: false, pull: false });
    assert.deepEqual(parseArguments(['--pull']), { help: false, pull: true });
    assert.deepEqual(parseArguments(['-h']), { help: true, pull: false });
    assert.throws(() => parseArguments(['--force']), /Unknown option: --force/);
});
