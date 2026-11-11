import { runPowerShell } from './powershell.js';
const SOURCE = 'JMX-QUERY MCP Server';
const LOG_NAME = 'Application';
// Event log messages are limited to roughly 31,839 characters.
const MAX_MESSAGE_LENGTH = 30000;
// Constant script: the message and its metadata arrive only through $JmxqInput.
const WRITE_EVENT_SCRIPT = `
$source = '${SOURCE}'
if (-not [System.Diagnostics.EventLog]::SourceExists($source)) {
    # Creating a source requires administrator rights; writing to an existing one does not.
    New-EventLog -LogName '${LOG_NAME}' -Source $source -ErrorAction SilentlyContinue
}
Write-EventLog -LogName '${LOG_NAME}' -Source $source -EntryType ([string]$JmxqInput.entryType) -EventId ([int]$JmxqInput.eventId) -Message ([string]$JmxqInput.message)
`.trim();
export class WindowsEventLogger {
    static info(message) {
        this.writeToEventLog('Information', message, 1000);
    }
    static warn(message) {
        this.writeToEventLog('Warning', message, 1000);
    }
    static error(message, eventId) {
        this.writeToEventLog('Error', message, eventId || 1001);
    }
    static writeToEventLog(entryType, message, eventId) {
        runPowerShell(WRITE_EVENT_SCRIPT, {
            input: { entryType, eventId, message: this.prepare(message) },
            timeoutMs: 30000,
        }).catch(error => {
            // Fallback to stderr; stdout must stay clean for the stdio MCP transport.
            console.error('Failed to log to Windows Event Log:', error?.message || error);
        });
    }
    static prepare(msg) {
        if (!msg)
            return '';
        const trimmed = msg.trim();
        return trimmed.length > MAX_MESSAGE_LENGTH ? `${trimmed.slice(0, MAX_MESSAGE_LENGTH)}...` : trimmed;
    }
}
