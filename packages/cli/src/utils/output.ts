/**
 * Output utilities for structured data
 * YAML output on stdout, logs on stderr
 */

import * as yaml from 'yaml';

/**
 * Write a single YAML document to stdout, opened with `---`.
 *
 * There is deliberately NO trailing marker. `---` OPENS a document in YAML; the
 * end-of-document marker is `...`. Emitting `---` at the end therefore opened a
 * second, empty document, so every command's stdout was a two-document stream and
 * a plain `YAML.parse()` threw `Source contains multiple documents` — on output
 * this CLI documents as "YAML summary → stdout (for programmatic parsing)".
 *
 * The repo's own test helper had already been written around it: `executeCli…`
 * calls `parseAllDocuments(...)` and takes `docs[0]`, with a comment saying "to
 * handle document markers". That workaround is what kept the defect invisible —
 * every consumer that did the obvious thing instead got an exception.
 *
 * Dropping the trailer also makes this agree with the seven hand-rolled emit
 * sites elsewhere in the CLI, none of which ever wrote one.
 *
 * @param data - Data to serialize as YAML
 */
export function writeYamlOutput(data: unknown): void {
  process.stdout.write('---\n');
  process.stdout.write(yaml.stringify(data, {
    indent: 2,
    lineWidth: 120,
    aliasDuplicateObjects: false,
  }));
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
