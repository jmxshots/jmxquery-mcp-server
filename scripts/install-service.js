import { Service } from 'node-windows';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { formatServiceUrls } from './bootstrap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const originalConsoleLog = console.log;
console.log = (...args) => {
    const [message] = args;
    if (args.length === 1 && message?.loc === 'winsw.js ~line 77') return;
    originalConsoleLog(...args);
};

const serviceName = 'JMX-QUERY MCP Server';
// bootstrap and service:update print their own summary and pass --no-summary.
const showSummary = !process.argv.includes('--no-summary');
const envFilePath = path.join(__dirname, '..', '.env');

// Build service env: inline ALL variables from the .env file directly so that
// winsw sets them on the process — this is more reliable than relying on
// DOTENV_CONFIG_PATH being forwarded through the winsw → wrapper.js → fork chain.
const resolvedEnvFile = path.resolve(envFilePath);
if (!fs.existsSync(resolvedEnvFile)) {
    throw new Error(`Service configuration file not found: ${resolvedEnvFile}`);
}
const raw = fs.readFileSync(resolvedEnvFile, 'utf8');
const parsed = dotenv.parse(raw);
// A service has no MCP client on stdin, and its stdin is not a terminal, so MCP_STDIO=auto
// would start stdio. Always disable it; the service only serves the HTTP transports.
const serviceEnv = Object.entries(parsed)
    .filter(([name]) => name !== 'MCP_STDIO')
    .map(([name, value]) => ({ name, value }));
serviceEnv.push({ name: 'DOTENV_CONFIG_PATH', value: resolvedEnvFile });
serviceEnv.push({ name: 'MCP_STDIO', value: 'off' });

console.log(`Installing service: "${serviceName}" with ${resolvedEnvFile}`);

// Create a new service object
const printServiceUrls = () => {
    if (showSummary) formatServiceUrls(raw).forEach(line => console.log(line));
};

const svc = new Service({
    name: serviceName,
    description: 'JMX-QUERY Model Context Protocol Server for Business Central',
    script: path.join(__dirname, '..', 'build', 'index.js'),
    nodeOptions: [
        '--harmony',
        '--max_old_space_size=4096'
    ],
    env: serviceEnv
});

// Listen for the "install" event, which indicates the
// process is available as a service.
svc.on('install', function () {
    console.log('Service installed successfully.');
    svc.start();
});

// node-windows runs NET STOP/START through elevate.cmd, which returns before the command
// finishes. A restart therefore issues NET START while the service is still stopping, and
// the start fails silently. Run both commands synchronously instead and check the result.
const runNet = (action, serviceName) => spawnSync('net.exe', [action, serviceName], {
    encoding: 'utf8',
    windowsHide: true,
});

// Check if the service is already installed
svc.on('alreadyinstalled', function () {
    console.log('Updating the existing service...');
    fs.writeFileSync(path.join(svc.root, `${svc.id}.xml`), svc._xml, 'utf8');

    const serviceName = `${svc.id}.exe`;
    const stopped = runNet('stop', serviceName);
    // NET STOP exits with 2 when the service was not running.
    if (stopped.error || (stopped.status !== 0 && stopped.status !== 2)) {
        console.error(`Stopping the service failed: ${stopped.error?.message ?? stopped.stderr.trim()}`);
        process.exitCode = 1;
        return;
    }
    const started = runNet('start', serviceName);
    if (started.error || started.status !== 0) {
        console.error(`Starting the service failed: ${started.error?.message ?? started.stderr.trim()}`);
        process.exitCode = 1;
        return;
    }
    console.log('Service updated and restarted successfully.');
    printServiceUrls();
});

svc.on('start', function () {
    console.log('Service started successfully.');
    printServiceUrls();
});

// Log any errors
svc.on('error', function (err) {
    console.error('Service Error: ', err);
});

svc.install();
