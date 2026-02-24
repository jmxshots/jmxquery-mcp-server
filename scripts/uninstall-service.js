import { Service } from 'node-windows';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse CLI arguments: --instance <label>
const args = process.argv.slice(2);
const instanceIndex = args.indexOf('--instance');
const instanceLabel = instanceIndex !== -1 ? args[instanceIndex + 1] : 'Server';
const serviceName = `JMX-QUERY MCP - ${instanceLabel}`;

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
