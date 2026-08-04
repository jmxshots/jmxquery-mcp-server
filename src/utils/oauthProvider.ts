import { ClientSecretCredential } from '@azure/identity';
import { BcInstanceConfig } from '../instances/model.js';

const BC_OAUTH_SCOPE = 'https://api.businesscentral.dynamics.com/.default';
type OAuthInstanceConfig = Extract<BcInstanceConfig, { authType: 'OAUTH' }>;

const credentials = new Map<string, ClientSecretCredential>();

function getCredential(instance: OAuthInstanceConfig): ClientSecretCredential {
    let credential = credentials.get(instance.id);
    if (!credential) {
        credential = new ClientSecretCredential(
            instance.tenantId,
            instance.clientId,
            instance.clientSecret,
        );
        credentials.set(instance.id, credential);
    }
    return credential;
}

/**
 * Returns a valid Bearer token for one Business Central SaaS instance.
 * @azure/identity handles caching and proactive refresh automatically.
 */
export async function getOAuthToken(instance: OAuthInstanceConfig): Promise<string> {
    const tokenResponse = await getCredential(instance).getToken(BC_OAUTH_SCOPE);
    if (!tokenResponse?.token) {
        throw new Error('Failed to acquire OAuth token from Azure AD');
    }
    return tokenResponse.token;
}

export function invalidateOAuthToken(instanceId?: string): void {
    if (instanceId) {
        credentials.delete(instanceId);
        return;
    }

    credentials.clear();
}
