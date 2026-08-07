import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type LogStatus = 'success' | 'error';

export interface LogEventInput {
    instanceId?: string;
    instanceName?: string;
    companyId?: string;
    companyName?: string;
    tool: string;
    status: LogStatus;
    durationMs: number;
    requestId: string;
    executionContextCode?: string;
    errorType?: string;
    errorMessage?: string;
    script?: string;
}

export interface LogRecord {
    timestamp: string;
    instanceId: string | null;
    instanceName: string | null;
    companyId: string | null;
    companyName: string | null;
    tool: string;
    status: LogStatus;
    durationMs: number;
    requestId: string;
    executionContextCode: string | null;
    errorType: string | null;
    errorMessage: string | null;
    script?: string;
}

export interface LogQuery {
    instanceId?: string;
    instanceName?: string;
    companyId?: string;
    companyName?: string;
    tool?: string;
    status?: LogStatus;
    requestId?: string;
    from?: string;
    to?: string;
    limit?: number;
}

export interface LogMetrics {
    total: number;
    success: number;
    error: number;
    averageDurationMs: number;
    byTool: Record<string, { total: number; success: number; error: number; averageDurationMs: number }>;
}

const LOG_FILE_PATTERN = /^jmxquery-(\d{4}-\d{2}-\d{2})\.jsonl$/;

