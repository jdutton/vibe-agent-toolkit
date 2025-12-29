/**
 * Generate CLI reference documentation from --help --verbose output
 * Ensures docs stay synchronized with actual CLI behavior
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const HEADER = `# CLI Reference

> **Complete command-line reference for vat**
>
> **This document is auto-synced with \`vat --help --verbose\` output**
>
> The content below is the exact output from running \`vat --help --verbose\`.
> Last updated: ${new Date().toISOString().split('T')[0]}

<!-- Content below auto-generated -->

`;

export function generateCliDocs(repoRoot: string): void {
  const cliBinPath = join(repoRoot, 'packages/cli/dist/bin.js');
  const docsPath = join(repoRoot, 'docs/cli-reference.md');

  // Verify CLI is built
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are constructed from repoRoot parameter
  if (!existsSync(cliBinPath)) {
    throw new Error(
      `CLI binary not found at ${cliBinPath}. Run 'bun run build:cli' first.`
    );
  }

  // Execute --help --verbose
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is always in PATH for CLI usage
  const result = spawnSync('node', [cliBinPath, '--help', '--verbose'], {
    encoding: 'utf-8',
    env: { ...process.env, VAT_CONTEXT: 'dev' },
  });

  if (result.status !== 0) {
    throw new Error(`Failed to execute CLI: ${result.stderr}`);
  }

  const helpOutput = result.stderr.trim(); // Help goes to stderr
  const newContent = HEADER + helpOutput + '\n';

  // Check if content changed (avoid git churn)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are constructed from repoRoot parameter
  if (existsSync(docsPath)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are constructed from repoRoot parameter
    const existingContent = readFileSync(docsPath, 'utf-8');

    // Compare without date (to avoid false changes)
    const existingWithoutDate = existingContent.replace(/Last updated: .*/, '');
    const newWithoutDate = newContent.replace(/Last updated: .*/, '');

    if (existingWithoutDate === newWithoutDate) {
      console.log('✓ CLI reference documentation is up to date');
      return;
    }
  }

  // Write new documentation
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are constructed from repoRoot parameter
  writeFileSync(docsPath, newContent, 'utf-8');
  console.log(`✓ Generated CLI reference: ${docsPath}`);
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = resolve(process.cwd());
  generateCliDocs(repoRoot);
}
