import dotenv from 'dotenv';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || undefined });

const forcePorts = process.argv.slice(2).includes('--force-ports');

const parsePort = (name, fallback) => {
    const value = process.env[name] || fallback;
    if (!value) return undefined;

    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${name} must be a TCP port from 1 to 65535.`);
    }
    return port;
};

const configuredPorts = () => [...new Set([
    parsePort('MCP_PORT', '5000'),
    parsePort('MCP_STREAMABLE_PORT'),
])].filter((port) => port !== undefined);

const stopConfiguredPortListeners = (ports) => {
    if (process.platform !== 'win32') {
        throw new Error('--force-ports is only supported on Windows.');
    }

    const portList = ports.join(',');
    const query = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
            `$connections = Get-NetTCPConnection -State Listen -LocalPort ${portList} -ErrorAction SilentlyContinue; $connections | Select-Object -ExpandProperty OwningProcess -Unique`],
        { encoding: 'utf8' },
    );

    if (query.status !== 0) {
        throw new Error(`Unable to find processes listening on configured ports: ${query.stderr.trim() || 'PowerShell failed.'}`);
    }

    const processIds = query.stdout
        .split(/\r?\n/)
        .map((value) => Number(value.trim()))
        .filter((processId) => Number.isInteger(processId) && processId > 0);

    for (const processId of processIds) {
        const terminated = spawnSync('taskkill.exe', ['/PID', String(processId), '/F'], { encoding: 'utf8' });
        if (terminated.status !== 0) {
            throw new Error(`Unable to stop process ${processId}: ${terminated.stderr.trim() || terminated.stdout.trim()}`);
        }
        console.log(`Stopped process ${processId} listening on a configured MCP port.`);
    }
};

if (forcePorts) {
    stopConfiguredPortListeners(configuredPorts());
}

const server = spawn(process.execPath, ['build/index.js'], { stdio: 'inherit' });
server.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
});
server.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exitCode = code ?? 1;
});