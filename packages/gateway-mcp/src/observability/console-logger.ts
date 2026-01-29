import type { Logger } from '../types.js';

/**
 * Simple console-based logger for development
 */
export class ConsoleLogger implements Logger {
  info(message: string, context?: Record<string, unknown>): void {
    if (context) {
      console.error(`[INFO] ${message}`, context);
    } else {
      console.error(`[INFO] ${message}`);
    }
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    if (error && context) {
      console.error(`[ERROR] ${message}`, error, context);
    } else if (error) {
      console.error(`[ERROR] ${message}`, error);
    } else if (context) {
      console.error(`[ERROR] ${message}`, context);
    } else {
      console.error(`[ERROR] ${message}`);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (context) {
      console.warn(`[WARN] ${message}`, context);
    } else {
      console.warn(`[WARN] ${message}`);
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (context) {
      console.error(`[DEBUG] ${message}`, context);
    } else {
      console.error(`[DEBUG] ${message}`);
    }
  }
}
