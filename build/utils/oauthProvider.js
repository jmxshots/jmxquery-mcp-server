import { ClientSecretCredential } from '@azure/identity';
const BC_OAUTH_SCOPE = 'https://api.businesscentral.dynamics.com/.default';
const credentials = new Map();
function getCredential(instance) {
    let credential = credentials.get(instance.id);
    if (!credential) {
        credential = new ClientSecretCredential(instance.tenantId, instance.clientId, instance.clientSecret);
        credentials.set(instance.id, credential);
    }
    return credential;
}
/**
 * Returns a valid Bearer token for one Business Central SaaS instance.
 * @azure/identity handles caching and proactive refresh automatically.
 */
export async function getOAuthToken(instance) {
    const tokenResponse = await getCredential(instance).getToken(BC_OAUTH_SCOPE);
    if (!tokenResponse?.token) {
        throw new Error('Failed to acquire OAuth token from Azure AD');
    }
    return tokenResponse.token;
}
export function invalidateOAuthToken(instanceId) {
    if (instanceId) {
        credentials.delete(instanceId);
        return;
    }
    credentials.clear();
}
