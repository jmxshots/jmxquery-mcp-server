import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
    connectionConfigSchema,
    instanceCreateSchema,
    instanceSchema,
    instanceStoreSchema,
    instanceUpdateSchema,
} from '../src/instances/model.js';

// Guards the schema behavior that changed between zod 3 and zod 4 (formats, defaults, strict objects).

const timestamp = new Date().toISOString();

test('instance create applies trimming and defaults', () => {
    const parsed = instanceCreateSchema.parse({
        name: '  Production  ',
        authType: 'BASIC',
        baseUrl: 'https://bc.example.test:7048/BC/ODataV4/',
        username: 'svc',
        password: 'secret',
        technicalCompany: ' CRONUS ',
    });
    assert.equal(parsed.name, 'Production');
    assert.equal(parsed.technicalCompany, 'CRONUS');
    assert.equal(parsed.description, '');
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.timeoutMs, 60000);
});

test('OAuth instances default the environment to Production', () => {
    const parsed = instanceCreateSchema.parse({
        name: 'SaaS', authType: 'OAUTH', tenantId: 't', clientId: 'c', clientSecret: 's', technicalCompany: 'CRONUS',
    });
    assert.equal(parsed.authType === 'OAUTH' && parsed.environment, 'Production');
});

test('stored instances accept generated ids and ISO timestamps', () => {
    const instance = {
        id: randomUUID(), name: 'SSO', description: '', enabled: true, timeoutMs: 60000,
        technicalCompany: 'CRONUS', createdAt: timestamp, updatedAt: timestamp,
        authType: 'SSO', baseUrl: 'http://bcserver:7048/BC/ODataV4/',
    };
    assert.equal(instanceSchema.safeParse(instance).success, true);
    assert.equal(instanceSchema.safeParse({ ...instance, id: 'not-a-uuid' }).success, false);
    assert.equal(instanceSchema.safeParse({ ...instance, createdAt: '2026-01-01' }).success, false);
    assert.equal(instanceStoreSchema.parse({ version: 1 }).instances.length, 0);
});

test('base URLs must be absolute URLs', () => {
    const base = { authType: 'SSO' as const };
    for (const baseUrl of ['https://bc.example.test/BC/ODataV4/', 'http://localhost:7048/BC/ODataV4']) {
        assert.equal(connectionConfigSchema.safeParse({ ...base, baseUrl }).success, true, baseUrl);
    }
    for (const baseUrl of ['not a url', '/BC/ODataV4/', '']) {
        assert.equal(connectionConfigSchema.safeParse({ ...base, baseUrl }).success, false, baseUrl);
    }
});

test('instance updates reject unknown fields and invalid values', () => {
    assert.deepEqual(instanceUpdateSchema.parse({ enabled: false, description: ' x ' }), { enabled: false, description: 'x' });
    assert.equal(instanceUpdateSchema.safeParse({ authType: 'BASIC' }).success, false);
    assert.equal(instanceUpdateSchema.safeParse({ unexpected: true }).success, false);
    assert.equal(instanceUpdateSchema.safeParse({ baseUrl: 'not a url' }).success, false);
    assert.equal(instanceUpdateSchema.safeParse({ timeoutMs: 0 }).success, false);
    assert.equal(instanceUpdateSchema.safeParse({ timeoutMs: 1.5 }).success, false);
});
