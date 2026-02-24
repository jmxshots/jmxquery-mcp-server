import inquirer from 'inquirer';
import { Service } from 'node-windows';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVICE_PREFIX = 'JMX-QUERY MCP - ';

// Returns true if something is already listening on the given port
function isPortInUse(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
        server.once('listening', () => server.close(() => resolve(false)));
        server.listen(port, '127.0.0.1');
    });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildEnvContent(answers) {
    const lines = [];
    lines.push(`BC_AUTH_TYPE=${answers.BC_AUTH_TYPE}`);

    if (answers.BC_AUTH_TYPE === 'OAUTH') {
        lines.push(`BC_TENANT_ID=${answers.BC_TENANT_ID}`);
        lines.push(`BC_CLIENT_ID=${answers.BC_CLIENT_ID}`);
        lines.push(`BC_CLIENT_SECRET=${answers.BC_CLIENT_SECRET}`);
        lines.push(`BC_ENVIRONMENT=${answers.BC_ENVIRONMENT}`);
    } else {
        lines.push(`BC_ODATA_BASE_URL=${answers.BC_ODATA_BASE_URL}`);
        if (answers.BC_AUTH_TYPE !== 'SSO') {
            lines.push(`BC_USERNAME=${answers.BC_USERNAME}`);
            lines.push(`BC_PASSWORD=${answers.BC_PASSWORD}`);
        }
    }

    lines.push(`BC_COMPANY=${answers.BC_COMPANY}`);
    lines.push('');
    lines.push(`MCP_HOST=${answers.MCP_HOST}`);
    lines.push(`MCP_PORT=${answers.MCP_PORT}`);
    if (answers.MCP_STREAMABLE_PORT) {
        lines.push(`MCP_STREAMABLE_PORT=${answers.MCP_STREAMABLE_PORT}`);
    }
    if (answers.MCP_API_KEY) {
        lines.push(`MCP_API_KEY=${answers.MCP_API_KEY}`);
    }
    lines.push('');
    lines.push(`LOG_LEVEL=${answers.LOG_LEVEL}`);
    lines.push(`HTTP_TIMEOUT_MS=${answers.HTTP_TIMEOUT_MS}`);
    lines.push(`JMXQ_EXECUTION_CONTEXT_CODE=${answers.JMXQ_EXECUTION_CONTEXT_CODE}`);

    return lines.join('\n') + '\n';
}

function installService(serviceName, envFilePath) {
    return new Promise((resolve, reject) => {
        // Inline ALL variables from the .env file directly as service env entries.
        // This is more reliable than relying on DOTENV_CONFIG_PATH being forwarded
        // through the winsw → wrapper.js → fork chain.
        let serviceEnv = [];
        if (envFilePath) {
            const resolvedEnvFile = path.resolve(envFilePath);
            const raw = fs.readFileSync(resolvedEnvFile, 'utf8');
            const parsed = dotenv.parse(raw);
            serviceEnv = Object.entries(parsed).map(([name, value]) => ({ name, value }));
            serviceEnv.push({ name: 'DOTENV_CONFIG_PATH', value: resolvedEnvFile });
        }

        const svc = new Service({
            name: serviceName,
            description: 'JMX-QUERY Model Context Protocol Server for Business Central',
            script: path.join(__dirname, '..', 'build', 'index.js'),
            nodeOptions: ['--harmony', '--max_old_space_size=4096'],
            env: serviceEnv
        });

        svc.on('install', () => {
            console.log(`\n✓ Service "${serviceName}" installed successfully.`);
            svc.start();
            resolve();
        });
        svc.on('alreadyinstalled', () => {
            console.log(`\n⚠  Service "${serviceName}" is already installed.`);
            resolve();
        });
        svc.on('error', (err) => {
            reject(err);
        });

        svc.install();
    });
}

function uninstallService(serviceName) {
    return new Promise((resolve, reject) => {
        const svc = new Service({
            name: serviceName,
            script: path.join(__dirname, '..', 'build', 'index.js'),
        });

        svc.on('uninstall', () => {
            console.log(`✓ Service "${serviceName}" uninstalled.`);
            resolve();
        });
        svc.on('notinstalled', () => {
            console.log(`⚠  Service "${serviceName}" was not found — skipping uninstall.`);
            resolve();
        });
        svc.on('error', (err) => {
            reject(err);
        });

        svc.uninstall();
    });
}

// ── Main ───────────────────────────────────────────────────────────────────

// Option C: clean Ctrl+C handler — no stack trace, no files written
process.on('SIGINT', () => {
    console.log('\n\nSetup aborted — no files written.');
    process.exit(0);
});

