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

export interface ResolvedBcInstanceClient {
    client: BcClient;
    instance: BcInstanceConfig;
}

export class BcClientFactory {
    private readonly clients = new Map<string, CachedClient>();

    constructor(private readonly registry: EncryptedInstanceRegistry) {}

    listInstances(): PublicInstance[] {
        return this.registry.listPublicInstances();
    }

    resolve(instanceName: string, companyName: string): ResolvedBcClient {
        const target = this.registry.getTarget(instanceName, companyName);
        return {
            client: this.getClient(target.instance),
            instance: target.instance,
            company: target.company,
        };
    }

    resolveEnabledInstance(instanceName: string): ResolvedBcInstanceClient {
        const instance = this.registry.getEnabledInstance(instanceName);
        return { client: this.getClient(instance), instance };
    }

    private getClient(instance: BcInstanceConfig): BcClient {
        const revision = instance.updatedAt;
        const cached = this.clients.get(instance.id);

        if (!cached || cached.revision !== revision) {
            if (cached) {
                invalidateOAuthToken(instance.id);
            }

            const client = new BcClient(instance);
            this.clients.set(instance.id, { revision, client });
            return client;
        }

        return cached.client;
    }
}