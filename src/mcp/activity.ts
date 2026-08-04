import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';

export interface McpActivityContext {
    client: string;
}

const activityContext = new AsyncLocalStorage<McpActivityContext>();
let activityLogger: Logger | undefined;

export function configureMcpActivityLogger(logger: Logger): void {
    activityLogger = logger;
}

export function runWithMcpActivity<T>(context: McpActivityContext, callback: () => T): T {
    return activityContext.run(context, callback);
}

export function logMcpActivity(activity: string): void {
    const client = activityContext.getStore()?.client || 'MCP client';
    activityLogger?.info(`MCP ${client} | ${activity}`);
}