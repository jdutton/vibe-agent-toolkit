/**
 * Output utilities for structured data
 * YAML output on stdout, logs on stderr
 */

import * as yaml from 'js-yaml';

/**
 * Write YAML output to stdout with document markers
 * @param data - Data to serialize as YAML
 */
export function writeYamlOutput(data: unknown): void {
  process.stdout.write('---\n');
  process.stdout.write(yaml.dump(data, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  }));
  process.stdout.write('---\n');
}

/**
 * Flush stdout before writing to stderr
 * Prevents output corruption when streams are merged
 */
export async function flushStdout(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.stdout.writableNeedDrain) {
      process.stdout.once('drain', resolve);
    } else {
      resolve();
    }
  });
}

/**
 * Write test-format error to stderr
 * Format: file:line:column: message
 */
export function writeTestFormatError(
  file: string,
  line: number,
  column: number,
  message: string
): void {
  process.stderr.write(`${file}:${line}:${column}: ${message}\n`);
}
