import { request } from 'undici';
import { pino } from 'pino';
import { config } from './config.js';
// @ts-ignore
import { NtlmClient } from 'node-client-ntlm';
import { WindowsEventLogger } from './utils/eventLogger.js';
import { getOAuthToken } from './utils/oauthProvider.js';
import { runPowerShell } from './utils/powershell.js';
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
// SSO scripts are constants. URI, request ID, and body arrive only through $JmxqInput
// (see runPowerShell), so script content and URLs can never be executed as code.
const SSO_POST_SCRIPT = `
$headers = @{ 'Accept' = 'application/json'; 'X-Request-ID' = [string]$JmxqInput.requestId }
$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$JmxqInput.body)
$response = Invoke-RestMethod -Uri ([string]$JmxqInput.uri) -Method Post -Body $bodyBytes -ContentType 'application/json; charset=utf-8' -UseDefaultCredentials -UseBasicParsing -Headers $headers
if ($null -eq $response) { return '' }
$response | ConvertTo-Json -Depth 10 -Compress
`.trim();
const SSO_TEST_SCRIPT = `
$headers = @{ 'Accept' = 'application/json'; 'X-Request-ID' = [string]$JmxqInput.requestId }
$response = Invoke-WebRequest -Uri ([string]$JmxqInput.uri) -Method Get -UseDefaultCredentials -UseBasicParsing -Headers $headers -ErrorAction Stop
if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 400) { throw "HTTP $($response.StatusCode)" }
`.trim();
const SSO_GET_SCRIPT = `
$headers = @{ 'Accept' = 'application/json'; 'X-Request-ID' = [string]$JmxqInput.requestId }
$response = Invoke-RestMethod -Uri ([string]$JmxqInput.uri) -Method Get -UseDefaultCredentials -UseBasicParsing -Headers $headers -ErrorAction Stop
$response | ConvertTo-Json -Depth 10 -Compress
`.trim();
const normalizeUrl = (url) => url.endsWith('/') ? url : `${url}/`;
export function resolveODataBaseUrl(instance) {
    if (instance.authType !== 'OAUTH') {
        return normalizeUrl(instance.baseUrl);
    }
    return `https://api.businesscentral.dynamics.com/v2.0/${instance.tenantId}/${instance.environment}/ODataV4/`;
}
function resolveCompaniesApiUrl(instance) {
    const url = new URL(resolveODataBaseUrl(instance));
    const apiPath = url.pathname.replace(/\/ODataV4\/?$/i, '/api/v2.0/companies');
    if (apiPath === url.pathname) {
        throw new Error('The configured OData URL must end with ODataV4 to load companies.');
    }
    url.pathname = apiPath;
    return url.toString();
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
    async testConnection() {
        const requestId = crypto.randomUUID();
        let statusCode = 200;
        try {
            if (this.instance.authType === 'SSO') {
                await this.testViaPowerShell(this.baseUrl, requestId);
            }
            else if (this.instance.authType === 'NTLM') {
                const ntlmClient = new NtlmClient(this.instance.username, this.instance.password, '', '');
                const response = await this.withTimeout('BC NTLM connection test', async () => await ntlmClient.request({
                    url: this.baseUrl,
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json',
                        'X-Request-ID': requestId,
                    },
                }));
                statusCode = response.statusCode;
            }
            else {
                const headers = {
                    'Accept': 'application/json',
                    'X-Request-ID': requestId,
                };
                if (this.instance.authType === 'OAUTH') {
                    headers.Authorization = `Bearer ${await getOAuthToken(this.instance)}`;
                }
                else {
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
        }
        catch (error) {
            logger.error({
                requestId,
                errorName: error?.name,
            }, 'BC connection test failed');
            const detail = error instanceof Error ? error.message : 'Unknown connection error.';
            throw new Error(`Business Central connection test failed: ${detail}`);
        }
    }
    async listCompanies() {
        const requestId = crypto.randomUUID();
        const url = resolveCompaniesApiUrl(this.instance);
        let responseBody;
        let statusCode;
        try {
            if (this.instance.authType === 'SSO') {
                responseBody = await this.getViaPowerShell(url, requestId);
                statusCode = 200;
            }
            else if (this.instance.authType === 'NTLM') {
                const ntlmClient = new NtlmClient(this.instance.username, this.instance.password, '', '');
                const response = await this.withTimeout('BC company discovery', async () => await ntlmClient.request({
                    url,
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json',
                        'X-Request-ID': requestId,
                    },
                }));
                statusCode = response.statusCode;
                responseBody = response.body;
            }
            else {
                const headers = {
                    'Accept': 'application/json',
                    'X-Request-ID': requestId,
                };
                if (this.instance.authType === 'OAUTH') {
                    headers.Authorization = `Bearer ${await getOAuthToken(this.instance)}`;
                }
                else {
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
            const response = JSON.parse(responseBody);
            const values = Array.isArray(response.value) ? response.value : [];
            return values
                .filter((company) => Boolean(company) && typeof company === 'object' && typeof company.name === 'string')
                .map(company => ({
                name: String(company.name).trim(),
                ...(typeof company.displayName === 'string' && company.displayName.trim()
                    ? { displayName: company.displayName.trim() }
                    : {}),
            }))
                .filter(company => company.name.length > 0);
        }
        catch (error) {
            logger.error({ requestId, errorName: error?.name }, 'BC company discovery failed');
            const detail = error instanceof Error ? error.message : 'Unknown company discovery error.';
            throw new Error(`Business Central company discovery failed: ${detail}`);
        }
    }
    async callAction(serviceName, actionName, company, payload) {
        const url = new URL(`${serviceName}_${actionName}`, this.baseUrl);
        if (company) {
            url.searchParams.append('company', company);
        }
        logger.debug({ url: url.toString(), authType: this.instance.authType }, 'Calling BC Action');
        const requestId = crypto.randomUUID();
        const startTime = Date.now();
        try {
            let responseBody;
            let statusCode = 200;
            if (this.instance.authType === 'SSO') {
                // Use PowerShell bridge for Integrated Windows Auth (SSO)
                responseBody = await this.callViaPowerShell(url.toString(), payload, requestId);
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
            logger.debug({ service: serviceName, action: actionName, statusCode, duration, requestId }, 'BC API Call Completed');
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
    async callViaPowerShell(url, payload, requestId) {
        try {
            return await runPowerShell(SSO_POST_SCRIPT, {
                input: { uri: url, requestId, body: JSON.stringify(payload) },
                timeoutMs: this.timeoutMs,
            });
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
            // First strip all CLIXML tags to avoid fragments breaking the JSON structure
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
            if (err?.killed) {
                message = `PowerShell request timed out after ${this.timeoutMs}ms`;
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
    async testViaPowerShell(url, requestId) {
        try {
            await runPowerShell(SSO_TEST_SCRIPT, {
                input: { uri: url, requestId },
                timeoutMs: this.timeoutMs,
                maxBuffer: 1024 * 1024,
            });
        }
        catch {
            throw new Error('Business Central SSO connection test failed.');
        }
    }
    async getViaPowerShell(url, requestId) {
        try {
            return await runPowerShell(SSO_GET_SCRIPT, {
                input: { uri: url, requestId },
                timeoutMs: this.timeoutMs,
            });
        }
        catch {
            throw new Error('Business Central SSO company discovery failed.');
        }
    }
}
