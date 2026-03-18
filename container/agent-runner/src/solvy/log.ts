import fs from 'fs';

// TODO(logging): Replace /proc/1/fd/2 with syslog (e.g. posix-syslog + rsyslog)
// or a dedicated rotating log file (e.g. winston file transport) once we need
// structured logging, filtering, or multi-destination routing.
let logStream: fs.WriteStream | null = null;

function getLogStream(): fs.WriteStream | NodeJS.WriteStream {
  if (logStream) return logStream;
  try {
    logStream = fs.createWriteStream('/proc/1/fd/2', { flags: 'a' });
    logStream.on('error', () => {
      // Fall back to process stderr if /proc/1/fd/2 is unavailable
      logStream = null;
    });
    return logStream;
  } catch {
    return process.stderr;
  }
}

export function solvyLog(message: string): void {
  const ts = new Date().toISOString();
  const line = `[solvy ${ts}] ${message}\n`;
  getLogStream().write(line);
}
