import { Service } from 'node-windows';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serviceName = 'JMX-QUERY MCP Server';

console.log(`Uninstalling service: "${serviceName}"`);

// Create a new service object
const svc = new Service({
    name: serviceName,
    script: path.join(__dirname, '..', 'build', 'index.js')
});

// Listen for the "uninstall" event, which indicates the
// process is available as a service.
svc.on('uninstall', function () {
    console.log('Uninstall complete.');
    console.log('The service exists: ', svc.exists);
});

svc.uninstall();