console.log('\n══════════════════════════════════════════════');
console.log('   JMX-QUERY MCP Server — Instance Setup');
console.log('══════════════════════════════════════════════\n');

// ── Mode selection ──────────────────────────────────────────────────────────

const { mode } = await inquirer.prompt([
    {
        type: 'list',
        name: 'mode',
        message: 'What would you like to do?  [Create/Edit / Delete / Exit]:',
        choices: [
            { name: 'Create / Edit instance', value: 'create' },
            { name: 'Delete instance (uninstall service + remove .env)', value: 'delete' },
            new inquirer.Separator(),
            { name: '✕  Exit', value: 'exit' },
        ],
        default: 'create'
    }
]);

// Normalize: inquirer may return name text instead of value in some Node.js versions
const normalizedMode = (() => {
    const m = String(mode).toLowerCase();
    if (m === 'create' || m.startsWith('create')) return 'create';
    if (m === 'delete') return 'delete';
    return 'exit';
})();

if (normalizedMode === 'exit') {
    console.log('\nBye.');
    process.exit(0);
}

// ────────────────────────────────────────────────────────────────
// DELETE MODE
// ────────────────────────────────────────────────────────────────

if (normalizedMode === 'delete') {
  try {
    // Discover instances from the instances/ folder
    const instancesDir = path.join(process.cwd(), 'instances');
    const knownInstances = [];
    if (fs.existsSync(instancesDir)) {
        fs.readdirSync(instancesDir)
            .filter(f => f.endsWith('.env'))
            .forEach(f => {
                const label = f.replace(/\.env$/, '');
                const envFile = path.join(instancesDir, f);
                // Read BC_COMPANY for friendlier display
                let company = '';
                try {
                    const parsed = dotenv.parse(fs.readFileSync(envFile, 'utf-8'));
                    if (parsed.BC_COMPANY) company = `  [${parsed.BC_COMPANY}]`;
                } catch { /* ignore */ }
                knownInstances.push({
                    name: `${SERVICE_PREFIX}${label}${company}`,
                    value: envFile   // full path as value — safe, unambiguous
                });
            });
    }

    let deleteLabel, deleteEnvFile;

    if (knownInstances.length > 0) {
        const instanceChoices = [
            ...knownInstances,
            new inquirer.Separator(),
            { name: 'Enter label manually', value: '__MANUAL__' },
        ];
        const { instanceChoice } = await inquirer.prompt([
            {
                type: 'list',
                name: 'instanceChoice',
                message: 'Select instance to delete:',
                choices: instanceChoices,
            }
        ]);
        if (instanceChoice === '__MANUAL__') {
            const manual = await inquirer.prompt([
                { type: 'input', name: 'label', message: 'Instance label:', validate: v => v.trim().length > 0 || 'Required.' },
                { type: 'input', name: 'envFile', message: 'Path to .env file (leave blank to skip file deletion):', default: '' },
            ]);
            deleteLabel = manual.label.trim();
            deleteEnvFile = manual.envFile.trim() || null;
        } else {
            // instanceChoice is the full env file path
            deleteEnvFile = instanceChoice;
            deleteLabel = path.basename(instanceChoice).replace(/\.env$/, '');
        }
    } else {
        if (fs.existsSync(instancesDir)) {
            console.log(`\nNo .env files found in ${instancesDir}.`);
        } else {
            console.log(`\nNo instances folder found at ${instancesDir}.`);
        }
        const manual = await inquirer.prompt([
            { type: 'input', name: 'label', message: 'Instance label:', validate: v => v.trim().length > 0 || 'Required.' },
            { type: 'input', name: 'envFile', message: 'Path to .env file (leave blank to skip file deletion):', default: '' },
        ]);
        deleteLabel = manual.label.trim();
        deleteEnvFile = manual.envFile.trim() || null;
    }

    const deleteServiceName = `${SERVICE_PREFIX}${deleteLabel}`;

    console.log(`\nAbout to delete:`);
    console.log(`  Service : ${deleteServiceName}`);
    if (deleteEnvFile) console.log(`  Env file: ${deleteEnvFile}`);

    const { confirmDelete } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'confirmDelete',
            message: `⚠  This cannot be undone. Proceed?`,
            default: false
        }
    ]);

    if (!confirmDelete) {
        console.log('\nDeletion cancelled.');
        process.exit(0);
    }

    // Uninstall Windows service
    console.log(`\nUninstalling Windows service (requires Administrator privileges)...`);
    try {
        await uninstallService(deleteServiceName);
    } catch (err) {
        console.error(`✗ Service uninstall failed: ${err.message}`);
        console.log(`  You can uninstall manually with:\n  node scripts/uninstall-service.js --instance "${deleteLabel}"`);
    }

    // Delete .env file
    if (deleteEnvFile && fs.existsSync(deleteEnvFile)) {
        const { deleteFile } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'deleteFile',
                message: `Also delete .env file at ${deleteEnvFile}?`,
                default: true
            }
        ]);
        if (deleteFile) {
            fs.unlinkSync(deleteEnvFile);
            console.log(`✓ Deleted: ${deleteEnvFile}`);
        } else {
            console.log(`  Kept: ${deleteEnvFile}`);
        }
    } else if (deleteEnvFile) {
        console.log(`  .env file not found at ${deleteEnvFile} — nothing to delete.`);
    }

    console.log('\nDone.');
    process.exit(0);
  } catch (err) {
    console.error(`\n✗ Delete failed: ${err.message}`);
    process.exit(1);
  }
}

