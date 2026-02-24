import { Service } from 'node-windows';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse CLI arguments: --instance <label> --env-file <path>
const args = process.argv.slice(2);
const instanceIndex = args.indexOf('--instance');
const envFileIndex = args.indexOf('--env-file');
const instanceLabel = instanceIndex !== -1 ? args[instanceIndex + 1] : 'Server';
const envFilePath = envFileIndex !== -1 ? args[envFileIndex + 1] : null;

const serviceName = `JMX-QUERY MCP - ${instanceLabel}`;

// Build service env: inline ALL variables from the .env file directly so that
// winsw sets them on the process — this is more reliable than relying on
// DOTENV_CONFIG_PATH being forwarded through the winsw → wrapper.js → fork chain.
let serviceEnv = [];
if (envFilePath) {
    const resolvedEnvFile = path.resolve(envFilePath);
    const raw = fs.readFileSync(resolvedEnvFile, 'utf8');
    const parsed = dotenv.parse(raw);
    serviceEnv = Object.entries(parsed).map(([name, value]) => ({ name, value }));
    // Also keep DOTENV_CONFIG_PATH so config.ts can still use dotenv for any vars
    // not covered by the inline entries (e.g. future additions to the .env file).
    serviceEnv.push({ name: 'DOTENV_CONFIG_PATH', value: resolvedEnvFile });
}

console.log(`Installing service: "${serviceName}"${envFilePath ? ` with env-file: ${path.resolve(envFilePath)}` : ''}`);

// Create a new service object
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

// Check if the service is already installed
svc.on('alreadyinstalled', function () {
    console.log('This service is already installed.');
});

// Log any errors
svc.on('error', function (err) {
    console.error('Service Error: ', err);
});

svc.install();
