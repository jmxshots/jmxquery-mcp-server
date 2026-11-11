import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { BcClient } from '../bcClient.js';
import type { BcClientFactory } from '../instances/clientFactory.js';
import { connectionConfigSchema, instanceSchema } from '../instances/model.js';
import type { EncryptedInstanceRegistry } from '../instances/registry.js';
import type { LogService } from '../logging/logService.js';
import { executeTool, isRegisteredTool, toolDefinitions } from '../mcp/tools.js';
import { getBearerToken, secretsEqual } from '../utils/secureCompare.js';

export const ADMIN_API_PREFIX = '/admin/api';
const ADMIN_SESSION_COOKIE = 'jmxquery_admin_session';

export interface AdminApiDependencies {
    adminApiKey: string;
    mcpApiKey?: string;
    streamablePort?: number;
    instanceRegistry: EncryptedInstanceRegistry;
    bcClientFactory: BcClientFactory;
    logService: LogService;
    logger: Logger;
    documentationPath: string;
    /** Self-contained HTML overview (docs/jmxquery-mcp-overview.html). Optional; the route returns 404 when unset. */
    overviewPath?: string;
    /** A session ends after this much time without an Admin API request. Default: 60 minutes. */
    sessionIdleTimeoutMs?: number;
    /** A session ends this long after login, regardless of activity. Default: 12 hours. */
    sessionMaxAgeMs?: number;
    /** Creates a client for unsaved connection data; replaceable in tests. */
    createTransientConnectionClient?: (input: unknown) => BcClient;
    /** Clock for session expiry; replaceable in tests. */
    now?: () => number;
}

export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const SSE_HEARTBEAT_MS = 30000;

interface AdminSession {
    createdAt: number;
    lastSeenAt: number;
}

const defaultTransientConnectionClient = (input: unknown): BcClient => {
    const connection = connectionConfigSchema.parse(input);
    const timestamp = new Date().toISOString();
    const instance = instanceSchema.parse({
        ...connection,
        id: randomUUID(),
        name: 'Admin connection test',
        description: '',
        enabled: false,
        technicalCompany: '__connection_test__',
        createdAt: timestamp,
        updatedAt: timestamp,
    });
    return new BcClient(instance);
};

const getCookieValue = (request: FastifyRequest, name: string): string | undefined => {
    const cookieHeader = request.headers.cookie;
    if (typeof cookieHeader !== 'string') return undefined;

    return cookieHeader
        .split(';')
        .map(entry => entry.trim())
        .find(entry => entry.startsWith(`${name}=`))
        ?.slice(name.length + 1);
};

const getLanAddresses = (): string[] => Array.from(new Set(
    Object.values(networkInterfaces())
        .flatMap(addresses => addresses || [])
        .filter(address => address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))
        .map(address => address.address),
));

const sendAdminError = (reply: FastifyReply, error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    const statusCode = message.includes('was not found') ? 404 : 400;
    return reply.code(statusCode).send({ error: statusCode === 404 ? 'Not found.' : 'Invalid request.' });
};

/**
 * Registers the Admin API as an encapsulated plugin under /admin/api.
 *
 * Authentication is an onRequest hook scoped to this plugin, so it runs for every
 * route the router matches here, independent of how the URL was spelled
 * (for example "//admin/api/..." with ignoreDuplicateSlashes). Do not move routes
 * out of this plugin or replace the hook with a URL prefix check.
 */
