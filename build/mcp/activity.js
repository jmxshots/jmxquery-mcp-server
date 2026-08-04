import { AsyncLocalStorage } from 'node:async_hooks';
const activityContext = new AsyncLocalStorage();
let activityLogger;
export function configureMcpActivityLogger(logger) {
    activityLogger = logger;
}
export function runWithMcpActivity(context, callback) {
    return activityContext.run(context, callback);
}
export function logMcpActivity(activity) {
    const client = activityContext.getStore()?.client || 'MCP client';
    activityLogger?.info(`MCP ${client} | ${activity}`);
}
