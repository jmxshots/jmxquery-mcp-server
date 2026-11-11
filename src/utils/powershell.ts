import { execFile } from 'node:child_process';

export interface PowerShellOptions {
    /** Untrusted values for the script, exposed as $JmxqInput. Never interpolate them into the script text. */
    input?: Record<string, unknown>;
    timeoutMs?: number;
    maxBuffer?: number;
}

export interface PowerShellError extends Error {
    stdout?: string;
    stderr?: string;
}

// Untrusted data travels over stdin as Base64-encoded UTF-8 JSON, so it can never be
// parsed as PowerShell code (PowerShell also treats typographic quotes as string
// delimiters, which defeats quote escaping).
const INPUT_PRELUDE = [
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$JmxqInput = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json',
].join('\n');

/**
 * Runs a fixed PowerShell script asynchronously without blocking the event loop.
 * The script must be a constant; all variable data belongs in options.input.
 */
export function runPowerShell(script: string, options: PowerShellOptions = {}): Promise<string> {
    const fullScript = `${INPUT_PRELUDE}\n${script}`;
    const encodedScript = Buffer.from(fullScript, 'utf16le').toString('base64');
    const encodedInput = Buffer.from(JSON.stringify(options.input ?? {}), 'utf8').toString('base64');

    return new Promise((resolve, reject) => {
        const child = execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
            {
                encoding: 'utf8',
                timeout: options.timeoutMs,
                maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
                windowsHide: true,
            },
            (error, stdout, stderr) => {
                if (error) {
                    const failure = error as PowerShellError;
                    failure.stdout = stdout;
                    failure.stderr = stderr;
                    reject(failure);
                    return;
                }
                resolve(stdout.trim());
            },
        );
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(encodedInput);
    });
}
