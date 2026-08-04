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
    resolve(instanceName, companyName) {
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
