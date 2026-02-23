import { ClientSecretCredential } from '@azure/identity';
import { config } from '../config.js';
const BC_OAUTH_SCOPE = 'https://api.businesscentral.dynamics.com/.default';
let credential = null;
function getCredential() {
    if (!credential) {
        credential = new ClientSecretCredential(config.BC_TENANT_ID, config.BC_CLIENT_ID, config.BC_CLIENT_SECRET);
    }
    return credential;
}
/**
 * Returns a valid Bearer token for Business Central SaaS.
 * @azure/identity handles caching and proactive refresh automatically.
 */
export async function getOAuthToken() {
    const tokenResponse = await getCredential().getToken(BC_OAUTH_SCOPE);
    if (!tokenResponse?.token) {
        throw new Error('Failed to acquire OAuth token from Azure AD');
    }
    return tokenResponse.token;
}
