import { BcClient } from '../bcClient.js';
import { invalidateOAuthToken } from '../utils/oauthProvider.js';
import { BcCompanyConfig, BcInstanceConfig, PublicInstance } from './model.js';
import { EncryptedInstanceRegistry } from './registry.js';

interface CachedClient {
    revision: string;
    client: BcClient;
}

export interface ResolvedBcClient {
    client: BcClient;
    instance: BcInstanceConfig;
    company: BcCompanyConfig;
}

export class BcClientFactory {
    private readonly clients = new Map<string, CachedClient>();

    constructor(private readonly registry: EncryptedInstanceRegistry) {}

    listInstances(): PublicInstance[] {
        return this.registry.listPublicInstances();
    }

    resolve(instanceName: string, companyName: string): ResolvedBcClient {
        const target = this.registry.getTarget(instanceName, companyName);
        const revision = target.instance.updatedAt;
        const cached = this.clients.get(target.instance.id);

        if (!cached || cached.revision !== revision) {
            if (cached) {
                invalidateOAuthToken(target.instance.id);
            }

            const client = new BcClient(target.instance);
            this.clients.set(target.instance.id, { revision, client });
            return { client, instance: target.instance, company: target.company };
        }

        return { client: cached.client, instance: target.instance, company: target.company };
    }
}