// Generates THIRD_PARTY_NOTICES.md from the production dependencies of the
// server (package-lock.json) and the bundled Admin GUI (test-client/package-lock.json).
// Run with: npm run notices (also part of npm run build).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(rootDirectory, 'THIRD_PARTY_NOTICES.md');
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

const sources = [
    { title: 'MCP server runtime', directory: rootDirectory },
    { title: 'Admin GUI (bundled into admin-ui/)', directory: path.join(rootDirectory, 'test-client') },
];

// Binaries shipped inside npm packages without their own package.json.
const bundledBinaries = [
    {
        name: 'WinSW (winsw.exe, shipped with node-windows)',
        license: 'MIT',
        repository: 'https://github.com/winsw/winsw',
        text: `MIT License

Copyright (c) Kohsuke Kawaguchi, Sun Microsystems, Inc., CloudBees, Inc., Oleg Nenashev and other contributors

See https://github.com/winsw/winsw/blob/master/LICENSE.txt for the authoritative text.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
    },
    {
        name: 'Sudowin (sudo.exe, shipped with node-windows)',
        licenseFile: path.join(rootDirectory, 'node_modules', 'node-windows', 'bin', 'sudowin', 'LICENSE.txt'),
    },
];

const readJson = filePath => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const normalizeLicense = value => {
    if (!value) return 'UNKNOWN';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(normalizeLicense).join(' OR ');
    return value.type || 'UNKNOWN';
};

const normalizeRepository = value => {
    const url = typeof value === 'string' ? value : value?.url;
    if (!url) return undefined;
    return url
        .replace(/^git\+/, '')
        .replace(/\.git$/, '')
        .replace(/^git:\/\//, 'https://')
        .replace(/^github:/, 'https://github.com/');
};

// Includes every LICENSE/COPYING/NOTICE file; Apache-2.0 requires NOTICE files to be reproduced.
const readLicenseText = packageDirectory => {
    const licenseFiles = fs.readdirSync(packageDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
        .map(entry => entry.name)
        .sort();
    if (licenseFiles.length === 0) return undefined;
    return licenseFiles
        .map(file => {
            const text = fs.readFileSync(path.join(packageDirectory, file), 'utf8').trim();
            return licenseFiles.length > 1 ? `----- ${file} -----\n${text}` : text;
        })
        .join('\n\n');
};

// Uses the installed production tree, so the notices match what this build ships.
const listInstalledProductionDirectories = directory => {
    // Fixed command string (no user input); a shell is needed to resolve npm.cmd on Windows.
    const result = spawnSync('npm ls --omit=dev --all --parseable', {
        cwd: directory,
        encoding: 'utf8',
        shell: true,
        maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    const directories = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (directories.length === 0) {
        throw new Error(`npm ls returned no packages for ${directory}: ${result.stderr}`);
    }
    // The first entry is the project itself.
    return directories.slice(1);
};

const collectProductionPackages = directory => {
    const packages = new Map();

    for (const packageDirectory of listInstalledProductionDirectories(directory)) {
        const manifestPath = path.join(packageDirectory, 'package.json');
        if (!fs.existsSync(manifestPath)) continue; // unmet optional dependency
        const manifest = readJson(manifestPath);
        const key = `${manifest.name}@${manifest.version}`;
        if (packages.has(key)) continue;
        packages.set(key, {
            name: manifest.name,
            version: manifest.version,
            license: normalizeLicense(manifest.license || manifest.licenses),
            repository: normalizeRepository(manifest.repository) || manifest.homepage,
            text: readLicenseText(packageDirectory),
        });
    }

    return [...packages.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
};

const fence = text => {
    const longestBacktickRun = Math.max(2, ...(text.match(/`+/g) || []).map(run => run.length));
    const marker = '`'.repeat(longestBacktickRun + 1);
    return `${marker}text\n${text}\n${marker}`;
};

const renderPackage = item => {
    const lines = [`### ${item.name}${item.version ? ` ${item.version}` : ''}`, ''];
    lines.push(`- License: ${item.license || 'see below'}`);
    if (item.repository) lines.push(`- Source: ${item.repository}`);
    lines.push('');
    lines.push(item.text
        ? fence(item.text)
        : `_No license file is included in the package. The license is declared as ${item.license} in its package.json._`);
    lines.push('');
    return lines.join('\n');
};

const ownLicense = readJson(path.join(rootDirectory, 'package.json'));
const sections = sources.map(source => ({ ...source, packages: collectProductionPackages(source.directory) }));
const binaries = bundledBinaries.map(binary => ({
    ...binary,
    license: binary.license || 'see below',
    text: binary.text || (fs.existsSync(binary.licenseFile) ? fs.readFileSync(binary.licenseFile, 'utf8').trim() : undefined),
}));

const summary = new Map();
for (const item of sections.flatMap(section => section.packages)) {
    summary.set(item.license, (summary.get(item.license) || 0) + 1);
}

const output = [
    '# Third-Party Notices',
    '',
    `${ownLicense.name} is licensed under the ${ownLicense.license} license (see LICENSE), Copyright (c) pro4dynamix GmbH.`,
    'It incorporates or ships the third-party components listed below. Each component is',
    'licensed by its respective authors under the terms reproduced here.',
    '',
    '<!-- Generated by scripts/generate-third-party-notices.js. Do not edit manually. -->',
    '',
    '## License summary',
    '',
    '| License | Packages |',
    '| --- | ---: |',
    ...[...summary.entries()].sort((left, right) => right[1] - left[1]).map(([license, count]) => `| ${license} | ${count} |`),
    '',
    ...sections.flatMap(section => [
        `## ${section.title}`,
        '',
        ...section.packages.map(renderPackage),
    ]),
    '## Bundled binaries',
    '',
    ...binaries.map(renderPackage),
].join('\n');

fs.writeFileSync(outputPath, `${output.trimEnd()}\n`, 'utf8');
console.log(`Wrote ${path.relative(rootDirectory, outputPath)}: ${sections.map(section => `${section.packages.length} ${section.title}`).join(', ')}, ${binaries.length} bundled binaries.`);
