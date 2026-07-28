/**
 * Help loader - reads verbose help from markdown files
 * Markdown docs are the source of truth for CLI help
 */

import { readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

/**
 * Load verbose help from markdown files in packages/cli/docs/
 *
 * @param section - Optional section name (e.g., 'resources'). If not provided, loads index.md
 * @returns Markdown content as string
 */
export function loadVerboseHelp(section?: string): string {
  // Get package root (packages/cli/)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const packageRoot = safePath.join(__dirname, '../..');

  // Determine which markdown file to load
  const filename = section ? `${section}.md` : 'index.md';
  const helpPath = safePath.join(packageRoot, 'docs', filename);

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is constructed from known safe components
    const content = readFileSync(helpPath, 'utf-8');
    return content;
  } catch (error) {
    // Fallback if markdown file not found
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `# Help Documentation Not Found

Error loading help from ${helpPath}

${errorMessage}

Please report this issue at: https://github.com/jdutton/vibe-agent-toolkit/issues
`;
  }
}

/**
 * Write a verbose-help document to stdout, SYNCHRONOUSLY, with a trailing newline.
 *
 * Every verbose-help path calls `process.exit(0)` the moment it has written. When
 * stdout is a pipe, `process.stdout.write` is ASYNCHRONOUS, and `process.exit`
 * does not wait for the pending write to drain — so everything past the first
 * pipe buffer (~8 KB on macOS) was silently dropped. Most of the help documents
 * in `packages/cli/docs/` are larger than that, so `vat --help --verbose | less`
 * and `> file` lost their tail, while an interactive TTY (unbuffered) looked fine.
 * That directly violates this package's own rule that help must survive piping.
 *
 * `writeSync` in a drain loop is the fix: it cannot return before the bytes are
 * handed to the pipe, so `process.exit` has nothing left to lose. The loop is
 * required because a single `writeSync` may accept fewer bytes than offered.
 */
export function writeHelpSync(content: string): void {
  const buffer = Buffer.from(content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  let written = 0;
  while (written < buffer.length) {
    try {
      written += writeSync(1, buffer, written, buffer.length - written);
    } catch (error) {
      // A non-blocking pipe whose buffer is momentarily full raises EAGAIN; the
      // reader will drain it, so retry. Anything else is a genuine write failure.
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
    }
  }
}
