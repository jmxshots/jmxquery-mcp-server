import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
    createNpmExecutor,
    execute,
    hasInstalledDependencies,
    projectRoot,
    runCommand,
    validateConfiguration,
} from './bootstrap.js';

/** `net session` succeeds only in an elevated process. */
export const isElevated = () => {
    const result = spawnSync('net.exe', ['session'], { stdio: 'ignore', windowsHide: true });
    return !result.error && result.status === 0;
};

/** Runs a command and captures its output instead of streaming it to the console. */
export const readCommand = (command, args, options) => {
    const result = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8', windowsHide: true });
    return {
        status: result.error ? null : result.status,
        output: result.error ? result.error.message : `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd(),
    };
};

/**
 * Fast-forwards the checkout to its upstream branch. Refuses to run when tracked files have
 * local changes, so an update never creates a merge or overwrites local work.
 */
export const pullLatest = ({ rootDirectory, gitExecutable, readCommand: reader, runCommand: commandRunner, logger }) => {
    const git = args => reader(gitExecutable, args, { cwd: rootDirectory });

    const repository = git(['rev-parse', '--is-inside-work-tree']);
    if (repository.status !== 0 || repository.output !== 'true') {
        throw new Error(`--pull requires a Git checkout, but ${rootDirectory} is not one: ${repository.output}`);
    }
    const changes = git(['status', '--porcelain', '--untracked-files=no']);
    if (changes.status !== 0) {
        throw new Error(`git status failed: ${changes.output}`);
    }
    if (changes.output) {
        throw new Error(`Local changes in tracked files prevent --pull. Commit or discard them first:\n${changes.output}`);
    }

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).output;
    const before = git(['rev-parse', '--short', 'HEAD']).output;
    logger(`Pulling the latest commits for branch ${branch} (currently ${before})...`);
    execute(gitExecutable, ['pull', '--ff-only'], { cwd: rootDirectory, runCommand: commandRunner });
    const after = git(['rev-parse', '--short', 'HEAD']).output;
    logger(before === after ? `Already up to date at ${after}.` : `Updated ${before} -> ${after}.`);
};

/**
 * Non-interactive update of an already configured checkout: optionally pulls the latest
 * commits, installs changed dependencies, rebuilds, and re-applies the service definition
 * (which inlines .env) before restarting it. Unlike bootstrap it never prompts and never
 * modifies .env.
 */
export const runServiceUpdate = ({
    pull = false,
    gitExecutable = 'git',
    readCommand: reader = readCommand,
    rootDirectory = projectRoot,
    platform = process.platform,
    npmExecutable = 'npm.cmd',
    nodeExecutable = process.execPath,
    commandShell = process.env.ComSpec || 'cmd.exe',
    elevationCheck = isElevated,
    dependencyCheck = hasInstalledDependencies,
    runCommand: commandRunner = runCommand,
    logger = console.log,
} = {}) => {
    if (platform !== 'win32') {
        throw new Error('The service update manages a Windows service and must be run on Windows.');
    }
    if (!elevationCheck()) {
        throw new Error('Administrator rights are required. Run the update from an elevated PowerShell.');
    }

    if (pull) {
        pullLatest({ rootDirectory, gitExecutable, readCommand: reader, runCommand: commandRunner, logger });
    }

    const envPath = path.join(rootDirectory, '.env');
    if (!fs.existsSync(envPath)) {
        throw new Error(`${envPath} not found. Run npm run bootstrap for the first installation.`);
    }
    const errors = validateConfiguration(fs.readFileSync(envPath, 'utf8'));
    if (errors.length > 0) {
        throw new Error(`.env is invalid: ${errors.join(' ')} Run npm run bootstrap to repair it.`);
    }

    const executeNpm = createNpmExecutor({
        npm: npmExecutable,
        commandShell,
        cwd: rootDirectory,
        runCommand: commandRunner,
    });

    logger('1/3 Checking dependencies...');
    for (const [label, directory, args] of [
        ['Server', rootDirectory, ['ci']],
        ['Admin GUI', path.join(rootDirectory, 'test-client'), ['--prefix', 'test-client', 'ci']],
    ]) {
        if (dependencyCheck(directory)) {
            logger(`${label} dependencies already match package-lock.json.`);
        } else {
            logger(`Installing ${label} dependencies...`);
            executeNpm(args);
        }
    }

    // The service keeps running during the build; it is restarted only after a successful build.
    logger('2/3 Building server and Admin GUI...');
    executeNpm(['run', 'build']);

    logger('3/3 Applying service configuration and restarting the service...');
    execute(nodeExecutable, [path.join(rootDirectory, 'scripts', 'install-service.js')], {
        cwd: rootDirectory,
        runCommand: commandRunner,
    });
    logger('Service update completed.');
};

export const parseArguments = (args) => {
    const options = { help: false, pull: false };
    for (const arg of args) {
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--pull') options.pull = true;
        else throw new Error(`Unknown option: ${arg}. Usage: npm run service:update [-- --pull]`);
    }
    return options;
};

const printHelp = () => {
    console.log('Usage: npm run service:update [-- --pull]');
    console.log('Installs changed dependencies, rebuilds, and restarts the Windows service with the current .env.');
    console.log('  --pull  First fast-forward the Git checkout (git pull --ff-only). Refuses when tracked files have local changes.');
};

const isDirectExecution = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectExecution) {
    try {
        const options = parseArguments(process.argv.slice(2));
        if (options.help) printHelp();
        else runServiceUpdate({ pull: options.pull });
    } catch (error) {
        console.error(`Service update failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
