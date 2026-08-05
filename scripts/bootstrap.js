import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '..');

export const secretPlaceholders = {
    JMXQ_MCPAPI_KEY: 'replace_with_a_long_random_mcp_key',
    ADMIN_API_KEY: 'replace_with_a_long_random_admin_key',
    INSTANCE_MASTER_KEY: 'replace_with_a_long_random_master_key_at_least_32_characters',
};

export const createSecret = () => randomBytes(48).toString('hex');

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
    { fileSystem = fs, generateSecret = createSecret } = {},
) => {
    const envPath = path.join(rootDirectory, '.env');
    if (fileSystem.existsSync(envPath)) {
        const errors = validateConfiguration(fileSystem.readFileSync(envPath, 'utf8'));
        if (errors.length > 0) {
            throw new Error(`Existing .env is invalid: ${errors.join(' ')}`);
        }
        return { created: false, envPath };
    }

    const templatePath = path.join(rootDirectory, '.env.example');
    const contents = createInitialConfiguration(fileSystem.readFileSync(templatePath, 'utf8'), generateSecret);

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
    runCommand: commandRunner = runCommand,
    logger = console.log,
    generateSecret = createSecret,
} = {}) => {
    if (platform !== 'win32') {
        throw new Error('Bootstrap installs a Windows service and must be run on Windows.');
    }

    const npm = npmExecutable || (platform === 'win32' ? 'npm.cmd' : 'npm');
    const commandOptions = { cwd: rootDirectory, runCommand: commandRunner };

    logger('1/4 Installing npm dependencies...');
    execute(npm, ['install'], commandOptions);

    logger('2/4 Preparing service configuration...');
    const configuration = provisionConfiguration(rootDirectory, { generateSecret });
    logger(configuration.created ? 'Created .env with new secret values.' : 'Using existing validated .env.');

    logger('3/4 Building server and Admin GUI...');
    execute(npm, ['run', 'build'], commandOptions);

    logger('4/4 Installing and starting the Windows service...');
    execute(nodeExecutable, [path.join(rootDirectory, 'scripts', 'install-service.js')], commandOptions);
    logger('Bootstrap completed. Open the Admin GUI to create an Instance and Company.');
};

export const parseArguments = (args) => {
    if (args.length === 0) return { help: false };
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { help: true };
    throw new Error(`Unknown bootstrap option: ${args.join(' ')}`);
};

const printHelp = () => {
    console.log('Usage: npm run bootstrap');
    console.log('Installs dependencies, creates a missing .env, builds the project, and installs the Windows service.');
};

const isDirectExecution = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectExecution) {
    try {
        if (parseArguments(process.argv.slice(2)).help) {
            printHelp();
        } else {
            runBootstrap();
        }
    } catch (error) {
        console.error(`Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}