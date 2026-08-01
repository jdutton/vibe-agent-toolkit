/**
 * Tree-copy stream for plugin build.
 *
 * Copies everything under <sourceDir> to <destDir>, except:
 *   - .claude-plugin/ (owned by plugin.json merge-write)
 *   - agent-instruction files at any depth (CLAUDE.md, AGENTS.md, …)
 *   - anything the caller names in `exclude`
 *
 * Respects .gitignore via crawlDirectory (respectGitignore: true, the default).
 * Returns counts keyed to the spec's YAML summary extension.
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AGENT_INSTRUCTION_FILE_PATTERNS, toAnyDepthGlobs } from '@vibe-agent-toolkit/agent-skills';
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
  /**
   * Project-specific glob patterns (relative to `sourceDir`) to leave out of the
   * bundle — the `exclude:` knob on the marketplace plugin entry.
   *
   * The escape hatch for junk the defaults below cannot know about (scratch dirs,
   * design notes, internal fixtures). Additive to the built-in exclusions.
   */
  exclude?: string[];
  warn?: (message: string) => void;
}

export interface TreeCopyResult {
  commandsCopied: number;
  hooksCopied: number;
  agentsCopied: number;
  mcpCopied: number;
  filesCopied: number;
}

/**
 * Built-in exclusions for the verbatim plugin copy.
 *
 * The agent-instruction list ONLY. `NEVER_PACKAGE_IN_SKILL_BUNDLE` also carries
 * the navigation patterns, and importing that here would strip the front page off
 * three in five real plugins: 57 of 94 installed plugins ship a plugin-root
 * `README.md`, and `copyDistributionFiles` copies READMEs to the marketplace root
 * on purpose. A README is vestigial *inside a skill bundle* and load-bearing at a
 * plugin root — that asymmetry is why the two lists must stay separate.
 */
const EXCLUDE_PATTERNS = [
  '.claude-plugin/**',
  ...toAnyDepthGlobs(AGENT_INSTRUCTION_FILE_PATTERNS),
];

function classifyRelative(rel: string): keyof Omit<TreeCopyResult, 'filesCopied'> | undefined {
  if (rel.startsWith('commands/')) return 'commandsCopied';
  if (rel.startsWith('hooks/')) return 'hooksCopied';
  if (rel.startsWith('agents/')) return 'agentsCopied';
  if (rel === '.mcp.json') return 'mcpCopied';
  return undefined;
}

export async function treeCopyPlugin(options: TreeCopyOptions): Promise<TreeCopyResult> {
  const { sourceDir, destDir, excludeSkillDirs = [], exclude: callerExclude = [], warn } = options;
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
    ...callerExclude,
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
