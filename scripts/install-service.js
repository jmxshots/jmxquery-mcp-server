import { Service } from 'node-windows';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a new service object
const svc = new Service({
    name: 'JMX-QUERY MCP Server',
    description: 'JMX-QUERY Model Context Protocol Server for Business Central',
    script: path.join(__dirname, '..', 'build', 'index.js'),
    nodeOptions: [
        '--harmony',
        '--max_old_space_size=4096'
    ]
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
