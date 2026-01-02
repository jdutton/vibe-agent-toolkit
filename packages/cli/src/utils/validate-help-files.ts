/**
 * Build-time validator for help documentation files
 *
 * Ensures all required markdown help files exist before build completes.
 * This provides "fail fast" behavior - missing help files cause build failure
 * rather than runtime errors when users request verbose help.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Required help documentation files
 * Each entry maps to a file in packages/cli/docs/
 */
const REQUIRED_HELP_FILES = [
  'index.md',      // Root-level verbose help (vat --help --verbose)
  'resources.md',  // Resources command verbose help (vat resources --help --verbose)
  'rag.md',        // RAG command verbose help (vat rag --help --verbose)
  'agent.md',      // Agent command verbose help (vat agent --help --verbose)
] as const;

/**
 * Validate that all required help files exist
 *
 * @throws {Error} If any required help file is missing
 */
export function validateHelpFiles(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const packageRoot = join(__dirname, '../..');
  const docsDir = join(packageRoot, 'docs');

  const missingFiles: string[] = [];

  for (const filename of REQUIRED_HELP_FILES) {
    const helpPath = join(docsDir, filename);
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
}

/**
 * Run validation if this file is executed directly
 * (via tsx or node during build process)
 */
if (import.meta.url === `file://${process.argv[1]}`) {
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
