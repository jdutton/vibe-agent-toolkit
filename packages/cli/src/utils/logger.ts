/**
 * Logger utility for CLI - writes only to stderr
 * stdout is reserved for structured YAML/JSON output
 */

export interface Logger {
  info: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
}

export interface LoggerOptions {
  debug?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const debug = options.debug ?? false;

  return {
    info: (message: string) => {
      process.stderr.write(`${message}\n`);
    },
    error: (message: string) => {
      process.stderr.write(`${message}\n`);
    },
    debug: (message: string) => {
      if (debug) {
        process.stderr.write(`[DEBUG] ${message}\n`);
      }
    },
  };
}
