import { createHash, timingSafeEqual } from 'node:crypto';
const digest = (value) => createHash('sha256').update(value, 'utf8').digest();
/**
 * Compares a provided secret with the configured one in constant time.
 * Hashing first gives equal-length buffers, so the key length is not leaked either.
 */
export const secretsEqual = (provided, configured) => {
    if (typeof provided !== 'string' || !configured) {
        return false;
    }
    return timingSafeEqual(digest(provided), digest(configured));
};
/** Extracts the token from an "Authorization: Bearer <token>" header. */
export const getBearerToken = (authorizationHeader) => typeof authorizationHeader === 'string' && authorizationHeader.startsWith('Bearer ')
    ? authorizationHeader.substring(7).trim()
    : undefined;