// ────────────────────────────────────────────────────────────────
// SETUP / EDIT MODE
// ────────────────────────────────────────────────────────────────

// Guard: if we reach here with any mode other than 'create', stop immediately.
if (normalizedMode !== 'create') { process.exit(0); }

const phase1 = await inquirer.prompt([
    {
        type: 'input',
        name: 'instanceLabel',
        message: 'Instance label (suffix for service name):',
        default: 'Server',
        validate: (v) => v.trim().length > 0 || 'Label must not be empty.'
    },
    {
        type: 'input',
        name: 'envFilePath',
        message: 'Path for the .env file:',
        default: (a) => {
            const label = a.instanceLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
            return path.join(process.cwd(), 'instances', `${label}.env`);
        }
    }
]);

const { instanceLabel, envFilePath } = phase1;

// ── Option B: Proceed confirm after phase 1 ───────────────────────────────

const existingHint = fs.existsSync(envFilePath)
    ? ` (existing config at ${envFilePath} will be pre-populated)`
    : '';

const { proceed } = await inquirer.prompt([
    {
        type: 'confirm',
        name: 'proceed',
        message: `Proceed with configuration for "JMX-QUERY MCP - ${instanceLabel}"${existingHint}?`,
        default: true
    }
]);

if (!proceed) {
    console.log('\nSetup aborted — no files written.');
    process.exit(0);
}

// ── Load existing config (if any) ─────────────────────────────────────────

let existing = {};
if (fs.existsSync(envFilePath)) {
    try {
        const content = fs.readFileSync(envFilePath, 'utf-8');
        existing = dotenv.parse(content);
        console.log(`\nℹ  Existing configuration found — values are pre-populated.`);
        console.log(`   Press Enter to keep an existing value, or type a new one.\n`);
    } catch {
        console.log(`\n⚠  Could not read existing file at ${envFilePath} — starting fresh.\n`);
    }
}

// Helper: return existing value if present, else fallback
const e = (key, fallback = '') => (existing[key] !== undefined && existing[key] !== '') ? existing[key] : fallback;

// Helper: normalize BC_AUTH_TYPE regardless of whether inquirer returns value or name text
const authType = (a) => {
    const raw = String(a.BC_AUTH_TYPE || '').toUpperCase();
    if (raw.startsWith('OAUTH'))  return 'OAUTH';
    if (raw.startsWith('SSO'))    return 'SSO';
    if (raw.startsWith('NTLM'))   return 'NTLM';
    if (raw.startsWith('BASIC'))  return 'BASIC';
    if (raw.startsWith('__ABORT')) return '__ABORT__';
    return raw;
};

// ── Phase 2: Full configuration ────────────────────────────────────────────

const AUTH_CHOICES = [
    { name: 'OAUTH  — SaaS / BC Online via Azure AD (recommended for cloud)', value: 'OAUTH' },
    { name: 'SSO    — On-Premise, Windows integrated auth (no credentials needed)', value: 'SSO' },
    { name: 'NTLM   — On-Premise, explicit credentials required in .env', value: 'NTLM' },
    { name: 'BASIC  — On-Premise, plain HTTP Basic auth', value: 'BASIC' },
    new inquirer.Separator(),
    { name: '✕  Abort setup', value: '__ABORT__' },
];

const LOG_CHOICES = [
    { name: 'info  — Standard operation logging (recommended)', value: 'info' },
    { name: 'debug — Verbose (all requests/responses)', value: 'debug' },
    { name: 'warn  — Warnings and errors only', value: 'warn' },
    { name: 'error — Errors only', value: 'error' },
];

