import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || undefined });

const normalizeUrl = (url: string) => url.endsWith('/') ? url : `${url}/`;

const normalizeCorsOrigin = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Browser Origin headers are scheme + host + optional port (no path, no trailing slash)
    // Normalize config values so copied URLs like "https://host/" or "https://host/some/path"
    // still match the Origin header.
    try {
        return new URL(trimmed).origin;
    } catch {
        return trimmed.replace(/\/+$/, '');
    }
};

const parseCorsOrigins = (value: string) => value
    .split(',')
    .map(normalizeCorsOrigin)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);

const configSchema = z.object({
    BC_ODATA_BASE_URL: z.string().url().transform(normalizeUrl).optional(),
    BC_COMPANY: z.string(),
    BC_AUTH_TYPE: z.enum(['BASIC', 'NTLM', 'SSO', 'OAUTH']).default('BASIC'),
    BC_USERNAME: z.string().optional(),
    BC_PASSWORD: z.string().optional(),
    // OAuth / SaaS fields
    BC_TENANT_ID: z.string().optional(),
    BC_CLIENT_ID: z.string().optional(),
    BC_CLIENT_SECRET: z.string().optional(),
    BC_ENVIRONMENT: z.string().optional(),
    JMXQ_EXECUTION_CONTEXT_CODE: z.string().default('DEFAULT'),
    MCP_HOST: z.string().default('127.0.0.1'),
    MCP_PORT: z.coerce.number().default(5000),
    MCP_STREAMABLE_PORT: z.coerce.number().optional(),
    MCP_CORS_ORIGINS: z.string().default('http://127.0.0.1:5173,http://localhost:5173'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    HTTP_TIMEOUT_MS: z.coerce.number().default(60000),
    MCP_API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

const rawConfig = configSchema.parse({
    BC_ODATA_BASE_URL: process.env.BC_ODATA_BASE_URL,
    BC_COMPANY: process.env.BC_COMPANY,
    BC_AUTH_TYPE: process.env.BC_AUTH_TYPE,
    BC_USERNAME: process.env.BC_USERNAME,
    BC_PASSWORD: process.env.BC_PASSWORD,
    BC_TENANT_ID: process.env.BC_TENANT_ID,
    BC_CLIENT_ID: process.env.BC_CLIENT_ID,
    BC_CLIENT_SECRET: process.env.BC_CLIENT_SECRET,
    BC_ENVIRONMENT: process.env.BC_ENVIRONMENT,
    JMXQ_EXECUTION_CONTEXT_CODE: process.env.JMXQ_EXECUTION_CONTEXT_CODE,
    MCP_HOST: process.env.MCP_HOST,
    MCP_PORT: process.env.MCP_PORT,
    MCP_STREAMABLE_PORT: process.env.MCP_STREAMABLE_PORT,
    MCP_CORS_ORIGINS: process.env.MCP_CORS_ORIGINS,
    LOG_LEVEL: process.env.LOG_LEVEL,
    HTTP_TIMEOUT_MS: process.env.HTTP_TIMEOUT_MS,
    MCP_API_KEY: process.env.MCP_API_KEY,
});

// Validate OAUTH fields and compute resolvedBaseUrl
if (rawConfig.BC_AUTH_TYPE === 'OAUTH') {
    const missing = (['BC_TENANT_ID', 'BC_CLIENT_ID', 'BC_CLIENT_SECRET'] as const)
        .filter(key => !rawConfig[key]);
    if (missing.length > 0) {
        throw new Error(
            `BC_AUTH_TYPE=OAUTH requires the following env vars to be set: ${missing.join(', ')}`
        );
    }
} else {
    if (!rawConfig.BC_ODATA_BASE_URL) {
        throw new Error('BC_ODATA_BASE_URL is required when BC_AUTH_TYPE is not OAUTH');
    }
}

function buildResolvedBaseUrl(cfg: typeof rawConfig): string {
    if (cfg.BC_ODATA_BASE_URL) {
        return cfg.BC_ODATA_BASE_URL;
    }
    // Auto-construct SaaS URL from tenant + environment
    const env = cfg.BC_ENVIRONMENT || 'Production';
    return `https://api.businesscentral.dynamics.com/v2.0/${cfg.BC_TENANT_ID}/${env}/ODataV4/`;
}

export const config = {
    ...rawConfig,
    /** Resolved OData base URL — use this instead of BC_ODATA_BASE_URL directly. */
    resolvedBaseUrl: buildResolvedBaseUrl(rawConfig),
    /** Parsed CORS allowlist for browser-originated requests. */
    resolvedCorsOrigins: parseCorsOrigins(rawConfig.MCP_CORS_ORIGINS),
};
