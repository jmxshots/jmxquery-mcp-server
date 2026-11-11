import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '..');

export const secretPlaceholders = {
    JMXQ_MCPAPI_KEY: 'replace_with_a_long_random_mcp_key',
    ADMIN_API_KEY: 'replace_with_a_long_random_admin_key',
    INSTANCE_MASTER_KEY: 'replace_with_a_long_random_master_key_at_least_32_characters',
};

export const createSecret = () => randomBytes(48).toString('hex');

/** Identifies a key in console output without revealing it. */
export const maskSecret = (value) => value ? `...${value.slice(-4)}` : '(not set)';

/** Copies text to the Windows clipboard. Returns false when clip.exe is unavailable or fails. */
export const copyToClipboard = (text) => {
    const result = spawnSync('clip.exe', [], { input: text, windowsHide: true });
    return !result.error && result.status === 0;
};

const parseEnv = (contents) => Object.fromEntries(contents
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
        const separator = line.indexOf('=');
        if (separator === -1) return null;

        const name = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        return name ? [name, value] : null;
    })
    .filter(entry => entry !== null));

export const getAdminUrl = (contents) => {
    const values = parseEnv(contents);
    const configuredHost = values.MCP_HOST || '127.0.0.1';
    const browserHost = configuredHost === '0.0.0.0' || configuredHost === '::'
        ? '127.0.0.1'
        : configuredHost;
    const urlHost = browserHost.includes(':') ? `[${browserHost}]` : browserHost;
    return `http://${urlHost}:${values.MCP_PORT || '5000'}/admin`;
};

const setEnvValue = (contents, name, value) => {
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    if (pattern.test(contents)) return contents.replace(pattern, `${name}=${value}`);
    return `${contents}${contents.endsWith('\n') ? '' : '\n'}${name}=${value}\n`;
};

const isConfiguredSecret = (name, value) => Boolean(value && value !== secretPlaceholders[name]);
const minimumSecretLength = (name) => name === 'ADMIN_API_KEY' ? 10 : 32;

