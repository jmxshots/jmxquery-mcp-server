import { BcClient } from '../bcClient.js';
import { invalidateOAuthToken } from '../utils/oauthProvider.js';
export class BcClientFactory {
    registry;
    clients = new Map();
    constructor(registry) {
        this.registry = registry;
    }
    listInstances() {
        return this.registry.listPublicInstances();
    }
    resolveEnabledInstance(instanceName) {
        const instance = this.registry.getEnabledInstance(instanceName);
        return { client: this.getClient(instance), instance };
    }
    getClient(instance) {
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
