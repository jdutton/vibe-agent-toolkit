/**
 * Tree-copy stream for plugin build.
 *
 * Copies everything under <sourceDir> to <destDir>, except:
 *   - .claude-plugin/ (owned by plugin.json merge-write)
 *
 * Respects .gitignore via crawlDirectory (respectGitignore: true, the default).
 * Returns counts keyed to the spec's YAML summary extension.
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { crawlDirectory, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

export interface TreeCopyOptions {
  sourceDir: string;
  destDir: string;
  /**
   * Names of `skills/<dir>` entries that ANOTHER build phase produces, and which
   * this verbatim copy must therefore leave alone.
   *
   * A skill is produced by the packager (pool-packaged, or packaged in place from
   * the plugin's own source), never by a verbatim copy — copying a skill dir
   * wholesale is what used to ship eval suites, scratch files, and un-rewritten
   * links to plugin consumers. Callers must pass exactly the dirs they produced:
   * a `skills/` subdirectory that is NOT a skill (a shared helper dir, a template
   * dir, the parent of a nested skill) has no other producer, so excluding it here
   * would drop it from the bundle entirely.
   */
  excludeSkillDirs?: string[];
  warn?: (message: string) => void;
}

export interface TreeCopyResult {
  commandsCopied: number;
  hooksCopied: number;
  agentsCopied: number;
  mcpCopied: number;
  filesCopied: number;
}

const EXCLUDE_PATTERNS = ['.claude-plugin/**'];

function classifyRelative(rel: string): keyof Omit<TreeCopyResult, 'filesCopied'> | undefined {
  if (rel.startsWith('commands/')) return 'commandsCopied';
  if (rel.startsWith('hooks/')) return 'hooksCopied';
  if (rel.startsWith('agents/')) return 'agentsCopied';
  if (rel === '.mcp.json') return 'mcpCopied';
  return undefined;
}

export async function treeCopyPlugin(options: TreeCopyOptions): Promise<TreeCopyResult> {
  const { sourceDir, destDir, excludeSkillDirs = [], warn } = options;
  const result: TreeCopyResult = {
    commandsCopied: 0,
    hooksCopied: 0,
    agentsCopied: 0,
    mcpCopied: 0,
    filesCopied: 0,
  };

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- sourceDir resolved from config
  if (!existsSync(sourceDir)) {
    return result;
  }

  const authorMarketplaceJson = safePath.join(sourceDir, '.claude-plugin', 'marketplace.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  if (existsSync(authorMarketplaceJson) && warn) {
    warn(
      `Ignoring ${toForwardSlash(authorMarketplaceJson)}: marketplace.json is VAT-generated ` +
        `at the marketplace level and cannot be supplied per-plugin.`,
    );
  }

  const exclude = [
    ...EXCLUDE_PATTERNS,
    ...excludeSkillDirs.map((name) => `skills/${name}/**`),
  ];

  const files = await crawlDirectory({
    baseDir: sourceDir,
    include: ['**/*'],
    exclude,
    absolute: true,
    filesOnly: true,
    respectGitignore: true,
  });

  for (const absPath of files) {
    const rel = toForwardSlash(safePath.relative(sourceDir, absPath));
    const target = safePath.join(destDir, rel);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dest resolved from sourceDir+relative
    await mkdir(dirname(target), { recursive: true });
    await copyFile(absPath, target);
    result.filesCopied += 1;

    const bucket = classifyRelative(rel);
    if (bucket) {
      result[bucket] += 1;
    }
  }

  return result;
}
