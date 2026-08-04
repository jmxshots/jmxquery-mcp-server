import { request } from 'undici';
import { pino } from 'pino';
import { config } from './config.js';
import { execSync } from 'child_process';
// @ts-ignore
import { NtlmClient } from 'node-client-ntlm';
import { WindowsEventLogger } from './utils/eventLogger.js';
import { getOAuthToken } from './utils/oauthProvider.js';
import { BcInstanceConfig } from './instances/model.js';

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

function redactSensitiveText(input: string): string {
    if (!input) return input;

    const patterns: Array<[RegExp, string]> = [
        [/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]'],
        [/(Authorization\s*:\s*Basic\s+)[^\s,;]+/gi, '$1[REDACTED]'],
        [/("?(?:password|client_secret|api_key|token)"?\s*[:=]\s*")([^"]+)(")/gi, '$1[REDACTED]$3'],
        [/("?(?:password|client_secret|api_key|token)"?\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]'],
    ];

    return patterns.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), input);
}

function toSafeLogPreview(input: string, maxLen = 240): string {
    const redacted = redactSensitiveText(input || '').replace(/[\r\n\t]+/g, ' ').trim();
    if (redacted.length <= maxLen) {
        return redacted;
    }
    return `${redacted.slice(0, maxLen)}...`;
}

const normalizeUrl = (url: string): string => url.endsWith('/') ? url : `${url}/`;

export function resolveODataBaseUrl(instance: BcInstanceConfig): string {
    if (instance.authType !== 'OAUTH') {
        return normalizeUrl(instance.baseUrl);
    }

    return `https://api.businesscentral.dynamics.com/v2.0/${instance.tenantId}/${instance.environment}/ODataV4/`;
}

function resolveCompaniesApiUrl(instance: BcInstanceConfig): string {
    const url = new URL(resolveODataBaseUrl(instance));
    const apiPath = url.pathname.replace(/\/ODataV4\/?$/i, '/api/v2.0/companies');
    if (apiPath === url.pathname) {
        throw new Error('The configured OData URL must end with ODataV4 to load companies.');
    }
    url.pathname = apiPath;
    return url.toString();
}

export interface BcODataCompany {
    name: string;
    displayName?: string;
}

export class BcClient {
    private readonly baseUrl: string;
    private readonly timeoutMs: number;

    constructor(private readonly instance: BcInstanceConfig) {
        this.baseUrl = resolveODataBaseUrl(instance);
        this.timeoutMs = instance.timeoutMs;
    }