export async function registerAdminApi(app: FastifyInstance, deps: AdminApiDependencies): Promise<void> {
    if (!deps.adminApiKey.trim()) {
        throw new Error('ADMIN_API_KEY must be configured when ADMIN_API_ENABLED is true.');
    }

    const { instanceRegistry, bcClientFactory, logService, logger } = deps;
    const adminApiKey = deps.adminApiKey.trim();
    const createTransientConnectionClient = deps.createTransientConnectionClient ?? defaultTransientConnectionClient;
    const now = deps.now ?? Date.now;
    const sessionIdleTimeoutMs = deps.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    const sessionMaxAgeMs = deps.sessionMaxAgeMs ?? DEFAULT_SESSION_MAX_AGE_MS;
    const adminSessions = new Map<string, AdminSession>();

    const isSessionActive = (session: AdminSession, at: number): boolean =>
        at - session.lastSeenAt < sessionIdleTimeoutMs && at - session.createdAt < sessionMaxAgeMs;

    const removeExpiredSessions = (at: number): void => {
        for (const [sessionId, session] of adminSessions) {
            if (!isSessionActive(session, at)) adminSessions.delete(sessionId);
        }
    };

    /** Checks the session cookie; an active session's idle timer restarts only when touch is true. */
    const hasValidAdminSession = (sessionId: string | undefined, touch: boolean): boolean => {
        if (!sessionId) return false;
        const session = adminSessions.get(sessionId);
        if (!session) return false;
        const at = now();
        if (!isSessionActive(session, at)) {
            adminSessions.delete(sessionId);
            return false;
        }
        if (touch) session.lastSeenAt = at;
        return true;
    };

    const hasValidAdminKey = (request: FastifyRequest): boolean =>
        secretsEqual(getBearerToken(request.headers.authorization), adminApiKey);

    const isAuthenticated = (request: FastifyRequest): boolean =>
        hasValidAdminKey(request) || hasValidAdminSession(getCookieValue(request, ADMIN_SESSION_COOKIE), true);

    const sessionCookieAttributes = (request: FastifyRequest, extra: string[] = []): string => {
        const attributes = ['HttpOnly', `Path=${ADMIN_API_PREFIX}`, 'SameSite=Strict', ...extra];
        if (request.protocol === 'https') attributes.push('Secure');
        return attributes.join('; ');
    };

    const createSessionCookie = (request: FastifyRequest): string => {
        const priorSessionId = getCookieValue(request, ADMIN_SESSION_COOKIE);
        if (priorSessionId) adminSessions.delete(priorSessionId);
        const at = now();
        removeExpiredSessions(at);
        const sessionId = randomUUID();
        adminSessions.set(sessionId, { createdAt: at, lastSeenAt: at });
        return `${ADMIN_SESSION_COOKIE}=${sessionId}; ${sessionCookieAttributes(request, [`Max-Age=${Math.floor(sessionMaxAgeMs / 1000)}`])}`;
    };

    const clearSessionCookie = (request: FastifyRequest): string => {
        const sessionId = getCookieValue(request, ADMIN_SESSION_COOKIE);
        if (sessionId) adminSessions.delete(sessionId);
        return `${ADMIN_SESSION_COOKIE}=; ${sessionCookieAttributes(request, ['Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'])}`;
    };

    await app.register(async api => {
        api.addHook('onRequest', async (request, reply) => {
            if (!isAuthenticated(request)) {
                return reply.code(401).send({ error: 'Unauthorized.' });
            }
        });

        api.post('/session', async (request, reply) => {
            reply.header('set-cookie', createSessionCookie(request));
            reply.header('cache-control', 'no-store');
            return { authenticated: true };
        });

        api.get('/session', async (_request, reply) => {
            reply.header('cache-control', 'no-store');
            return { authenticated: true };
        });

        api.get('/mcp-connection', async (_request, reply) => {
            reply.header('cache-control', 'no-store');
            return {
                streamablePort: deps.streamablePort ?? null,
                apiKeyRequired: Boolean(deps.mcpApiKey?.trim()),
                hostname: hostname(),
                lanAddresses: getLanAddresses(),
                workingDirectory: process.cwd(),
                nodePath: process.execPath,
            };
        });

        api.post('/mcp-connection/api-key/reveal', async (_request, reply) => {
            const value = deps.mcpApiKey?.trim();
            if (!value) return reply.code(404).send({ error: 'MCP API key is not configured.' });
            reply.header('cache-control', 'no-store');
            return { value };
        });

        api.post('/session/logout', async (request, reply) => {
            reply.header('set-cookie', clearSessionCookie(request));
            reply.header('cache-control', 'no-store');
            return reply.code(204).send();
        });

        api.get('/instances', async (_request, reply) => {
            reply.header('cache-control', 'no-store');
            return instanceRegistry.listPublicInstances();
        });

        api.post('/instances', async (request, reply) => {
            try {
                const instance = await instanceRegistry.createInstance(request.body);
                reply.header('cache-control', 'no-store');
                return reply.code(201).send(instance);
            } catch (error) {
                return sendAdminError(reply, error);
            }
        });

        api.patch('/instances/:instanceName', async (request, reply) => {
            try {
                const { instanceName } = request.params as { instanceName: string };
                const instance = await instanceRegistry.updateInstance(instanceName, request.body);
                reply.header('cache-control', 'no-store');
                return instance;
            } catch (error) {
                return sendAdminError(reply, error);
            }
        });

        api.patch('/instances/:instanceName/enabled', async (request, reply) => {
            try {
                const { instanceName } = request.params as { instanceName: string };
                const { enabled } = (request.body || {}) as { enabled?: unknown };
                const instance = await instanceRegistry.setInstanceEnabled(instanceName, enabled as boolean);
                reply.header('cache-control', 'no-store');
                return instance;
            } catch (error) {
                return sendAdminError(reply, error);
            }
        });

        api.delete('/instances/:instanceName', async (request, reply) => {
            try {
                const { instanceName } = request.params as { instanceName: string };
                await instanceRegistry.deleteInstance(instanceName);
                return reply.code(204).send();
            } catch (error) {
                return sendAdminError(reply, error);
            }
        });

        api.post('/instance-connection/test', async (request, reply) => {
            const startedAt = Date.now();
            const requestId = randomUUID();
            try {
                await createTransientConnectionClient(request.body).testConnection();
                reply.header('cache-control', 'no-store');
                return { status: 'ok', durationMs: Date.now() - startedAt, requestId };
            } catch (error: any) {
                return reply.code(400).send({
                    error: 'Connection test failed.',
                    detail: error?.message || 'Unknown connection error.',
                    errorType: error?.name || 'Error',
                    durationMs: Date.now() - startedAt,
                    requestId,
                });
            }
        });

        api.post('/instance-connection/companies', async (request, reply) => {
            const startedAt = Date.now();
            const requestId = randomUUID();
            try {
                const client = createTransientConnectionClient(request.body);
                await client.testConnection();
                const companies = await client.listCompanies();
                reply.header('cache-control', 'no-store');
                return { companies, durationMs: Date.now() - startedAt, requestId };
            } catch (error: any) {
                return reply.code(400).send({
                    error: 'Company discovery failed.',
                    detail: error?.message || 'Unable to connect to Business Central.',
                    errorType: error?.name || 'Error',
                    durationMs: Date.now() - startedAt,
                    requestId,
                });
            }
        });

        api.post('/instances/:instanceName/test-connection', async (request, reply) => {
            const { instanceName } = request.params as { instanceName: string };
            const requestId = randomUUID();
            const startedAt = Date.now();
            let target: ReturnType<typeof bcClientFactory.resolveEnabledInstance> | undefined;

            try {
                target = bcClientFactory.resolveEnabledInstance(instanceName);
                await target.client.testConnection();
                await logService.record({
                    instanceId: target.instance.id,
                    instanceName: target.instance.name,
                    companyName: target.instance.technicalCompany,
                    tool: 'admin_testInstanceConnection',
                    status: 'success',
                    durationMs: Date.now() - startedAt,
                    requestId,
                }).catch(() => undefined);

                reply.header('cache-control', 'no-store');
                return { status: 'ok', durationMs: Date.now() - startedAt, requestId };
            } catch (error: any) {
                await logService.record({
                    instanceId: target?.instance.id,
                    instanceName: target?.instance.name || instanceName,
                    companyName: target?.instance.technicalCompany,
                    tool: 'admin_testInstanceConnection',
                    status: 'error',
                    durationMs: Date.now() - startedAt,
                    requestId,
                    errorType: error?.name || 'Error',
                    errorMessage: error?.message || 'Connection test failed.',
                }).catch(() => undefined);

                return reply.code(400).send({
                    error: 'Connection test failed.',
                    detail: error?.message || 'Unknown connection error.',
                    errorType: error?.name || 'Error',
                    durationMs: Date.now() - startedAt,
                    requestId,
                });
            }
        });

        api.get('/tools', async (_request, reply) => {
            reply.header('cache-control', 'no-store');
            return toolDefinitions;
        });

        api.post('/tools/call', async (request, reply) => {
            const body = request.body;
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                return reply.code(400).send({ error: 'Invalid request.' });
            }
            const { name, arguments: args } = body as { name?: unknown; arguments?: unknown };
            if (typeof name !== 'string' || !isRegisteredTool(name) || !args || typeof args !== 'object' || Array.isArray(args)) {
                return reply.code(400).send({ error: 'Invalid request.' });
            }

            const result = await executeTool(name, args as Record<string, unknown>, bcClientFactory, logService);
            reply.header('cache-control', 'no-store');
            return result;
        });

        api.post('/instances/:instanceName/test-technical-company', async (request, reply) => {
            const { instanceName } = request.params as { instanceName: string };
            const requestId = randomUUID();
            const startedAt = Date.now();
            let target: ReturnType<typeof bcClientFactory.resolveEnabledInstance> | undefined;

            try {
                target = bcClientFactory.resolveEnabledInstance(instanceName);
                await target.client.callAction('JMXQ_ApiInfoService', 'ListExecutionContexts', target.instance.technicalCompany, {});
                await logService.record({
                    instanceId: target.instance.id,
                    instanceName: target.instance.name,
                    companyName: target.instance.technicalCompany,
                    tool: 'admin_testTechnicalCompany',
                    status: 'success',
                    durationMs: Date.now() - startedAt,
                    requestId,
                }).catch(() => undefined);

                reply.header('cache-control', 'no-store');
                return { status: 'ok', durationMs: Date.now() - startedAt };
            } catch (error: any) {
                await logService.record({
                    instanceId: target?.instance.id,
                    instanceName: target?.instance.name || instanceName,
                    companyName: target?.instance.technicalCompany,
                    tool: 'admin_testTechnicalCompany',
                    status: 'error',
                    durationMs: Date.now() - startedAt,
                    requestId,
                    errorType: error?.name || 'Error',
                    errorMessage: error?.message || 'Technical company test failed.',
                }).catch(() => undefined);

                return reply.code(400).send({
                    error: 'Technical company test failed.',
                    detail: error?.message || 'Unknown error.',
                    errorType: error?.name || 'Error',
                    durationMs: Date.now() - startedAt,
                    requestId,
                });
            }
        });

        api.get('/instances/:instanceName/available-companies', async (request, reply) => {
            const { instanceName } = request.params as { instanceName: string };

            try {
                const target = bcClientFactory.resolveEnabledInstance(instanceName);
                const companies = await target.client.listCompanies();
                reply.header('cache-control', 'no-store');
                return companies;
            } catch (error: any) {
                logger.error({ tool: 'admin_listAvailableCompanies', errorType: error?.name || 'Error' }, 'Admin company discovery failed');
                return reply.code(400).send({
                    error: 'Company discovery failed.',
                    detail: error?.message || 'Unknown company discovery error.',
                    errorType: error?.name || 'Error',
                });
            }
        });

        api.post('/instances/:instanceName/secrets/:field/reveal', async (request, reply) => {
            const { instanceName, field } = request.params as { instanceName: string; field: string };
            if (field !== 'password' && field !== 'clientSecret') {
                return reply.code(400).send({ error: 'Invalid request.' });
            }
            try {
                const value = instanceRegistry.getSecret(instanceName, field);
                reply.header('cache-control', 'no-store');
                return { field, value };
            } catch (error) {
                return sendAdminError(reply, error);
            }
        });

        api.get('/logs', async (request, reply) => {
            const { limit, status, ...filters } = request.query as Record<string, string | undefined>;
            const parsedLimit = limit === undefined ? undefined : Number(limit);
            if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
                return reply.code(400).send({ error: 'Invalid request.' });
            }
            if (status && status !== 'success' && status !== 'error') {
                return reply.code(400).send({ error: 'Invalid request.' });
            }
            reply.header('cache-control', 'no-store');
            return logService.query({ ...filters, status: status as 'success' | 'error' | undefined, limit: parsedLimit });
        });

        api.get('/logs/metrics', async (request, reply) => {
            const { limit: _limit, status, ...filters } = request.query as Record<string, string | undefined>;
            if (status && status !== 'success' && status !== 'error') {
                return reply.code(400).send({ error: 'Invalid request.' });
            }
            reply.header('cache-control', 'no-store');
            return logService.getMetrics({ ...filters, status: status as 'success' | 'error' | undefined });
        });

        api.delete('/logs', async (request, reply) => {
            const { retentionDays } = request.query as Record<string, string | undefined>;
            const parsedRetentionDays = retentionDays === undefined ? undefined : Number(retentionDays);
            if (parsedRetentionDays !== undefined
                && (!Number.isInteger(parsedRetentionDays) || parsedRetentionDays < 0 || parsedRetentionDays > 3650)) {
                return reply.code(400).send({ error: 'Invalid request.' });
            }
            reply.header('cache-control', 'no-store');
            return logService.clear(parsedRetentionDays);
        });

        api.get('/logs/events', async (request, reply) => {
            // A stream opened with a session cookie ends when that session expires or logs out.
            // Heartbeats do not count as activity, so an open log view does not keep a session alive.
            const streamSessionId = hasValidAdminKey(request) ? undefined : getCookieValue(request, ADMIN_SESSION_COOKIE);
            reply.hijack();
            const response = reply.raw;
            response.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-store',
                Connection: 'keep-alive',
            });
            response.write(': connected\n\n');
            const unsubscribe = logService.subscribe(record => {
                if (!response.destroyed) {
                    response.write(`data: ${JSON.stringify(record)}\n\n`);
                }
            });
            const heartbeat = setInterval(() => {
                if (response.destroyed) return;
                if (streamSessionId && !hasValidAdminSession(streamSessionId, false)) {
                    response.end();
                    return;
                }
                response.write(': keepalive\n\n');
            }, SSE_HEARTBEAT_MS);
            response.on('close', () => {
                clearInterval(heartbeat);
                unsubscribe();
            });
        });

        api.get('/documentation', async (_request, reply) => {
            try {
                const documentation = await readFile(deps.documentationPath, 'utf8');
                return reply
                    .header('cache-control', 'no-store')
                    .type('text/markdown; charset=utf-8')
                    .send(documentation);
            } catch {
                return reply.code(404).send({ error: 'Documentation is unavailable.' });
            }
        });

        // Opened in a new browser tab; the session cookie (Path=/admin/api) authenticates it.
        // The page is static and self-contained, so the CSP blocks every network request.
        api.get('/documentation/overview', async (_request, reply) => {
            if (!deps.overviewPath) return reply.code(404).send({ error: 'Overview is unavailable.' });
            try {
                const overview = await readFile(deps.overviewPath, 'utf8');
                return reply
                    .header('cache-control', 'no-store')
                    .header('x-content-type-options', 'nosniff')
                    .header('referrer-policy', 'no-referrer')
                    .header(
                        'content-security-policy',
                        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
                    )
                    .type('text/html; charset=utf-8')
                    .send(overview);
            } catch {
                return reply.code(404).send({ error: 'Overview is unavailable.' });
            }
        });
    }, { prefix: ADMIN_API_PREFIX });
}
