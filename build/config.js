import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();
const configSchema = z.object({
    BC_ODATA_BASE_URL: z.string().url().transform(url => url.endsWith('/') ? url : `${url}/`),
    BC_COMPANY: z.string(),
    BC_AUTH_TYPE: z.enum(['BASIC', 'NTLM', 'SSO']).default('BASIC'),
    BC_USERNAME: z.string().optional(),
    BC_PASSWORD: z.string().optional(),
    JMXQ_EXECUTION_CONTEXT_CODE: z.string().default('DEFAULT'),
    MCP_HOST: z.string().default('127.0.0.1'),
    MCP_PORT: z.coerce.number().default(3000),
    MCP_STREAMABLE_PORT: z.coerce.number().optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    HTTP_TIMEOUT_MS: z.coerce.number().default(60000),
    MCP_API_KEY: z.string().optional(),
});
export const config = configSchema.parse({
    BC_ODATA_BASE_URL: process.env.BC_ODATA_BASE_URL,
    BC_COMPANY: process.env.BC_COMPANY,
    BC_AUTH_TYPE: process.env.BC_AUTH_TYPE,
    BC_USERNAME: process.env.BC_USERNAME,
    BC_PASSWORD: process.env.BC_PASSWORD,
    JMXQ_EXECUTION_CONTEXT_CODE: process.env.JMXQ_EXECUTION_CONTEXT_CODE,
    MCP_HOST: process.env.MCP_HOST,
    MCP_PORT: process.env.MCP_PORT,
    MCP_STREAMABLE_PORT: process.env.MCP_STREAMABLE_PORT,
    LOG_LEVEL: process.env.LOG_LEVEL,
    HTTP_TIMEOUT_MS: process.env.HTTP_TIMEOUT_MS,
    MCP_API_KEY: process.env.MCP_API_KEY,
});
