// Converts CRLF to LF in the compiled server output.
// tsc copies multi-line template literals verbatim, so sources checked out with CRLF on
// Windows produce build files with mixed line endings. build/ is tracked with LF; without
// this step every Windows build would leave it modified in Git and block service:update --pull.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDirectory = path.join(rootDirectory, 'build');
// The node-windows service wrapper lives here and is not build output.
const excludedDirectory = path.join(buildDirectory, 'daemon');

const normalize = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entryPath !== excludedDirectory) normalize(entryPath);
        } else if (entry.name.endsWith('.js')) {
            const contents = fs.readFileSync(entryPath, 'utf8');
            if (contents.includes('\r')) fs.writeFileSync(entryPath, contents.replace(/\r\n?/g, '\n'), 'utf8');
        }
    }
};

normalize(buildDirectory);
