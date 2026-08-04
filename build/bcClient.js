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
function redactSensitiveText(input) {
    if (!input)
        return input;
    const patterns = [
        [/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]'],
        [/(Authorization\s*:\s*Basic\s+)[^\s,;]+/gi, '$1[REDACTED]'],
        [/("?(?:password|client_secret|api_key|token)"?\s*[:=]\s*")([^"]+)(")/gi, '$1[REDACTED]$3'],
        [/("?(?:password|client_secret|api_key|token)"?\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]'],
    ];
    return patterns.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), input);
}
function toSafeLogPreview(input, maxLen = 240) {
    const redacted = redactSensitiveText(input || '').replace(/[\r\n\t]+/g, ' ').trim();
    if (redacted.length <= maxLen) {
        return redacted;
    }
    return `${redacted.slice(0, maxLen)}...`;
}
const normalizeUrl = (url) => url.endsWith('/') ? url : `${url}/`;
export function resolveODataBaseUrl(instance) {
    if (instance.authType !== 'OAUTH') {
        return normalizeUrl(instance.baseUrl);
    }
    return `https://api.businesscentral.dynamics.com/v2.0/${instance.tenantId}/${instance.environment}/ODataV4/`;
}
export class BcClient {
    instance;
    baseUrl;
    timeoutMs;
    constructor(instance) {
        this.instance = instance;
        this.baseUrl = resolveODataBaseUrl(instance);
        this.timeoutMs = instance.timeoutMs;
    }
    async requestTextWithTimeout(url, options) {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => {
            controller.abort(new Error(`HTTP request timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
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
        let timeoutHandle;
        try {
            return await Promise.race([
                fn(),
                new Promise((_, reject) => {
                    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
                }),
            ]);
        }
        finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }
    async callAction(serviceName, actionName, company, payload) {
        const url = new URL(`${serviceName}_${actionName}`, this.baseUrl);
        url.searchParams.append('company', company);
        logger.debug({ url: url.toString(), authType: this.instance.authType }, 'Calling BC Action');
        const requestId = crypto.randomUUID();
        const startTime = Date.now();
        try {
            let responseBody;
            let statusCode = 200;
            if (this.instance.authType === 'SSO') {
                // Use PowerShell bridge for Integrated Windows Auth (SSO)
                responseBody = this.callViaPowerShell(url.toString(), payload, requestId);
            }
            else if (this.instance.authType === 'NTLM') {
                // Use node-client-ntlm for NTLM
                // We use any here because the library types are unreliable/missing
                const ntlmClient = new NtlmClient(this.instance.username, this.instance.password, '', // workstation
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
            else if (this.instance.authType === 'OAUTH') {
                // OAuth 2.0 Bearer token (SaaS / Business Central Online)
                const token = await getOAuthToken(this.instance);
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
                const credentials = Buffer.from(`${this.instance.username}:${this.instance.password}`).toString('base64');
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
                const safePreview = toSafeLogPreview(responseBody);
                logger.error({ statusCode, requestId, responseLength: responseBody?.length || 0, responsePreview: safePreview }, 'BC API Error');
                const eventLogMsg = `BC API Error (${statusCode}) [requestId=${requestId}] ${safePreview}`;
                const clientErrorMsg = `BC API Error (${statusCode}) [requestId=${requestId}] ${responseBody}`;
                WindowsEventLogger.error(eventLogMsg);
                throw new Error(clientErrorMsg);
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
            logger.error({
                requestId,
                errorName: error?.name,
                errorMessage: toSafeLogPreview(String(error?.message || ''), 400)
            }, 'BC Client Exception');
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
                timeout: this.timeoutMs,
                maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large responses
            });
            return output.trim();
        }
        catch (err) {
            logger.error({
                requestId,
                errorName: err?.name,
                errorMessage: toSafeLogPreview(String(err?.message || ''), 400)
            }, 'PowerShell Execution Failed');
            let message = err.message || 'Unknown PowerShell Error';
            // 1. Globally clean up PowerShell's CLI XML line breaks
            message = message.replace(/_x000D__x000A_/g, ' ');
            // 2. Strip the long "Command failed: powershell ... -EncodedCommand <base64>" prefix
            if (message.includes('-EncodedCommand')) {
                message = message.split('#< CLIXML').pop() || message;
            }
            // 3. Try to extract JSON error from CLIXML string tags <S S="Error">...</S>
            // Improved: First strip all CLIXML tags to avoid fragments breaking the JSON structure
            const cleanedMessage = message.replace(/<[^>]+>/g, '').trim();
            const jsonMatch = cleanedMessage.match(/({(?:\s|[^}]*)"error"(?:\s|[^}]*)})/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
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
                // 4. Fallback: Use the cleaned message if JSON extraction failed
                message = cleanedMessage;
            }
            if (message.includes('Authentication_InvalidCredentials') || message.includes('401')) {
                message += '\n\nHINT: If the server is running as a Windows Service, ensure the service is configured to "Log On" as a domain user with Business Central access. The default LocalSystem account cannot use SSO.';
            }
            const safeMessage = toSafeLogPreview(message, 400);
            const eventLogMsg = `BC SSO Error [requestId=${requestId}]: ${safeMessage}`;
            const clientErrorMsg = `BC SSO Error [requestId=${requestId}]: ${message}`;
            WindowsEventLogger.error(eventLogMsg);
            throw new Error(clientErrorMsg);
        }
    }
}