const parsePort = (value, name) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${name} must be a whole number from 1 to 65535.`);
    }
    return String(port);
};

export const hasInstalledDependencies = (rootDirectory, fileSystem = fs) => {
    const lockPath = path.join(rootDirectory, 'package-lock.json');
    const installedLockPath = path.join(rootDirectory, 'node_modules', '.package-lock.json');
    if (!fileSystem.existsSync(lockPath) || !fileSystem.existsSync(installedLockPath)) return false;

    try {
        const expectedPackages = JSON.parse(fileSystem.readFileSync(lockPath, 'utf8')).packages;
        const installedPackages = JSON.parse(fileSystem.readFileSync(installedLockPath, 'utf8')).packages;
        if (!expectedPackages || !installedPackages) return false;

        return Object.entries(expectedPackages)
            .filter(([packagePath]) => packagePath.startsWith('node_modules/'))
            .every(([packagePath, expected]) => {
                const installed = installedPackages[packagePath];
                return installed
                    && installed.version === expected.version
                    && installed.integrity === expected.integrity
                    && fileSystem.existsSync(path.join(rootDirectory, packagePath));
            });
    } catch {
        return false;
    }
};

export const applyBootstrapSettings = (contents, settings = {}, generateSecret = createSecret) => {
    let output = contents;
    if (settings.mcpPort !== undefined) {
        output = setEnvValue(output, 'MCP_PORT', parsePort(settings.mcpPort, 'MCP_PORT'));
    }
    if (settings.streamablePort !== undefined) {
        output = setEnvValue(
            output,
            'MCP_STREAMABLE_PORT',
            parsePort(settings.streamablePort, 'MCP_STREAMABLE_PORT'),
        );
    }
    const configuredPorts = parseEnv(output);
    if (configuredPorts.MCP_PORT
        && configuredPorts.MCP_STREAMABLE_PORT
        && configuredPorts.MCP_PORT === configuredPorts.MCP_STREAMABLE_PORT) {
        throw new Error('MCP_PORT and MCP_STREAMABLE_PORT must use different ports.');
    }

    const usedSecrets = new Set(Object.keys(secretPlaceholders)
        .map(name => parseEnv(output)[name])
        .filter(Boolean));
    const applySecret = (name, selection) => {
        if (selection === undefined || selection === 'keep') return;
        let value = selection;
        if (selection === 'generate') {
            do value = generateSecret(); while (usedSecrets.has(value));
        }
        const minimumLength = minimumSecretLength(name);
        if (value.length < minimumLength) {
            throw new Error(`${name} must contain at least ${minimumLength} characters.`);
        }
        usedSecrets.add(value);
        output = setEnvValue(output, name, value);
    };

    applySecret('ADMIN_API_KEY', settings.adminApiKey);
    applySecret('JMXQ_MCPAPI_KEY', settings.mcpApiKey);
    return output;
};

const promptForPort = async (readline, name, currentValue) => {
    while (true) {
        const answer = (await readline.question(`${name} [${currentValue}]: `)).trim() || currentValue;
        try {
            return parsePort(answer, name);
        } catch (error) {
            console.log(error.message);
        }
    }
};

const promptForSecret = async (readline, name, currentValue) => {
    const hasExistingValue = isConfiguredSecret(name, currentValue);
    const defaultChoice = hasExistingValue ? 'k' : 'g';
    while (true) {
        const choices = hasExistingValue
            ? '[K]eep existing, [G]enerate automatically, [E]nter manually'
            : '[G]enerate automatically, [E]nter manually';
        const choice = (await readline.question(`${name}: ${choices} [${defaultChoice.toUpperCase()}]: `))
            .trim().toLowerCase() || defaultChoice;
        if (choice === 'k' && hasExistingValue) return 'keep';
        if (choice === 'g') return 'generate';
        if (choice === 'e') {
            const minimumLength = minimumSecretLength(name);
            const value = (await readline.question(
                `${name} (input is visible, at least ${minimumLength} characters): `,
            )).trim();
            if (value.length >= minimumLength) return value;
            console.log(`${name} must contain at least ${minimumLength} characters.`);
            continue;
        }
        console.log('Please choose one of the displayed options.');
    }
};

const promptForClipboardCopy = async (readline) => {
    while (true) {
        const answer = (await readline.question(
            'Copy ADMIN_API_KEY to the clipboard for the first Admin GUI login? [Y/n]: ',
        )).trim().toLowerCase() || 'y';
        if (answer === 'y' || answer === 'yes') return true;
        if (answer === 'n' || answer === 'no') return false;
        console.log('Please answer Y or N.');
    }
};

const promptForServiceInstallation = async (readline) => {
    while (true) {
        const answer = (await readline.question('Install or update the Windows service? [Y/n]: '))
            .trim()
            .toLowerCase() || 'y';
        if (answer === 'y' || answer === 'yes') return true;
        if (answer === 'n' || answer === 'no') return false;
        console.log('Please answer Y or N.');
    }
};

export const promptForBootstrapSettings = async (rootDirectory = projectRoot, {
    input = process.stdin,
    output = process.stdout,
} = {}) => {
    const envPath = path.join(rootDirectory, '.env');
    const templatePath = path.join(rootDirectory, '.env.example');
    const contents = fs.readFileSync(fs.existsSync(envPath) ? envPath : templatePath, 'utf8');
    const values = parseEnv(contents);
    const readline = createInterface({ input, output });
    try {
        console.log('Configure ports and API keys. Press Enter to accept the default.');
        const mcpPort = await promptForPort(readline, 'MCP_PORT', values.MCP_PORT || '5000');
        const streamablePort = await promptForPort(
            readline,
            'MCP_STREAMABLE_PORT',
            values.MCP_STREAMABLE_PORT || '5001',
        );
        const adminApiKey = await promptForSecret(readline, 'ADMIN_API_KEY', values.ADMIN_API_KEY);
        const mcpApiKey = await promptForSecret(readline, 'JMXQ_MCPAPI_KEY', values.JMXQ_MCPAPI_KEY);
        const installWindowsService = await promptForServiceInstallation(readline);
        const copyAdminKeyToClipboard = await promptForClipboardCopy(readline);
        console.log(isConfiguredSecret('INSTANCE_MASTER_KEY', values.INSTANCE_MASTER_KEY)
            ? 'INSTANCE_MASTER_KEY: keeping the existing automatically generated key.'
            : 'INSTANCE_MASTER_KEY: will be generated automatically.');
        return { mcpPort, streamablePort, adminApiKey, mcpApiKey, installWindowsService, copyAdminKeyToClipboard };
    } finally {
        readline.close();
    }
};

export const enableLanAccess = (contents, machineHostname) => {
    const values = parseEnv(contents);
    const port = values.MCP_PORT || '5000';
    const originHost = machineHostname.includes(':') ? `[${machineHostname}]` : machineHostname;
    const lanOrigin = `http://${originHost}:${port}`;
    const managedHosts = new Set(['127.0.0.1', 'localhost', machineHostname.toLowerCase()]);
    const origins = (values.MCP_CORS_ORIGINS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .filter(origin => {
            try {
                return !managedHosts.has(new URL(origin).hostname.toLowerCase());
            } catch {
                return true;
            }
        });

    origins.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`);

    origins.push(lanOrigin);

    const configuredHost = values.MCP_HOST?.toLowerCase();
    const listenerHost = !configuredHost || ['127.0.0.1', 'localhost', '::1'].includes(configuredHost)
        ? '0.0.0.0'
        : values.MCP_HOST;
    let output = setEnvValue(contents, 'MCP_HOST', listenerHost);
    output = setEnvValue(output, 'MCP_CORS_ORIGINS', origins.join(','));

    return { contents: output, lanOrigin, changed: output !== contents };
};

export const validateConfiguration = (contents) => {
    const values = parseEnv(contents);
    const errors = [];

    for (const [name, placeholder] of Object.entries(secretPlaceholders)) {
        if (values[name] === placeholder) {
            errors.push(`${name} still contains the template placeholder.`);
        }
    }

    const masterKey = values.INSTANCE_MASTER_KEY;
    if (!masterKey || masterKey.length < 32) {
        errors.push('INSTANCE_MASTER_KEY must contain at least 32 characters.');
    }

    if (values.ADMIN_API_ENABLED?.toLowerCase() === 'true' && !values.ADMIN_API_KEY) {
        errors.push('ADMIN_API_KEY is required when ADMIN_API_ENABLED=true.');
    }

    return errors;
};

export const createInitialConfiguration = (template, generateSecret = createSecret) => {
    const generatedSecrets = Object.fromEntries(Object.keys(secretPlaceholders)
        .map(name => [name, generateSecret()]));

    if (new Set(Object.values(generatedSecrets)).size !== Object.keys(secretPlaceholders).length) {
        throw new Error('Secret generator produced duplicate values.');
    }

    const output = template.split(/(\r?\n)/).map(line => {
        for (const [name, placeholder] of Object.entries(secretPlaceholders)) {
            if (line === `${name}=${placeholder}`) {
                return `${name}=${generatedSecrets[name]}`;
            }
        }
        return line;
    }).join('');

    if (validateConfiguration(output).length > 0 || output === template) {
        throw new Error('Configuration template is missing one or more required secret placeholders.');
    }

    return output;
};

export const provisionConfiguration = (
    rootDirectory = projectRoot,
    { fileSystem = fs, generateSecret = createSecret, prepareContents = contents => contents } = {},
) => {
    const envPath = path.join(rootDirectory, '.env');
    if (fileSystem.existsSync(envPath)) {
        const existingContents = fileSystem.readFileSync(envPath, 'utf8');
        const contents = prepareContents(existingContents);
        const errors = validateConfiguration(contents);
        if (errors.length > 0) {
            throw new Error(`Existing .env is invalid: ${errors.join(' ')}`);
        }
        if (contents !== existingContents) {
            fileSystem.writeFileSync(envPath, contents, { encoding: 'utf8', mode: 0o600 });
        }
        return { created: false, envPath };
    }

    const templatePath = path.join(rootDirectory, '.env.example');
    const contents = prepareContents(createInitialConfiguration(
        fileSystem.readFileSync(templatePath, 'utf8'),
        generateSecret,
    ));

    try {
        fileSystem.writeFileSync(envPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (error && typeof error === 'object' && error.code === 'EEXIST') {
            const errors = validateConfiguration(fileSystem.readFileSync(envPath, 'utf8'));
            if (errors.length > 0) {
                throw new Error(`Existing .env is invalid: ${errors.join(' ')}`);
            }
            return { created: false, envPath };
        }
        throw error;
    }

    try {
        fileSystem.chmodSync(envPath, 0o600);
    } catch {
        // Windows may not support POSIX file modes; creation remains protected by its ACLs.
    }

    return { created: true, envPath };
};

const runCommand = (command, args, options) => spawnSync(command, args, {
    cwd: options.cwd,
    stdio: 'inherit',
});

const execute = (command, args, options) => {
    const result = options.runCommand(command, args, { cwd: options.cwd });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
    }
};

export const runBootstrap = ({
    rootDirectory = projectRoot,
    platform = process.platform,
    npmExecutable,
    nodeExecutable = process.execPath,
    commandShell = process.env.ComSpec || 'cmd.exe',
    machineHostname = hostname(),
    bootstrapSettings = {},
    dependencyCheck = hasInstalledDependencies,
    runCommand: commandRunner = runCommand,
    logger = console.log,
    generateSecret = createSecret,
    clipboard = copyToClipboard,
} = {}) => {
    if (platform !== 'win32') {
        throw new Error('Bootstrap installs a Windows service and must be run on Windows.');
    }

    const npm = npmExecutable || (platform === 'win32' ? 'npm.cmd' : 'npm');
    const commandOptions = { cwd: rootDirectory, runCommand: commandRunner };
    const executeNpm = args => execute(
        commandShell,
        ['/d', '/s', '/c', [npm, ...args]
            .map(value => value.includes(' ') ? `"${value}"` : value)
            .join(' ')],
        commandOptions,
    );

    logger('1/5 Checking server dependencies...');
    if (dependencyCheck(rootDirectory)) {
        logger('Server dependencies already match package-lock.json.');
    } else {
        logger('Installing server dependencies...');
        executeNpm(['ci']);
    }

    const adminGuiDirectory = path.join(rootDirectory, 'test-client');
    logger('2/5 Checking Admin GUI dependencies...');
    if (dependencyCheck(adminGuiDirectory)) {
        logger('Admin GUI dependencies already match package-lock.json.');
    } else {
        logger('Installing Admin GUI dependencies...');
        executeNpm(['--prefix', 'test-client', 'ci']);
    }

    logger('3/5 Preparing service configuration...');
    const prepareContents = contents => {
        let preparedContents = contents;
        const masterKey = parseEnv(preparedContents).INSTANCE_MASTER_KEY;
        if (!isConfiguredSecret('INSTANCE_MASTER_KEY', masterKey)) {
            preparedContents = setEnvValue(preparedContents, 'INSTANCE_MASTER_KEY', generateSecret());
        }
        return applyBootstrapSettings(preparedContents, bootstrapSettings, generateSecret);
    };
    const configuration = provisionConfiguration(rootDirectory, { generateSecret, prepareContents });
    logger(configuration.created ? 'Created .env with new secret values.' : 'Using existing validated .env.');
    const configurationContents = fs.readFileSync(configuration.envPath, 'utf8');
    const lanAccess = enableLanAccess(configurationContents, machineHostname);
    if (lanAccess.changed) {
        fs.writeFileSync(configuration.envPath, lanAccess.contents, { encoding: 'utf8', mode: 0o600 });
        logger(`Enabled LAN access for ${machineHostname}.`);
    }

    logger('4/5 Building server and Admin GUI...');
    executeNpm(['run', 'build']);

    const installWindowsService = bootstrapSettings.installWindowsService !== false;
    if (installWindowsService) {
        logger('5/5 Installing and starting the Windows service...');
        execute(nodeExecutable, [path.join(rootDirectory, 'scripts', 'install-service.js')], commandOptions);
    } else {
        logger('5/5 Windows service installation skipped.');
    }
    logger('Bootstrap completed.');
    logger(`Admin GUI (local): ${getAdminUrl(lanAccess.contents)}`);
    logger(`Admin GUI (LAN): ${lanAccess.lanOrigin}/admin`);
    const finalValues = parseEnv(lanAccess.contents);
    logger(`MCP port: ${finalValues.MCP_PORT}`);
    logger(`Streamable HTTP port: ${finalValues.MCP_STREAMABLE_PORT}`);
    // Keys are never written to the console (terminal scrollback, transcripts, screen sharing).
    const adminKeyCopied = bootstrapSettings.copyAdminKeyToClipboard === true
        && Boolean(finalValues.ADMIN_API_KEY)
        && clipboard(finalValues.ADMIN_API_KEY);
    logger(adminKeyCopied
        ? `ADMIN_API_KEY ${maskSecret(finalValues.ADMIN_API_KEY)}: copied to the clipboard. Paste it into the Admin GUI login, then clear the clipboard if Windows clipboard history is enabled.`
        : `ADMIN_API_KEY ${maskSecret(finalValues.ADMIN_API_KEY)}: read it from ${configuration.envPath} for the Admin GUI login.`);
    logger(`JMXQ_MCPAPI_KEY ${maskSecret(finalValues.JMXQ_MCPAPI_KEY)}: after login, open Connect in the Admin GUI to reveal or copy it.`);
    logger(`Keys and service configuration: ${configuration.envPath}`);
    logger(`The Admin GUI should now be available at ${lanAccess.lanOrigin}/admin.`);
    logger(`Port ${finalValues.MCP_PORT} may need to be allowed for private networks in Windows Firewall.`);
    if (!installWindowsService) logger('Start manually: npm start');
    logger('Business Central passwords and client secrets are managed in the Admin GUI and stored encrypted in the Instance Store.');
};

export const parseArguments = (args) => {
    if (args.length === 0) return { help: false };
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { help: true };
    throw new Error(`Unknown bootstrap option: ${args.join(' ')}`);
};

const printHelp = () => {
    console.log('Usage: npm run bootstrap');
    console.log('Prompts for ports, API keys, and optional Windows service installation; generates the master key automatically and builds the project.');
};

const main = async () => {
    if (parseArguments(process.argv.slice(2)).help) {
        printHelp();
    } else {
        const bootstrapSettings = await promptForBootstrapSettings();
        runBootstrap({ bootstrapSettings });
    }
};

const isDirectExecution = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectExecution) {
    main().catch(error => {
    try {
        console.error(`Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    } catch {
        process.exitCode = 1;
    }
    });
}