const redactSensitiveText = (value: string, maxLength: number): string => {
    const redacted = value
        .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
        .replace(/(Authorization\s*:\s*Basic\s+)[^\s,;]+/gi, '$1[REDACTED]')
        .replace(/("?(?:password|client_?secret|api_?key|token)"?\s*[:=]\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
        .replace(/(\b(?:password|client_?secret|api_?key|token)\b\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
        .replace(/[\r\n\t]+/g, ' ')
        .trim();

    return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...` : redacted;
};

export class LogService {
    private writeQueue: Promise<void> = Promise.resolve();
    private readonly subscribers = new Set<(record: LogRecord) => void>();

    constructor(
        private readonly logDirectory: string,
        private readonly retentionDays: number,
        private readonly scriptMaxLength: number,
    ) {}

    async record(event: LogEventInput): Promise<LogRecord> {
        const timestamp = new Date().toISOString();
        const record: LogRecord = {
            timestamp,
            instanceId: event.instanceId || null,
            instanceName: event.instanceName || null,
            companyId: event.companyId || null,
            companyName: event.companyName || null,
            tool: event.tool,
            status: event.status,
            durationMs: Math.max(0, Math.round(event.durationMs)),
            requestId: event.requestId,
            executionContextCode: event.executionContextCode || null,
            errorType: event.errorType || null,
            errorMessage: event.errorMessage ? redactSensitiveText(event.errorMessage, 1000) : null,
        };

        if (event.tool === 'jmxq_executeScript' && event.script) {
            record.script = redactSensitiveText(event.script, this.scriptMaxLength);
        }

        const filePath = path.join(this.logDirectory, `jmxquery-${timestamp.slice(0, 10)}.jsonl`);
        const write = async () => {
            await mkdir(this.logDirectory, { recursive: true });
            await writeFile(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
            await this.removeExpiredFiles(timestamp).catch(() => undefined);
        };
        this.writeQueue = this.writeQueue.catch(() => undefined).then(write);
        await this.writeQueue;

        for (const subscriber of this.subscribers) {
            try {
                subscriber(record);
            } catch {
                // Subscribers must not affect logging or other subscribers.
            }
        }
        return record;
    }

    subscribe(subscriber: (record: LogRecord) => void): () => void {
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }

    async query(query: LogQuery = {}): Promise<LogRecord[]> {
        const records = await this.readRecords(query);
        const limit = Math.min(Math.max(query.limit || 100, 1), 1000);
        return records.slice(0, limit);
    }

    async getMetrics(query: Omit<LogQuery, 'limit'> = {}): Promise<LogMetrics> {
        const records = await this.readRecords(query);
        const byTool: LogMetrics['byTool'] = {};
        let success = 0;
        let error = 0;
        let durationTotal = 0;

        for (const record of records) {
            durationTotal += record.durationMs;
            if (record.status === 'success') success += 1;
            else error += 1;
            const metrics = byTool[record.tool] || (byTool[record.tool] = { total: 0, success: 0, error: 0, averageDurationMs: 0 });
            metrics.total += 1;
            metrics.averageDurationMs += record.durationMs;
            if (record.status === 'success') metrics.success += 1;
            else metrics.error += 1;
        }

        for (const metrics of Object.values(byTool)) {
            metrics.averageDurationMs = metrics.total ? Math.round(metrics.averageDurationMs / metrics.total) : 0;
        }

        return {
            total: records.length,
            success,
            error,
            averageDurationMs: records.length ? Math.round(durationTotal / records.length) : 0,
            byTool,
        };
    }

    async clear(retentionDays?: number): Promise<{ deletedFiles: number }> {
        let deletedFiles = 0;
        const clear = async () => {
            const cutoffDate = retentionDays === undefined
                ? undefined
                : this.getCutoffDate(new Date().toISOString(), retentionDays);
            deletedFiles = await this.removeLogFiles(cutoffDate);
        };
        this.writeQueue = this.writeQueue.catch(() => undefined).then(clear);
        await this.writeQueue;
        return { deletedFiles };
    }

    private async readRecords(query: Omit<LogQuery, 'limit'>): Promise<LogRecord[]> {
        await this.writeQueue;
        let fileNames: string[];
        try {
            fileNames = await readdir(this.logDirectory);
        } catch (error: any) {
            if (error?.code === 'ENOENT') return [];
            throw error;
        }

        const records: LogRecord[] = [];
        for (const fileName of fileNames.filter(file => LOG_FILE_PATTERN.test(file)).sort().reverse()) {
            const content = await readFile(path.join(this.logDirectory, fileName), 'utf8');
            for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const record = JSON.parse(line) as LogRecord;
                    if (this.matchesQuery(record, query)) records.push(record);
                } catch {
                    // A malformed historical line must not make the admin log API unavailable.
                }
            }
        }
        return records.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    }

    private matchesQuery(record: LogRecord, query: Omit<LogQuery, 'limit'>): boolean {
        if (query.instanceId && record.instanceId !== query.instanceId) return false;
        if (query.instanceName && record.instanceName !== query.instanceName) return false;
        if (query.companyId && record.companyId !== query.companyId) return false;
        if (query.companyName && record.companyName !== query.companyName) return false;
        if (query.tool && record.tool !== query.tool) return false;
        if (query.status && record.status !== query.status) return false;
        if (query.requestId && record.requestId !== query.requestId) return false;
        if (query.from && record.timestamp < query.from) return false;
        if (query.to && record.timestamp > query.to) return false;
        return true;
    }

    private async removeExpiredFiles(timestamp: string): Promise<void> {
        await this.removeLogFiles(this.getCutoffDate(timestamp, this.retentionDays));
    }

    private getCutoffDate(timestamp: string, retentionDays: number): string {
        const cutoff = new Date(timestamp);
        cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
        return cutoff.toISOString().slice(0, 10);
    }

    private async removeLogFiles(cutoffDate?: string): Promise<number> {
        let fileNames: string[];
        try {
            fileNames = await readdir(this.logDirectory);
        } catch (error: any) {
            if (error?.code === 'ENOENT') return 0;
            throw error;
        }

        const filesToDelete = fileNames.filter(fileName => {
            const match = LOG_FILE_PATTERN.exec(fileName);
            return !!match && (cutoffDate === undefined || match[1] < cutoffDate);
        });
        await Promise.all(filesToDelete.map(fileName => this.removeLogFile(path.join(this.logDirectory, fileName))));
        return filesToDelete.length;
    }

    private async removeLogFile(filePath: string): Promise<void> {
        try {
            await unlink(filePath);
        } catch (error: any) {
            if (error?.code !== 'EPERM') {
                throw error;
            }
            await writeFile(filePath, '', { encoding: 'utf8', mode: 0o600 });
        }
    }
}