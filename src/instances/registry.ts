import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    BcInstanceConfig,
    createEmptyStore,
    instanceCreateSchema,
    InstanceStore,
    instanceSchema,
    instanceStoreSchema,
    instanceUpdateSchema,
    PublicInstance,
    toPublicInstance,
} from './model.js';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_DERIVATION_SALT = 'jmxquery-mcp-instance-store-v1';

interface EncryptedStoreEnvelope {
    version: 1;
    iv: string;
    authTag: string;
    ciphertext: string;
}

export type SecretField = 'password' | 'clientSecret';

const LEGACY_TECHNICAL_COMPANY = 'Not configured';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Adds fields introduced after version 1 stores were first persisted. */
export const migrateLegacyInstanceStore = (store: unknown): unknown => {
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
    private store: InstanceStore = createEmptyStore();
    private isLoaded = false;
    private writeQueue: Promise<void> = Promise.resolve();
    private readonly encryptionKey: Buffer;

    constructor(
        private readonly filePath: string,
        masterKey: string,
    ) {
        if (masterKey.trim().length < 32) {
            throw new Error('INSTANCE_MASTER_KEY must contain at least 32 characters.');
        }

        this.encryptionKey = scryptSync(masterKey, KEY_DERIVATION_SALT, 32);
    }

    async load(): Promise<void> {
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
        } catch (error: any) {
            if (error?.code !== 'ENOENT') {
                throw new Error(`Failed to load the instance store: ${error?.message || String(error)}`);
            }
        }

        this.assertUniqueNames(this.store);
        this.isLoaded = true;
    }

    listPublicInstances(): PublicInstance[] {
        this.assertLoaded();
        return this.store.instances.map(toPublicInstance);
    }

    async createInstance(input: unknown): Promise<PublicInstance> {
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

    async updateInstance(instanceName: string, input: unknown): Promise<PublicInstance> {
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

    async deleteInstance(instanceName: string): Promise<void> {
        this.assertLoaded();
        const instance = this.getInstance(instanceName);
        this.store.instances = this.store.instances.filter(candidate => candidate.id !== instance.id);
        await this.persist();
    }

    async setInstanceEnabled(instanceName: string, enabled: boolean): Promise<PublicInstance> {
        if (typeof enabled !== 'boolean') {
            throw new Error("'enabled' must be a boolean.");
        }
        return this.updateInstance(instanceName, { enabled });
    }

    getSecret(instanceName: string, field: SecretField): string {
        this.assertLoaded();
        if (field !== 'password' && field !== 'clientSecret') {
            throw new Error('Only password and clientSecret can be revealed.');
        }
        const instance = this.getInstance(instanceName) as BcInstanceConfig & Partial<Record<SecretField, string>>;
        const secret = instance[field];
        if (!secret) {
            throw new Error(`Secret field '${field}' is not configured for instance '${instanceName}'.`);
        }
        return secret;
    }

    getEnabledInstance(instanceName: string): BcInstanceConfig {
        this.assertLoaded();
        const instance = this.getInstance(instanceName);
        if (!instance.enabled) {
            throw new Error(`Instance '${instanceName}' is disabled.`);
        }
        return instance;
    }

    async replaceStore(store: InstanceStore): Promise<void> {
        this.assertLoaded();
        const parsed = instanceStoreSchema.parse(store);
        this.assertUniqueNames(parsed);
        this.store = parsed;
        await this.persist();
    }

    private assertLoaded(): void {
        if (!this.isLoaded) {
            throw new Error('The instance registry has not been loaded.');
        }
    }

    private getInstance(instanceName: string): BcInstanceConfig {
        const instance = this.store.instances.find(candidate => candidate.name === instanceName);
        if (!instance) {
            throw new Error(`Instance '${instanceName}' was not found.`);
        }
        return instance;
    }

    private assertInstanceNameAvailable(instanceName: string): void {
        if (this.store.instances.some(candidate => candidate.name === instanceName)) {
            throw new Error(`Instance '${instanceName}' already exists.`);
        }
    }

    private assertCompatibleInstanceUpdate(instance: BcInstanceConfig, update: Record<string, unknown>): void {
        const commonFields = new Set(['description', 'enabled', 'timeoutMs']);
        const specificFields: Record<BcInstanceConfig['authType'], Set<string>> = {
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

    private replaceInstance(instanceId: string, updated: BcInstanceConfig): void {
        this.store.instances = this.store.instances.map(candidate => candidate.id === instanceId ? updated : candidate);
    }

    private assertUniqueNames(store: InstanceStore): void {
        const instanceNames = new Set<string>();
        for (const instance of store.instances) {
            if (instanceNames.has(instance.name)) {
                throw new Error(`Duplicate instance name '${instance.name}'.`);
            }
            instanceNames.add(instance.name);

        }
    }

    private async persist(): Promise<void> {
        const serializedStore = JSON.stringify(this.store);
        this.writeQueue = this.writeQueue.then(async () => {
            await mkdir(path.dirname(this.filePath), { recursive: true });
            const temporaryPath = path.join(
                path.dirname(this.filePath),
                `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
            );

            try {
                await writeFile(temporaryPath, this.encrypt(serializedStore), { encoding: 'utf8', mode: 0o600 });
                await rename(temporaryPath, this.filePath);
            } finally {
                await unlink(temporaryPath).catch(() => undefined);
            }
        });

        await this.writeQueue;
    }

    private encrypt(plaintext: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv(ENCRYPTION_ALGORITHM, this.encryptionKey, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const envelope: EncryptedStoreEnvelope = {
            version: 1,
            iv: iv.toString('base64'),
            authTag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
        };

        return JSON.stringify(envelope);
    }

    private decrypt(encryptedContent: string): unknown {
        let envelope: EncryptedStoreEnvelope;
        try {
            envelope = JSON.parse(encryptedContent) as EncryptedStoreEnvelope;
        } catch {
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
        } catch {
            throw new Error('Unable to decrypt the instance store. Check INSTANCE_MASTER_KEY and file integrity.');
        }
    }
}