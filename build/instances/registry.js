import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmptyStore, instanceCreateSchema, instanceSchema, instanceStoreSchema, instanceUpdateSchema, toPublicInstance, } from './model.js';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_DERIVATION_SALT = 'jmxquery-mcp-instance-store-v1';
const LEGACY_TECHNICAL_COMPANY = 'Not configured';
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Adds fields introduced after version 1 stores were first persisted. */
export const migrateLegacyInstanceStore = (store) => {
    if (!isRecord(store) || !Array.isArray(store.instances)) {
        return store;
    }
    let migrated = false;
    const instances = store.instances.map(instance => {
        if (!isRecord(instance) || instance.technicalCompany !== undefined) {
            return instance;
        }
        migrated = true;
        return {
            ...instance,
            technicalCompany: LEGACY_TECHNICAL_COMPANY,
            enabled: false,
        };
    });
    return migrated ? { ...store, instances } : store;
};
export class EncryptedInstanceRegistry {
    filePath;
    store = createEmptyStore();
    isLoaded = false;
    writeQueue = Promise.resolve();
    encryptionKey;
    constructor(filePath, masterKey) {
        this.filePath = filePath;
        if (masterKey.trim().length < 32) {
            throw new Error('INSTANCE_MASTER_KEY must contain at least 32 characters.');
        }
        this.encryptionKey = scryptSync(masterKey, KEY_DERIVATION_SALT, 32);
    }
    async load() {
        if (this.isLoaded) {
            return;
        }
        try {
            const content = await readFile(this.filePath, 'utf8');
            const decryptedStore = this.decrypt(content);
            const migratedStore = migrateLegacyInstanceStore(decryptedStore);
            this.store = instanceStoreSchema.parse(migratedStore);
            if (migratedStore !== decryptedStore) {
                await this.persist();
            }
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                throw new Error(`Failed to load the instance store: ${error?.message || String(error)}`);
            }
        }
        this.assertUniqueNames(this.store);
        this.isLoaded = true;
    }
    listPublicInstances() {
        this.assertLoaded();
        return this.store.instances.map(toPublicInstance);
    }
    async createInstance(input) {
        this.assertLoaded();
        const value = instanceCreateSchema.parse(input);
        this.assertInstanceNameAvailable(value.name);
        const timestamp = new Date().toISOString();
        const instance = instanceSchema.parse({
            ...value,
            id: randomUUID(),
            createdAt: timestamp,
            updatedAt: timestamp,
        });
        this.store.instances.push(instance);
        await this.persist();
        return toPublicInstance(instance);
    }
    async updateInstance(instanceName, input) {
        this.assertLoaded();
        const existing = this.getInstance(instanceName);
        const value = instanceUpdateSchema.parse(input);
        this.assertCompatibleInstanceUpdate(existing, value);
        const updated = instanceSchema.parse({
            ...existing,
            ...value,
            updatedAt: new Date().toISOString(),
        });
        this.replaceInstance(existing.id, updated);
        await this.persist();
        return toPublicInstance(updated);
    }
    async deleteInstance(instanceName) {
        this.assertLoaded();
        const instance = this.getInstance(instanceName);
        this.store.instances = this.store.instances.filter(candidate => candidate.id !== instance.id);
        await this.persist();
    }
    async setInstanceEnabled(instanceName, enabled) {
        if (typeof enabled !== 'boolean') {
            throw new Error("'enabled' must be a boolean.");
        }
        return this.updateInstance(instanceName, { enabled });
    }
    getSecret(instanceName, field) {
        this.assertLoaded();
        if (field !== 'password' && field !== 'clientSecret') {
            throw new Error('Only password and clientSecret can be revealed.');
        }
        const instance = this.getInstance(instanceName);
        const secret = instance[field];
        if (!secret) {
            throw new Error(`Secret field '${field}' is not configured for instance '${instanceName}'.`);
        }
        return secret;
    }
    getEnabledInstance(instanceName) {
        this.assertLoaded();
        const instance = this.getInstance(instanceName);
        if (!instance.enabled) {
            throw new Error(`Instance '${instanceName}' is disabled.`);
        }
        return instance;
    }
    async replaceStore(store) {
        this.assertLoaded();
        const parsed = instanceStoreSchema.parse(store);
        this.assertUniqueNames(parsed);
        this.store = parsed;
        await this.persist();
    }
    assertLoaded() {
        if (!this.isLoaded) {
            throw new Error('The instance registry has not been loaded.');
        }
    }
    getInstance(instanceName) {
        const instance = this.store.instances.find(candidate => candidate.name === instanceName);
        if (!instance) {
            throw new Error(`Instance '${instanceName}' was not found.`);
        }
        return instance;
    }
    assertInstanceNameAvailable(instanceName) {
        if (this.store.instances.some(candidate => candidate.name === instanceName)) {
            throw new Error(`Instance '${instanceName}' already exists.`);
        }
    }
    assertCompatibleInstanceUpdate(instance, update) {
        const commonFields = new Set(['description', 'enabled', 'timeoutMs']);
        const specificFields = {
            BASIC: new Set(['baseUrl', 'username', 'password', 'technicalCompany']),
            NTLM: new Set(['baseUrl', 'username', 'password', 'technicalCompany']),
            SSO: new Set(['baseUrl', 'technicalCompany']),
            OAUTH: new Set(['tenantId', 'clientId', 'clientSecret', 'environment', 'technicalCompany']),
        };
        for (const field of Object.keys(update)) {
            if (!commonFields.has(field) && !specificFields[instance.authType].has(field)) {
                throw new Error(`Field '${field}' is not valid for ${instance.authType} authentication.`);
            }
        }
    }
    replaceInstance(instanceId, updated) {
        this.store.instances = this.store.instances.map(candidate => candidate.id === instanceId ? updated : candidate);
    }
    assertUniqueNames(store) {
        const instanceNames = new Set();
        for (const instance of store.instances) {
            if (instanceNames.has(instance.name)) {
                throw new Error(`Duplicate instance name '${instance.name}'.`);
            }
            instanceNames.add(instance.name);
        }
    }
    async persist() {
        const serializedStore = JSON.stringify(this.store);
        this.writeQueue = this.writeQueue.then(async () => {
            await mkdir(path.dirname(this.filePath), { recursive: true });
            const temporaryPath = path.join(path.dirname(this.filePath), `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
            try {
                await writeFile(temporaryPath, this.encrypt(serializedStore), { encoding: 'utf8', mode: 0o600 });
                await rename(temporaryPath, this.filePath);
            }
            finally {
                await unlink(temporaryPath).catch(() => undefined);
            }
        });
        await this.writeQueue;
    }
    encrypt(plaintext) {
        const iv = randomBytes(12);
        const cipher = createCipheriv(ENCRYPTION_ALGORITHM, this.encryptionKey, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const envelope = {
            version: 1,
            iv: iv.toString('base64'),
            authTag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
        };
        return JSON.stringify(envelope);
    }
    decrypt(encryptedContent) {
        let envelope;
        try {
            envelope = JSON.parse(encryptedContent);
        }
        catch {
            throw new Error('The instance store is not valid JSON.');
        }
        if (envelope.version !== 1 || !envelope.iv || !envelope.authTag || !envelope.ciphertext) {
            throw new Error('The instance store has an unsupported encryption format.');
        }
        try {
            const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, this.encryptionKey, Buffer.from(envelope.iv, 'base64'));
            decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
            const plaintext = Buffer.concat([
                decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
                decipher.final(),
            ]).toString('utf8');
            return JSON.parse(plaintext);
        }
        catch {
            throw new Error('Unable to decrypt the instance store. Check INSTANCE_MASTER_KEY and file integrity.');
        }
    }
}
