import { exec } from 'child_process';

const SOURCE = 'JMX-QUERY MCP Server';
const LOG_NAME = 'Application';

export class WindowsEventLogger {
    static info(message: string) {
        this.writeToEventLog('Information', message, 1000);
    }

    static warn(message: string) {
        this.writeToEventLog('Warning', message, 1000);
    }

    static error(message: string, eventId?: number) {
        this.writeToEventLog('Error', message, eventId || 1001);
    }

    private static writeToEventLog(entryType: string, message: string, eventId: number) {
        const preparedMessage = this.prepare(message);

        // PowerShell script to check for source and write log
        // We use -ErrorAction SilentlyContinue because source creation requires Admin, 
        // but writing to an existing source does not.
        const psScript = `
            $source = "${SOURCE}";
            if (-not [System.Diagnostics.EventLog]::SourceExists($source)) {
                # This might fail if not running as Admin, that's okay if it already exists
                New-EventLog -LogName "${LOG_NAME}" -Source $source -ErrorAction SilentlyContinue
            }
            Write-EventLog -LogName "${LOG_NAME}" -Source $source -EntryType ${entryType} -EventId ${eventId} -Message "${preparedMessage.replace(/"/g, '`"')}";
        `.trim();

        const encodedScript = Buffer.from(psScript, 'utf16le').toString('base64');

        exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${encodedScript}`, (err) => {
            if (err) {
                // Fallback to console if everything fails
                console.error('Failed to log to Windows Event Log:', err);
                console.error('Original Message:', message);
            }
        });
    }

    private static prepare(msg: string): string {
        if (!msg) return "";
        // Basic cleanup, PowerShell's -Message handles most characters fine when passed via EncodedCommand
        return msg.trim();
    }
}
