import { request } from 'undici';
import { pino } from 'pino';
import { config } from './config.js';
import { execSync } from 'child_process';
// @ts-ignore
import { NtlmClient } from 'node-client-ntlm';

const logger = pino({
    level: config.LOG_LEVEL,
});

export class BcClient {
    private readonly baseUrl: string;

    constructor() {
        this.baseUrl = config.BC_ODATA_BASE_URL;
    }

    async callAction<T = any>(serviceName: string, actionName: string, payload: Record<string, any>): Promise<T> {
        const url = new URL(`${serviceName}_${actionName}`, this.baseUrl);
        url.searchParams.append('company', config.BC_COMPANY);

        logger.debug({ url: url.toString(), authType: config.BC_AUTH_TYPE }, 'Calling BC Action');

        const requestId = crypto.randomUUID();
        const startTime = Date.now();

        try {
            let responseBody: string;
            let statusCode: number = 200;

            if (config.BC_AUTH_TYPE === 'SSO') {
                // Use PowerShell bridge for Integrated Windows Auth (SSO)
                responseBody = this.callViaPowerShell(url.toString(), payload, requestId);
            } else if (config.BC_AUTH_TYPE === 'NTLM') {
                // Use node-client-ntlm for NTLM
                const ntlmClient = new NtlmClient(
                    config.BC_USERNAME || '',
                    config.BC_PASSWORD || '',
                    '', // workstation
                    ''  // domain
                );
                const response = await ntlmClient.request({
                    uri: url.toString(),
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-Request-ID': requestId,
                    },
                    body: JSON.stringify(payload)
                });
                statusCode = response.statusCode;
                responseBody = response.body;
            } else {
                // Default: BASIC via undici
                const credentials = Buffer.from(`${config.BC_USERNAME}:${config.BC_PASSWORD}`).toString('base64');
                const { statusCode: sc, body } = await request(url.toString(), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'Authorization': `Basic ${credentials}`,
                        'X-Request-ID': requestId,
                    },
                    body: JSON.stringify(payload),
                });
                statusCode = sc;
                responseBody = await body.text();
            }

            const duration = Date.now() - startTime;
            logger.info({ service: serviceName, action: actionName, statusCode, duration, requestId }, 'BC API Call Completed');

            if (statusCode >= 400) {
                logger.error({ responseBody, statusCode, requestId }, 'BC API Error');
                throw new Error(`BC API Error (${statusCode}): ${responseBody}`);
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
        } catch (error) {
            logger.error({ error, requestId }, 'BC Client Exception');
            throw error;
        }
    }

    private callViaPowerShell(url: string, payload: any, requestId: string): string {
        const jsonPayload = JSON.stringify(payload);

        // Construct PowerShell script
        // Note: No need for manual escaping of quotes here because it's Base64 encoded
        const psScript = `
            $ProgressPreference = 'SilentlyContinue';
            $headers = @{ 
                "Accept" = "application/json"; 
                "X-Request-ID" = "${requestId}" 
            };
            $body = '${jsonPayload.replace(/'/g, "''")}';
            $response = Invoke-RestMethod -Uri "${url}" -Method Post -Body $body -ContentType "application/json" -UseDefaultCredentials -Headers $headers;
            if ($null -eq $response) { return "" }
            $response | ConvertTo-Json -Depth 10 -Compress;
        `.trim();

        // PowerShell -EncodedCommand expects UTF-16LE Base64
        const scriptBuffer = Buffer.from(psScript, 'utf16le');
        const base64Script = scriptBuffer.toString('base64');

        try {
            const output = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${base64Script}`, {
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large responses
            });
            return output.trim();
        } catch (err: any) {
            logger.error({ err, script: psScript }, 'PowerShell Execution Failed');
            throw new Error(`PowerShell SSO Error: ${err.message}`);
        }
    }
}

export const bcClient = new BcClient();