const config = await inquirer.prompt([
    {
        type: 'list',
        name: 'BC_AUTH_TYPE',
        message: 'Authentication type  [OAUTH / SSO / NTLM / BASIC]:',
        choices: AUTH_CHOICES,
        default: e('BC_AUTH_TYPE', 'OAUTH')
    },
    // Option A: abort chosen in auth list
    {
        type: 'confirm',
        name: '_abortAck',
        message: 'Abort setup — no files will be written. Confirm?',
        when: (a) => authType(a) === '__ABORT__',
        default: true
    },

    // NTLM warning
    {
        type: 'confirm',
        name: 'ntlmWarningAck',
        message:
            '⚠  NTLM erfordert Plaintext-Credentials in der .env-Datei.\n' +
            '   Falls der Service unter einem AD-Account läuft, ist SSO die sicherere Alternative.\n' +
            '   Trotzdem mit NTLM fortfahren?',
        when: (a) => authType(a) === 'NTLM',
        default: false
    },

    // OAUTH-specific fields
    {
        type: 'input',
        name: 'BC_TENANT_ID',
        message: 'Azure AD Tenant ID (GUID):',
        when: (a) => authType(a) === 'OAUTH',
        default: e('BC_TENANT_ID'),
        validate: (v) => v.trim().length > 0 || 'Required.'
    },
    {
        type: 'input',
        name: 'BC_CLIENT_ID',
        message: 'Azure AD Client ID (GUID):',
        when: (a) => authType(a) === 'OAUTH',
        default: e('BC_CLIENT_ID'),
        validate: (v) => v.trim().length > 0 || 'Required.'
    },
    {
        type: 'password',
        name: 'BC_CLIENT_SECRET',
        message: existing.BC_CLIENT_SECRET
            ? 'Azure AD Client Secret (press Enter to keep existing):'
            : 'Azure AD Client Secret:',
        when: (a) => authType(a) === 'OAUTH',
        mask: '*',
        default: e('BC_CLIENT_SECRET'),
        validate: (v) => v.trim().length > 0 || 'Required.'
    },
    {
        type: 'input',
        name: 'BC_ENVIRONMENT',
        message: 'BC Environment name:',
        when: (a) => authType(a) === 'OAUTH',
        default: e('BC_ENVIRONMENT', 'Production')
    },

    // On-Premise URL (BASIC / NTLM / SSO)
    {
        type: 'input',
        name: 'BC_ODATA_BASE_URL',
        message: 'BC OData base URL (e.g. http://bc-server:7048/BC220/ODataV4/):',
        when: (a) => authType(a) !== 'OAUTH',
        default: e('BC_ODATA_BASE_URL'),
        validate: (v) => {
            try { new URL(v); return true; } catch { return 'Must be a valid URL.'; }
        }
    },

    // Credentials (BASIC / NTLM — not SSO)
    {
        type: 'input',
        name: 'BC_USERNAME',
        message: 'BC Username (DOMAIN\\user or user@domain):',
        when: (a) => authType(a) === 'BASIC' || (authType(a) === 'NTLM' && a.ntlmWarningAck),
        default: e('BC_USERNAME'),
        validate: (v) => v.trim().length > 0 || 'Required.'
    },
    {
        type: 'password',
        name: 'BC_PASSWORD',
        message: existing.BC_PASSWORD
            ? 'BC Password (press Enter to keep existing):'
            : 'BC Password:',
        when: (a) => authType(a) === 'BASIC' || (authType(a) === 'NTLM' && a.ntlmWarningAck),
        mask: '*',
        default: e('BC_PASSWORD'),
        validate: (v) => v.trim().length > 0 || 'Required.'
    },

    // Common BC fields
    {
        type: 'input',
        name: 'BC_COMPANY',
        message: 'BC Company name:',
        default: e('BC_COMPANY'),
        validate: (v) => v.trim().length > 0 || 'Required.'
    },

    // MCP Server ports
    {
        type: 'input',
        name: 'MCP_HOST',
        message: 'MCP bind host:',
        default: e('MCP_HOST', '127.0.0.1')
    },
    {
        type: 'input',
        name: 'MCP_PORT',
        message: 'MCP SSE port:',
        default: e('MCP_PORT', '3000'),
        validate: async (v) => {
            if (!Number.isInteger(Number(v)) || Number(v) <= 0) return 'Must be a valid port number.';
            if (await isPortInUse(Number(v))) return `Port ${v} is already in use — choose a different port.`;
            return true;
        }
    },
    {
        type: 'input',
        name: 'MCP_STREAMABLE_PORT',
        message: 'MCP Streamable port (blank = share SSE port, different routes):',
        default: e('MCP_STREAMABLE_PORT', ''),
        validate: async (v, a) => {
            if (!v || v.trim() === '') return true;
            if (!Number.isInteger(Number(v)) || Number(v) <= 0) return 'Must be a valid port number.';
            if (Number(v) === Number(a.MCP_PORT)) return `Port ${v} is already used for the SSE port — choose a different port.`;
            if (await isPortInUse(Number(v))) return `Port ${v} is already in use — choose a different port.`;
            return true;
        }
    },
    {
        type: 'input',
        name: 'MCP_API_KEY',
        message: 'MCP API Key (leave blank to disable):',
        default: e('MCP_API_KEY', '')
    },

    // Advanced / optional
    {
        type: 'list',
        name: 'LOG_LEVEL',
        message: 'Log level  [info / debug / warn / error]:',
        choices: LOG_CHOICES,
        default: e('LOG_LEVEL', 'info')
    },
    {
        type: 'input',
        name: 'HTTP_TIMEOUT_MS',
        message: 'HTTP timeout (ms):',
        default: e('HTTP_TIMEOUT_MS', '60000')
    },
    {
        type: 'input',
        name: 'JMXQ_EXECUTION_CONTEXT_CODE',
        message: 'Execution context code:',
        default: e('JMXQ_EXECUTION_CONTEXT_CODE', 'DEFAULT')
    }
]);

