import { Service } from 'node-windows';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serviceName = 'JMX-QUERY MCP Server';

// node-windows' own uninstall runs winsw through elevate.cmd, which returns before the
// command finishes, and it does not stop the service first. Run every step synchronously
// instead: stop, uninstall, wait until Windows has removed the service, then clean up.
const svc = new Service({
    name: serviceName,
    script: path.join(__dirname, '..', 'build', 'index.js')
});
const serviceId = `${svc.id}.exe`;
const wrapperPath = path.join(svc.root, serviceId);

const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
const output = result => result.error?.message ?? `${result.stdout}${result.stderr}`.trim();
const sleep = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
// sc.exe exits with 1060 when the service does not exist.
const serviceExists = () => run('sc.exe', ['query', serviceId]).status !== 1060;

const fail = message => {
    console.error(message);
    process.exitCode = 1;
};

const uninstall = () => {
    if (!serviceExists()) {
        console.log(`Service "${serviceName}" is not installed.`);
        return;
    }
    console.log(`Uninstalling service: "${serviceName}"`);

    const stopped = run('net.exe', ['stop', serviceId]);
    // NET STOP exits with 2 when the service was not running.
    if (stopped.error || (stopped.status !== 0 && stopped.status !== 2)) {
        return fail(`Stopping the service failed: ${output(stopped)}`);
    }

    const removed = fs.existsSync(wrapperPath)
        ? run(wrapperPath, ['uninstall'])
        : run('sc.exe', ['delete', serviceId]);
    if (removed.error || removed.status !== 0) {
        return fail(`Removing the service failed: ${output(removed)}`);
    }

    // Windows deletes the service asynchronously, e.g. while services.msc has it open.
    for (let attempt = 0; attempt < 20 && serviceExists(); attempt++) sleep(500);
    if (serviceExists()) {
        return fail('The service is marked for deletion but still exists. Close services.msc and run the uninstall again, or reboot.');
    }

    // The daemon folder contains only the winsw wrapper, its configuration, and its logs.
    fs.rmSync(svc.root, { recursive: true, force: true });
    console.log('Uninstall complete. .env, data/, and logs/ were kept.');
};

uninstall();
