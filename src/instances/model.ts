import { z } from 'zod';

const idSchema = z.string().uuid();
const nameSchema = z.string().trim().min(1).max(100);
const isoDateSchema = z.string().datetime();

const companySchema = z.object({
    id: idSchema,
    name: nameSchema,
    company: z.string().trim().min(1).max(250),
    executionContextCode: z.string().trim().min(1).max(100).default('DEFAULT'),
    enabled: z.boolean().default(true),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
});

const baseInstanceFields = {
    id: idSchema,
    name: nameSchema,
    description: z.string().trim().max(500).default(''),
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().max(300000).default(60000),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
    companies: z.array(companySchema).default([]),
};

export const basicInstanceSchema = z.object({
    ...baseInstanceFields,
    authType: z.literal('BASIC'),
    baseUrl: z.string().url(),
    username: z.string().min(1),
    password: z.string().min(1),
});

export const ntlmInstanceSchema = z.object({
    ...baseInstanceFields,
    authType: z.literal('NTLM'),
    baseUrl: z.string().url(),
    username: z.string().min(1),
    password: z.string().min(1),
});

export const ssoInstanceSchema = z.object({
    ...baseInstanceFields,
    authType: z.literal('SSO'),
    baseUrl: z.string().url(),
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
});

export const instanceCreateSchema = z.discriminatedUnion('authType', [
    createInstanceBaseSchema.extend({
        authType: z.literal('BASIC'),
        baseUrl: z.string().url(),
        username: z.string().min(1),
        password: z.string().min(1),
    }),
    createInstanceBaseSchema.extend({
        authType: z.literal('NTLM'),
        baseUrl: z.string().url(),
        username: z.string().min(1),
        password: z.string().min(1),
    }),
    createInstanceBaseSchema.extend({
        authType: z.literal('SSO'),
        baseUrl: z.string().url(),
    }),
    createInstanceBaseSchema.extend({
        authType: z.literal('OAUTH'),
        tenantId: z.string().trim().min(1),
        clientId: z.string().trim().min(1),
        clientSecret: z.string().min(1),
        environment: z.string().trim().min(1).default('Production'),
    }),
]);

export const instanceUpdateSchema = z.object({
    description: z.string().trim().max(500).optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(300000).optional(),
    baseUrl: z.string().url().optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    tenantId: z.string().trim().min(1).optional(),
    clientId: z.string().trim().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    environment: z.string().trim().min(1).optional(),
}).strict();

export const companyCreateSchema = z.object({
    name: nameSchema,
    company: z.string().trim().min(1).max(250),
    executionContextCode: z.string().trim().min(1).max(100).default('DEFAULT'),
    enabled: z.boolean().default(true),
}).strict();

export const companyUpdateSchema = z.object({
    company: z.string().trim().min(1).max(250).optional(),
    executionContextCode: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
}).strict();

export const instanceStoreSchema = z.object({
    version: z.literal(1),
    instances: z.array(instanceSchema).default([]),
});

export type BcCompanyConfig = z.infer<typeof companySchema>;
export type BcInstanceConfig = z.infer<typeof instanceSchema>;
export type InstanceStore = z.infer<typeof instanceStoreSchema>;
export type InstanceCreateInput = z.infer<typeof instanceCreateSchema>;
export type InstanceUpdateInput = z.infer<typeof instanceUpdateSchema>;
export type CompanyCreateInput = z.infer<typeof companyCreateSchema>;
export type CompanyUpdateInput = z.infer<typeof companyUpdateSchema>;

export type PublicCompany = Omit<BcCompanyConfig, 'company'> & {
    company: string;
};

export type PublicInstance = Omit<BcInstanceConfig, 'password' | 'clientSecret' | 'companies'> & {
    companies: PublicCompany[];
    hasPassword?: boolean;
    hasClientSecret?: boolean;
};

export const toPublicInstance = (instance: BcInstanceConfig): PublicInstance => {
    const { password, clientSecret, ...publicInstance } = instance as BcInstanceConfig & {
        password?: string;
        clientSecret?: string;
    };

    return {
        ...publicInstance,
        ...(password ? { hasPassword: true } : {}),
        ...(clientSecret ? { hasClientSecret: true } : {}),
    };
};

export const createEmptyStore = (): InstanceStore => ({
    version: 1,
    instances: [],
});