/**
 * Build-time validator for help documentation files
 *
 * Ensures all required markdown help files exist before build completes.
 * This provides "fail fast" behavior - missing help files cause build failure
 * rather than runtime errors when users request verbose help.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

/**
 * Files `loadVerboseHelp()` is actually asked for by a command.
 *
 * This list must stay in step with the `loadVerboseHelp(...)` call sites —
 * each entry is a document some `--help --verbose` path will read at runtime,
 * and a missing one degrades to an in-band "Help Documentation Not Found" page
 * that still exits 0.
 */
const REQUIRED_HELP_FILES = [
  'index.md',      // Root-level verbose help (vat --help --verbose)
  'resources.md',  // Resources command verbose help (vat resources --help --verbose)
  'rag.md',        // RAG command verbose help (vat rag --help --verbose)
  'agent.md',      // Agent command verbose help (vat agent --help --verbose)
] as const;

/**
 * Shipped docs that NO command serves — reference pages, reached only by a
 * prose link from `docs/index.md`, this repo's CLAUDE.md, or the README.
 *
 * Recorded explicitly because the forward check alone cannot see them: they are
 * published in the npm package (`files: ["docs"]`) and read like verbose help,
 * so an author can reasonably expect `vat audit --help --verbose` to print
 * `audit.md` when in fact nothing does. Every file in `docs/` must be in this
 * set or in {@link REQUIRED_HELP_FILES}, so adding a page forces the author to
 * say which it is.
 */
const PROSE_ONLY_HELP_FILES = new Set([
  'audit.md',
  'doctor.md',
  'mcp.md',
  'skills.md',
  'skill-test.md',
]);

/**
 * Validate the help-docs directory in BOTH directions.
 *
 * @throws {Error} If a required help file is missing, or a shipped doc is
 *   classified as neither command-served nor prose-only.
 */
export function validateHelpFiles(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const packageRoot = safePath.join(__dirname, '../..');
  const docsDir = safePath.join(packageRoot, 'docs');

  const missingFiles: string[] = [];

  for (const filename of REQUIRED_HELP_FILES) {
    const helpPath = safePath.join(docsDir, filename);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is constructed from known safe components
    if (!existsSync(helpPath)) {
      missingFiles.push(filename);
    }
  }

  if (missingFiles.length > 0) {
    const fileList = missingFiles.map(f => `  - docs/${f}`).join('\n');
    throw new Error(
      `Missing required help documentation files:\n${fileList}\n\n` +
      `These files must exist for verbose help (--help --verbose) to work.\n` +
      `Create them before building the CLI package.`
    );
  }

  // Reverse direction: a doc nobody serves and nobody classified.
  const required = new Set<string>(REQUIRED_HELP_FILES);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- docsDir is derived from this module's own location
  const present = readdirSync(docsDir).filter(f => f.endsWith('.md'));
  const unclassified = present.filter(f => !required.has(f) && !PROSE_ONLY_HELP_FILES.has(f));

  if (unclassified.length > 0) {
    const fileList = unclassified.map(f => `  - docs/${f}`).join('\n');
    throw new Error(
      `Unclassified help documentation files:\n${fileList}\n\n` +
      `Every file in packages/cli/docs/ ships in the npm package and must be\n` +
      `either served by a command (add it to REQUIRED_HELP_FILES and call\n` +
      `loadVerboseHelp('<name>') from that command's help path) or recorded as\n` +
      `reference-only (add it to PROSE_ONLY_HELP_FILES). Without this, a page can\n` +
      `be written, published, and never reachable from any --help --verbose.`
    );
  }

  const stalelyClassified = [...PROSE_ONLY_HELP_FILES].filter(f => !present.includes(f));
  if (stalelyClassified.length > 0) {
    throw new Error(
      `PROSE_ONLY_HELP_FILES lists files that no longer exist:\n` +
      stalelyClassified.map(f => `  - docs/${f}`).join('\n') +
      `\n\nRemove the stale entries.`
    );
  }
}

/**
 * Run validation if this file is executed directly
 * (via tsx or node during build process)
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateHelpFiles();
    console.log('✓ All required help documentation files exist');
    process.exit(0);
  } catch (error) {
    console.error('✗ Help file validation failed:');
    console.error((error as Error).message);
    process.exit(1);
  }
}