    private async requestTextWithTimeout(url: string, options: Parameters<typeof request>[1]) {
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
        } finally {
            clearTimeout(timeoutHandle);
        }
    }

    private async withTimeout<T>(label: string, fn: () => Promise<T>): Promise<T> {
        let timeoutHandle: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                fn(),
                new Promise<T>((_, reject) => {
                    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
                }),
            ]);
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    async testConnection(): Promise<void> {
        const requestId = crypto.randomUUID();
        let statusCode = 200;

        try {
            if (this.instance.authType === 'SSO') {
                this.testViaPowerShell(this.baseUrl, requestId);
            } else if (this.instance.authType === 'NTLM') {
                const ntlmClient = new (NtlmClient as any)(
                    this.instance.username,
                    this.instance.password,
                    '',
                    '',
                );
                const response = await this.withTimeout('BC NTLM connection test', async () =>
                    await (ntlmClient as any).request({
                        url: this.baseUrl,
                        method: 'GET',
                        headers: {
                            'Accept': 'application/json',
                            'X-Request-ID': requestId,
                        },
                    }),
                );
                statusCode = response.statusCode;
            } else {
                const headers: Record<string, string> = {
                    'Accept': 'application/json',
                    'X-Request-ID': requestId,
                };
                if (this.instance.authType === 'OAUTH') {
                    headers.Authorization = `Bearer ${await getOAuthToken(this.instance)}`;
                } else {
                    const credentials = Buffer.from(`${this.instance.username}:${this.instance.password}`).toString('base64');
                    headers.Authorization = `Basic ${credentials}`;
                }
                const response = await this.requestTextWithTimeout(this.baseUrl, {
                    method: 'GET',
                    headers,
                });
                statusCode = response.statusCode;
            }

            if (statusCode >= 400) {
                throw new Error(`Business Central connection test failed with HTTP ${statusCode}.`);
            }

            logger.info({ authType: this.instance.authType, requestId, statusCode }, 'BC connection test completed');
        } catch (error: any) {
            logger.error({
                requestId,
                errorName: error?.name,
            }, 'BC connection test failed');
            const detail = error instanceof Error ? error.message : 'Unknown connection error.';
            throw new Error(`Business Central connection test failed: ${detail}`);
        }
    }

    async listCompanies(): Promise<BcODataCompany[]> {
        const requestId = crypto.randomUUID();
        const url = resolveCompaniesApiUrl(this.instance);
        let responseBody: string;
        let statusCode: number;

        try {
            if (this.instance.authType === 'SSO') {
                responseBody = this.getViaPowerShell(url, requestId);
                statusCode = 200;
            } else if (this.instance.authType === 'NTLM') {
                const ntlmClient = new (NtlmClient as any)(
                    this.instance.username,
                    this.instance.password,
                    '',
                    '',
                );
                const response = await this.withTimeout('BC company discovery', async () =>
                    await (ntlmClient as any).request({
                        url,
                        method: 'GET',
                        headers: {
                            'Accept': 'application/json',
                            'X-Request-ID': requestId,
                        },
                    }),
                );
                statusCode = response.statusCode;
                responseBody = response.body;
            } else {
                const headers: Record<string, string> = {
                    'Accept': 'application/json',
                    'X-Request-ID': requestId,
                };
                if (this.instance.authType === 'OAUTH') {
                    headers.Authorization = `Bearer ${await getOAuthToken(this.instance)}`;
                } else {
                    const credentials = Buffer.from(`${this.instance.username}:${this.instance.password}`).toString('base64');
                    headers.Authorization = `Basic ${credentials}`;
                }
                const response = await this.requestTextWithTimeout(url, {
                    method: 'GET',
                    headers,
                });
                statusCode = response.statusCode;
                responseBody = response.text;
            }

            if (statusCode >= 400) {
                throw new Error(`Business Central company discovery failed with HTTP ${statusCode}.`);
            }

            const response = JSON.parse(responseBody) as { value?: unknown };
            const values: unknown[] = Array.isArray(response.value) ? response.value : [];
            return values
                .filter((company: unknown): company is Record<string, unknown> =>
                    Boolean(company) && typeof company === 'object' && typeof (company as Record<string, unknown>).name === 'string',
                )
                .map(company => ({
                    name: String(company.name).trim(),
                    ...(typeof company.displayName === 'string' && company.displayName.trim()
                        ? { displayName: company.displayName.trim() }
                        : {}),
                }))
                .filter(company => company.name.length > 0);
        } catch (error: any) {
            logger.error({ requestId, errorName: error?.name }, 'BC company discovery failed');
            const detail = error instanceof Error ? error.message : 'Unknown company discovery error.';
            throw new Error(`Business Central company discovery failed: ${detail}`);
        }
    }

    async callAction<T = any>(serviceName: string, actionName: string, company: string, payload: Record<string, any>): Promise<T> {
        const url = new URL(`${serviceName}_${actionName}`, this.baseUrl);
        url.searchParams.append('company', company);

        logger.debug({ url: url.toString(), authType: this.instance.authType }, 'Calling BC Action');

        const requestId = crypto.randomUUID();
        const startTime = Date.now();

        try {
            let responseBody: string;
            let statusCode: number = 200;

            if (this.instance.authType === 'SSO') {
                // Use PowerShell bridge for Integrated Windows Auth (SSO)
                responseBody = this.callViaPowerShell(url.toString(), payload, requestId);
            } else if (this.instance.authType === 'NTLM') {
                // Use node-client-ntlm for NTLM
                // We use any here because the library types are unreliable/missing
                const ntlmClient = new (NtlmClient as any)(
                    this.instance.username,
                    this.instance.password,
                    '', // workstation
                    ''  // domain
                );
                const response = await this.withTimeout('BC NTLM request', async () =>
                    await (ntlmClient as any).request({
                        url: url.toString(),
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'X-Request-ID': requestId,
                        },
                        body: JSON.stringify(payload)
                    })
                );
                statusCode = response.statusCode;
                responseBody = response.body;
            } else if (this.instance.authType === 'OAUTH') {
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
            } else {
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
                } catch {
                    return rawValue as unknown as T;
                }
            }

            return rawValue;
        } catch (error: any) {
            logger.error({
                requestId,
                errorName: error?.name,
                errorMessage: toSafeLogPreview(String(error?.message || ''), 400)
            }, 'BC Client Exception');
            throw error;
        }
    }

    private callViaPowerShell(url: string, payload: any, requestId: string): string {
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
            $response = Invoke-RestMethod -Uri "${url}" -Method Post -Body $bodyBytes -ContentType "application/json; charset=utf-8" -UseDefaultCredentials -UseBasicParsing -Headers $headers;
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
        } catch (err: any) {
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
                    } else if (parsed.error) {
                        message = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
                    }
                } catch {
                    // Fallback to the extracted string (cleaned)
                    message = jsonMatch[0];
                }
            } else {
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

    private testViaPowerShell(url: string, requestId: string): void {
        const escapedUrl = url.replace(/'/g, "''");
        const psScript = `
            $ProgressPreference = 'SilentlyContinue';
            $headers = @{ "Accept" = "application/json"; "X-Request-ID" = "${requestId}" };
            $response = Invoke-WebRequest -Uri '${escapedUrl}' -Method Get -UseDefaultCredentials -UseBasicParsing -Headers $headers -ErrorAction Stop;
            if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 400) { throw "HTTP $($response.StatusCode)" }
        `.trim();
        const base64Script = Buffer.from(psScript, 'utf16le').toString('base64');

        try {
            execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${base64Script}`, {
                encoding: 'utf-8',
                timeout: this.timeoutMs,
                maxBuffer: 1024 * 1024,
            });
        } catch (error: any) {
            throw new Error('Business Central SSO connection test failed.');
        }
    }

    private getViaPowerShell(url: string, requestId: string): string {
        const escapedUrl = url.replace(/'/g, "''");
        const psScript = `
            $ProgressPreference = 'SilentlyContinue';
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
            $headers = @{ "Accept" = "application/json"; "X-Request-ID" = "${requestId}" };
            $response = Invoke-RestMethod -Uri '${escapedUrl}' -Method Get -UseDefaultCredentials -UseBasicParsing -Headers $headers -ErrorAction Stop;
            $response | ConvertTo-Json -Depth 10 -Compress;
        `.trim();
        const base64Script = Buffer.from(psScript, 'utf16le').toString('base64');

        try {
            return execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${base64Script}`, {
                encoding: 'utf-8',
                timeout: this.timeoutMs,
                maxBuffer: 10 * 1024 * 1024,
            }).trim();
        } catch {
            throw new Error('Business Central SSO company discovery failed.');
        }
    }
}