// Merge phase 1 + phase 2, and normalize BC_AUTH_TYPE to clean value
const answers = { instanceLabel, envFilePath, ...config };
answers.BC_AUTH_TYPE = authType(answers);

// Abort if "Abort setup" was chosen (Option A)
if (answers.BC_AUTH_TYPE === '__ABORT__') {
    console.log('\nSetup aborted — no files written.');
    process.exit(0);
}

// Abort if NTLM was not acknowledged
if (answers.BC_AUTH_TYPE === 'NTLM' && answers.ntlmWarningAck === false) {
    console.log('\nSetup aborted.');
    process.exit(0);
}

const serviceName = `${SERVICE_PREFIX}${answers.instanceLabel}`;
const envContent = buildEnvContent(answers);

// Show preview
console.log('\n── .env preview ───────────────────────────────');
console.log(envContent.replace(/SECRET=.+/g, 'SECRET=***').replace(/PASSWORD=.+/g, 'PASSWORD=***'));
console.log('───────────────────────────────────────────────\n');

const { confirmWrite } = await inquirer.prompt([
    {
        type: 'confirm',
        name: 'confirmWrite',
        message: `Write .env to: ${answers.envFilePath}?`,
        default: true
    }
]);

if (!confirmWrite) {
    console.log('Setup aborted — no files written.');
    process.exit(0);
}

// Write .env file
const envDir = path.dirname(answers.envFilePath);
if (!fs.existsSync(envDir)) {
    fs.mkdirSync(envDir, { recursive: true });
}
fs.writeFileSync(answers.envFilePath, envContent, 'utf-8');
console.log(`✓ .env written to: ${answers.envFilePath}`);

// Offer Windows service installation
const { installWinService } = await inquirer.prompt([
    {
        type: 'confirm',
        name: 'installWinService',
        message: `Install as Windows Service "${serviceName}"?`,
        default: true
    }
]);

if (installWinService) {
    console.log('\nInstalling Windows service (requires Administrator privileges)...');
    try {
        await installService(serviceName, answers.envFilePath);
    } catch (err) {
        console.error('✗ Service installation failed:', err.message);
        console.log(`  You can install manually later with:\n  node scripts/install-service.js --instance "${answers.instanceLabel}" --env-file "${answers.envFilePath}"`);
        process.exit(1);
    }
} else {
    console.log(`\nSkipped service installation. To install later:\n  node scripts/install-service.js --instance "${answers.instanceLabel}" --env-file "${answers.envFilePath}"`);
}

console.log('\n══════════════════════════════════════════════');
console.log(`  Service name : ${serviceName}`);
console.log(`  SSE port     : ${answers.MCP_PORT}`);
if (answers.MCP_STREAMABLE_PORT) {
    console.log(`  Stream port  : ${answers.MCP_STREAMABLE_PORT}`);
}
console.log(`  Env file     : ${answers.envFilePath}`);
console.log('══════════════════════════════════════════════\n');
