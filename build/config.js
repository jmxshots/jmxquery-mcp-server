import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || undefined });
const normalizeCorsOrigin = (value) => {
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    // Browser Origin headers are scheme + host + optional port (no path, no trailing slash)
    // Normalize config values so copied URLs like "https://host/" or "https://host/some/path"
    // still match the Origin header.
    try {
        return new URL(trimmed).origin;
    }
    catch {
        return trimmed.replace(/\/+$/, '');
    }
};
const parseCorsOrigins = (value) => value
    .split(',')
    .map(normalizeCorsOrigin)
    .filter((v) => typeof v === 'string' && v.length > 0);
const configSchema = z.object({
    MCP_HOST: z.string().default('127.0.0.1'),
    MCP_PORT: z.coerce.number().default(5000),
    MCP_STREAMABLE_PORT: z.coerce.number().optional(),
    MCP_CORS_ORIGINS: z.string().default('http://127.0.0.1:5173,http://localhost:5173'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    MCP_API_KEY: z.string().optional(),
    ADMIN_API_KEY: z.string().optional(),
    ADMIN_API_ENABLED: z.string().optional().transform(value => value?.toLowerCase() === 'true'),
    INSTANCE_MASTER_KEY: z.string().min(32),
    INSTANCE_STORE_PATH: z.string().default('./data/instances.enc'),
    LOG_DIR: z.string().default('./logs'),
    LOG_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),
    LOG_SCRIPT_MAX_LENGTH: z.coerce.number().int().positive().max(100000).default(4000),
});
const rawConfig = configSchema.parse({
    MCP_HOST: process.env.MCP_HOST,
    MCP_PORT: process.env.MCP_PORT,
    MCP_STREAMABLE_PORT: process.env.MCP_STREAMABLE_PORT,
    MCP_CORS_ORIGINS: process.env.MCP_CORS_ORIGINS,
    LOG_LEVEL: process.env.LOG_LEVEL,
    MCP_API_KEY: process.env.MCP_API_KEY,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
    ADMIN_API_ENABLED: process.env.ADMIN_API_ENABLED,
    INSTANCE_MASTER_KEY: process.env.INSTANCE_MASTER_KEY,
    INSTANCE_STORE_PATH: process.env.INSTANCE_STORE_PATH,
    LOG_DIR: process.env.LOG_DIR,
    LOG_RETENTION_DAYS: process.env.LOG_RETENTION_DAYS,
    LOG_SCRIPT_MAX_LENGTH: process.env.LOG_SCRIPT_MAX_LENGTH,
});
export const config = {
    ...rawConfig,
    /** Parsed CORS allowlist for browser-originated requests. */
    resolvedCorsOrigins: parseCorsOrigins(rawConfig.MCP_CORS_ORIGINS),
};
