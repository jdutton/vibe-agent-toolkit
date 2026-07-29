/**
 * Output utilities for structured data
 * YAML output on stdout, logs on stderr
 */

import * as yaml from 'yaml';

/**
 * Write YAML output to stdout with document markers
 * @param data - Data to serialize as YAML
 */
export function writeYamlOutput(data: unknown): void {
  process.stdout.write('---\n');
  process.stdout.write(yaml.stringify(data, {
    indent: 2,
    lineWidth: 120,
    aliasDuplicateObjects: false,
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
 * Write a test-format finding to stderr.
 *
 * Format: `file:line:column: severity: message` — the GCC/ESLint-compact
 * convention, which every editor and CI log scraper already parses.
 *
 * The severity is not decoration. Only `error` findings fail the run, so a
 * reader who cannot see the severity cannot tell which lines of a long report
 * they have to act on. Omitting it made an info-severity note byte-identical in
 * shape to a build-breaking error.
 */
export function writeTestFormatError(
  file: string,
  line: number,
  column: number,
  severity: string,
  message: string
): void {
  process.stderr.write(`${file}:${line}:${column}: ${severity}: ${message}\n`);
}
