import { request } from 'undici';
import { pino } from 'pino';
import { config } from './config.js';
import { execSync } from 'child_process';
// @ts-ignore
import { NtlmClient } from 'node-client-ntlm';
import { WindowsEventLogger } from './utils/eventLogger.js';
import { getOAuthToken } from './utils/oauthProvider.js';
const logger = pino({
    level: config.LOG_LEVEL,
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'HH:MM:ss Z',
            destination: 2, // 2 is stderr
        },
    },
});
export class BcClient {
    baseUrl;
    constructor() {
        this.baseUrl = config.resolvedBaseUrl;
    }
    async requestTextWithTimeout(url, options) {
        const timeoutMs = Number(config.HTTP_TIMEOUT_MS) || 60000;
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => {
            controller.abort(new Error(`HTTP request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        try {
            const { statusCode, body } = await request(url, {
                ...(options || {}),
                signal: controller.signal,
            });
            const text = await body.text();
            return { statusCode, text };
        }
        finally {
            clearTimeout(timeoutHandle);
        }
    }
    async withTimeout(label, fn) {
        const timeoutMs = Number(config.HTTP_TIMEOUT_MS) || 60000;
        return await Promise.race([
            fn(),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)),
        ]);
    }
    async callAction(serviceName, actionName, payload) {
        const url = new URL(`${serviceName}_${actionName}`, this.baseUrl);
        url.searchParams.append('company', config.BC_COMPANY);
        logger.debug({ url: url.toString(), authType: config.BC_AUTH_TYPE }, 'Calling BC Action');
        const requestId = crypto.randomUUID();
        const startTime = Date.now();
        try {
            let responseBody;
            let statusCode = 200;
            if (config.BC_AUTH_TYPE === 'SSO') {
                // Use PowerShell bridge for Integrated Windows Auth (SSO)
                responseBody = this.callViaPowerShell(url.toString(), payload, requestId);
            }
            else if (config.BC_AUTH_TYPE === 'NTLM') {
                // Use node-client-ntlm for NTLM
                // We use any here because the library types are unreliable/missing
                const ntlmClient = new NtlmClient(config.BC_USERNAME || '', config.BC_PASSWORD || '', '', // workstation
                '' // domain
                );
                const response = await this.withTimeout('BC NTLM request', async () => await ntlmClient.request({
                    url: url.toString(),
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-Request-ID': requestId,
                    },
                    body: JSON.stringify(payload)
                }));
                statusCode = response.statusCode;
                responseBody = response.body;
            }
            else if (config.BC_AUTH_TYPE === 'OAUTH') {
                // OAuth 2.0 Bearer token (SaaS / Business Central Online)
                const token = await getOAuthToken();
                const resp = await this.requestTextWithTimeout(url.toString(), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'Authorization': `Bearer ${token}`,
                        'X-Request-ID': requestId,
                    },
                    body: JSON.stringify(payload),
                });
                statusCode = resp.statusCode;
                responseBody = resp.text;
            }
            else {
                // Default: BASIC via undici
                const credentials = Buffer.from(`${config.BC_USERNAME}:${config.BC_PASSWORD}`).toString('base64');
                const resp = await this.requestTextWithTimeout(url.toString(), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'Authorization': `Basic ${credentials}`,
                        'X-Request-ID': requestId,
                    },
                    body: JSON.stringify(payload),
                });
                statusCode = resp.statusCode;
                responseBody = resp.text;
            }
            const duration = Date.now() - startTime;
            logger.info({ service: serviceName, action: actionName, statusCode, duration, requestId }, 'BC API Call Completed');
            if (statusCode >= 400) {
                logger.error({ responseBody, statusCode, requestId }, 'BC API Error');
                const errorMsg = `BC API Error (${statusCode}): ${responseBody}`;
                WindowsEventLogger.error(errorMsg);
                throw new Error(errorMsg);
            }
            const odataResponse = JSON.parse(responseBody);
            const rawValue = odataResponse.value ?? odataResponse;
            if (typeof rawValue === 'string') {
                try {
                    return JSON.parse(rawValue);
                }
                catch {
                    return rawValue;
                }
            }
            return rawValue;
        }
        catch (error) {
            logger.error({ err: error, requestId }, 'BC Client Exception');
            throw error;
        }
    }
    callViaPowerShell(url, payload, requestId) {
        const jsonPayload = JSON.stringify(payload);
        // Construct PowerShell script
        // Note: No need for manual escaping of quotes here because it's Base64 encoded
        const psScript = `
            $ProgressPreference = 'SilentlyContinue';
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
            $headers = @{ 
                "Accept" = "application/json"; 
                "X-Request-ID" = "${requestId}" 
            };
            $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes('${jsonPayload.replace(/'/g, "''")}');
            $response = Invoke-RestMethod -Uri "${url}" -Method Post -Body $bodyBytes -ContentType "application/json; charset=utf-8" -UseDefaultCredentials -Headers $headers;
            if ($null -eq $response) { return "" }
            $response | ConvertTo-Json -Depth 10 -Compress;
        `.trim();
        // PowerShell -EncodedCommand expects UTF-16LE Base64
        const scriptBuffer = Buffer.from(psScript, 'utf16le');
        const base64Script = scriptBuffer.toString('base64');
        try {
            const output = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${base64Script}`, {
                encoding: 'utf-8',
                timeout: Number(config.HTTP_TIMEOUT_MS) || 60000,
                maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large responses
            });
            return output.trim();
        }
        catch (err) {
            logger.error({ err, script: psScript }, 'PowerShell Execution Failed');
            let message = err.message || 'Unknown PowerShell Error';
            // 1. Globally clean up PowerShell's CLI XML line breaks
            message = message.replace(/_x000D__x000A_/g, ' ');
            // 2. Strip the long "Command failed: powershell ... -EncodedCommand <base64>" prefix
            if (message.includes('-EncodedCommand')) {
                message = message.split('#< CLIXML').pop() || message;
            }
            // 3. Try to extract JSON error from CLIXML string tags <S S="Error">...</S>
            // Note: We use a more specific regex for the JSON block
            const jsonMatch = message.match(/({(?:\s|[^}]*)"error"(?:\s|[^}]*)})/);
            if (jsonMatch) {
                try {
                    // Final cleanup before parsing to ensure valid JSON
                    const jsonStr = jsonMatch[0].trim();
                    const parsed = JSON.parse(jsonStr);
                    if (parsed.error?.message) {
                        message = parsed.error.message;
                        if (parsed.error.code) {
                            message += ` (${parsed.error.code})`;
                        }
                    }
                    else if (parsed.error) {
                        message = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
                    }
                }
                catch {
                    // Fallback to the extracted string (cleaned)
                    message = jsonMatch[0];
                }
            }
            else {
                // 4. Fallback: Strip CLIXML tags if JSON extraction failed
                message = message.replace(/<[^>]+>/g, '').trim();
            }
            if (message.includes('Authentication_InvalidCredentials') || message.includes('401')) {
                message += '\n\nHINT: If the server is running as a Windows Service, ensure the service is configured to "Log On" as a domain user with Business Central access. The default LocalSystem account cannot use SSO.';
            }
            const fullError = `BC SSO Error: ${message}`;
            WindowsEventLogger.error(fullError);
            throw new Error(fullError);
        }
    }
}
export const bcClient = new BcClient();
