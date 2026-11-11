import { z } from 'zod';
const idSchema = z.uuid();
const nameSchema = z.string().trim().min(1).max(100);
const isoDateSchema = z.iso.datetime();
const urlSchema = z.url();
const baseInstanceFields = {
    id: idSchema,
    name: nameSchema,
    description: z.string().trim().max(500).default(''),
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().max(300000).default(60000),
    technicalCompany: z.string().trim().min(1).max(250),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
};
export const basicInstanceSchema = z.object({
    ...baseInstanceFields,
    authType: z.literal('BASIC'),
    baseUrl: urlSchema,
    username: z.string().min(1),
    password: z.string().min(1),
});
export const ntlmInstanceSchema = z.object({
    ...baseInstanceFields,
    authType: z.literal('NTLM'),
    baseUrl: urlSchema,
    username: z.string().min(1),
    password: z.string().min(1),
});
export const ssoInstanceSchema = z.object({
    ...baseInstanceFields,
    authType: z.literal('SSO'),
    baseUrl: urlSchema,
});
export const oauthInstanceSchema = z.object({
    ...baseInstanceFields,
    authType: z.literal('OAUTH'),
    tenantId: z.string().trim().min(1),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().min(1),
    environment: z.string().trim().min(1).default('Production'),
});
export const instanceSchema = z.discriminatedUnion('authType', [
    basicInstanceSchema,
    ntlmInstanceSchema,
    ssoInstanceSchema,
    oauthInstanceSchema,
]);
const createInstanceBaseSchema = z.object({
    name: nameSchema,
    description: z.string().trim().max(500).default(''),
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().max(300000).default(60000),
    technicalCompany: z.string().trim().min(1).max(250),
});
const connectionConfigBaseSchema = z.object({
    timeoutMs: z.number().int().positive().max(300000).default(60000),
});
/** Connection data accepted by the Admin GUI before an Instance is persisted. */
export const connectionConfigSchema = z.discriminatedUnion('authType', [
    connectionConfigBaseSchema.extend({
        authType: z.literal('BASIC'),
        baseUrl: urlSchema,
        username: z.string().min(1),
        password: z.string().min(1),
    }),
    connectionConfigBaseSchema.extend({
        authType: z.literal('NTLM'),
        baseUrl: urlSchema,
        username: z.string().min(1),
        password: z.string().min(1),
    }),
    connectionConfigBaseSchema.extend({
        authType: z.literal('SSO'),
        baseUrl: urlSchema,
    }),
    connectionConfigBaseSchema.extend({
        authType: z.literal('OAUTH'),
        tenantId: z.string().trim().min(1),
        clientId: z.string().trim().min(1),
        clientSecret: z.string().min(1),
        environment: z.string().trim().min(1).default('Production'),
    }),
]);
export const instanceCreateSchema = z.discriminatedUnion('authType', [
    createInstanceBaseSchema.extend({
        authType: z.literal('BASIC'),
        baseUrl: urlSchema,
        username: z.string().min(1),
        password: z.string().min(1),
    }),
    createInstanceBaseSchema.extend({
        authType: z.literal('NTLM'),
        baseUrl: urlSchema,
        username: z.string().min(1),
        password: z.string().min(1),
    }),
    createInstanceBaseSchema.extend({
        authType: z.literal('SSO'),
        baseUrl: urlSchema,
    }),
    createInstanceBaseSchema.extend({
        authType: z.literal('OAUTH'),
        tenantId: z.string().trim().min(1),
        clientId: z.string().trim().min(1),
        clientSecret: z.string().min(1),
        environment: z.string().trim().min(1).default('Production'),
    }),
]);
export const instanceUpdateSchema = z.strictObject({
    description: z.string().trim().max(500).optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(300000).optional(),
    technicalCompany: z.string().trim().min(1).max(250).optional(),
    baseUrl: urlSchema.optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    tenantId: z.string().trim().min(1).optional(),
    clientId: z.string().trim().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    environment: z.string().trim().min(1).optional(),
});
export const instanceStoreSchema = z.object({
    version: z.literal(1),
    instances: z.array(instanceSchema).default([]),
});
export const toPublicInstance = (instance) => {
    const { password, clientSecret, ...publicInstance } = instance;
    return {
        ...publicInstance,
        ...(password ? { hasPassword: true } : {}),
        ...(clientSecret ? { hasClientSecret: true } : {}),
    };
};
export const createEmptyStore = () => ({
    version: 1,
    instances: [],
});
