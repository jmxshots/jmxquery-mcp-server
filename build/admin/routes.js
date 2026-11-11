import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { BcClient } from '../bcClient.js';
import { connectionConfigSchema, instanceSchema } from '../instances/model.js';
import { executeTool, isRegisteredTool, toolDefinitions } from '../mcp/tools.js';
import { getBearerToken, secretsEqual } from '../utils/secureCompare.js';
export const ADMIN_API_PREFIX = '/admin/api';
const ADMIN_SESSION_COOKIE = 'jmxquery_admin_session';
const defaultTransientConnectionClient = (input) => {
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
const getCookieValue = (request, name) => {
    const cookieHeader = request.headers.cookie;
    if (typeof cookieHeader !== 'string')
        return undefined;
    return cookieHeader
        .split(';')
        .map(entry => entry.trim())
        .find(entry => entry.startsWith(`${name}=`))
        ?.slice(name.length + 1);
};
const getLanAddresses = () => Array.from(new Set(Object.values(networkInterfaces())
    .flatMap(addresses => addresses || [])
    .filter(address => address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))
    .map(address => address.address)));
const sendAdminError = (reply, error) => {
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
export async function registerAdminApi(app, deps) {
    if (!deps.adminApiKey.trim()) {
        throw new Error('ADMIN_API_KEY must be configured when ADMIN_API_ENABLED is true.');
    }
    const { instanceRegistry, bcClientFactory, logService, logger } = deps;
    const adminApiKey = deps.adminApiKey.trim();
    const createTransientConnectionClient = deps.createTransientConnectionClient ?? defaultTransientConnectionClient;
    const adminSessions = new Set();
    const hasValidAdminSession = (request) => {
        const sessionId = getCookieValue(request, ADMIN_SESSION_COOKIE);
        return !!sessionId && adminSessions.has(sessionId);
    };
    const isAuthenticated = (request) => secretsEqual(getBearerToken(request.headers.authorization), adminApiKey) || hasValidAdminSession(request);
    const sessionCookieAttributes = (request, extra = []) => {
        const attributes = ['HttpOnly', `Path=${ADMIN_API_PREFIX}`, 'SameSite=Strict', ...extra];
        if (request.protocol === 'https')
            attributes.push('Secure');
        return attributes.join('; ');
    };
    const createSessionCookie = (request) => {
        const priorSessionId = getCookieValue(request, ADMIN_SESSION_COOKIE);
        if (priorSessionId)
            adminSessions.delete(priorSessionId);
        const sessionId = randomUUID();
        adminSessions.add(sessionId);
        return `${ADMIN_SESSION_COOKIE}=${sessionId}; ${sessionCookieAttributes(request)}`;
    };
    const clearSessionCookie = (request) => {
        const sessionId = getCookieValue(request, ADMIN_SESSION_COOKIE);
        if (sessionId)
            adminSessions.delete(sessionId);
        return `${ADMIN_SESSION_COOKIE}=; ${sessionCookieAttributes(request, ['Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'])}`;
    };
    await app.register(async (api) => {
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
            if (!value)
                return reply.code(404).send({ error: 'MCP API key is not configured.' });
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
            }
            catch (error) {
                return sendAdminError(reply, error);
            }
        });
        api.patch('/instances/:instanceName', async (request, reply) => {
            try {
                const { instanceName } = request.params;
                const instance = await instanceRegistry.updateInstance(instanceName, request.body);
                reply.header('cache-control', 'no-store');
                return instance;
            }
            catch (error) {
                return sendAdminError(reply, error);
            }
        });
        api.patch('/instances/:instanceName/enabled', async (request, reply) => {
            try {
                const { instanceName } = request.params;
                const { enabled } = (request.body || {});
                const instance = await instanceRegistry.setInstanceEnabled(instanceName, enabled);
                reply.header('cache-control', 'no-store');
                return instance;
            }
            catch (error) {
                return sendAdminError(reply, error);
            }
        });
        api.delete('/instances/:instanceName', async (request, reply) => {
            try {
                const { instanceName } = request.params;
                await instanceRegistry.deleteInstance(instanceName);
                return reply.code(204).send();
            }
            catch (error) {
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
            }
            catch (error) {
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
            }
            catch (error) {
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
            const { instanceName } = request.params;
            const requestId = randomUUID();
            const startedAt = Date.now();
            let target;
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
            }
            catch (error) {
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
            const { name, arguments: args } = body;
            if (typeof name !== 'string' || !isRegisteredTool(name) || !args || typeof args !== 'object' || Array.isArray(args)) {
                return reply.code(400).send({ error: 'Invalid request.' });
            }
            const result = await executeTool(name, args, bcClientFactory, logService);
            reply.header('cache-control', 'no-store');
            return result;
        });
        api.post('/instances/:instanceName/test-technical-company', async (request, reply) => {
            const { instanceName } = request.params;
            const requestId = randomUUID();
            const startedAt = Date.now();
            let target;
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
            }
            catch (error) {
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
            const { instanceName } = request.params;
            try {
                const target = bcClientFactory.resolveEnabledInstance(instanceName);
                const companies = await target.client.listCompanies();
                reply.header('cache-control', 'no-store');
                return companies;
            }
            catch (error) {
                logger.error({ tool: 'admin_listAvailableCompanies', errorType: error?.name || 'Error' }, 'Admin company discovery failed');
                return reply.code(400).send({
                    error: 'Company discovery failed.',
                    detail: error?.message || 'Unknown company discovery error.',
                    errorType: error?.name || 'Error',
                });
            }
        });
        api.post('/instances/:instanceName/secrets/:field/reveal', async (request, reply) => {
            const { instanceName, field } = request.params;
            if (field !== 'password' && field !== 'clientSecret') {
                return reply.code(400).send({ error: 'Invalid request.' });
            }
            try {
                const value = instanceRegistry.getSecret(instanceName, field);
                reply.header('cache-control', 'no-store');
                return { field, value };
            }
            catch (error) {
                return sendAdminError(reply, error);
            }
        });
        api.get('/logs', async (request, reply) => {
            const { limit, status, ...filters } = request.query;
            const parsedLimit = limit === undefined ? undefined : Number(limit);
            if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
                return reply.code(400).send({ error: 'Invalid request.' });
            }
            if (status && status !== 'success' && status !== 'error') {
                return reply.code(400).send({ error: 'Invalid request.' });
            }
            reply.header('cache-control', 'no-store');
            return logService.query({ ...filters, status: status, limit: parsedLimit });
        });
        api.get('/logs/metrics', async (request, reply) => {
            const { limit: _limit, status, ...filters } = request.query;
            if (status && status !== 'success' && status !== 'error') {
                return reply.code(400).send({ error: 'Invalid request.' });
            }
            reply.header('cache-control', 'no-store');
            return logService.getMetrics({ ...filters, status: status });
        });
        api.delete('/logs', async (request, reply) => {
            const { retentionDays } = request.query;
            const parsedRetentionDays = retentionDays === undefined ? undefined : Number(retentionDays);
            if (parsedRetentionDays !== undefined
                && (!Number.isInteger(parsedRetentionDays) || parsedRetentionDays < 0 || parsedRetentionDays > 3650)) {
                return reply.code(400).send({ error: 'Invalid request.' });
            }
            reply.header('cache-control', 'no-store');
            return logService.clear(parsedRetentionDays);
        });
        api.get('/logs/events', async (_request, reply) => {
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
                if (!response.destroyed)
                    response.write(': keepalive\n\n');
            }, 30000);
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
            }
            catch {
                return reply.code(404).send({ error: 'Documentation is unavailable.' });
            }
        });
    }, { prefix: ADMIN_API_PREFIX });
}
