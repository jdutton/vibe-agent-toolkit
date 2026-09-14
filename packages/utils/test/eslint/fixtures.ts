/**
 * Fixture vocabulary shared by the per-rule suites in `rules/` and the
 * cross-rule suites beside this file. Named once so a table in one suite and a
 * table in another cannot drift to different spellings of the same module.
 */

/**
 * The autofix targets the NARROW subpath that owns `safePath`, not the barrel.
 *
 * The rules used to write `@vibe-agent-toolkit/utils` here while the README
 * table shipped in the same tarball told adopters the replacement lived on
 * `/path` — so the release whose entire purpose was narrow subpaths shipped lint
 * rules that mechanically rewrote code away from them. An adopter running the
 * pack over 4,670 files reported 4,719 such sites.
 */
export const SAFE_PATH_MODULE = '@vibe-agent-toolkit/utils/path';
export const SAFE_FS_MODULE = '@vibe-agent-toolkit/utils/fs';
export const SAFE_PROCESS_MODULE = '@vibe-agent-toolkit/utils/process';
export const BARREL = '@vibe-agent-toolkit/utils';
export const SAFE_IMPORT = `import { safePath } from '${SAFE_PATH_MODULE}';`;
export const PATH_NAMESPACE_IMPORT = "import path from 'node:path';";
export const PATH_IMPORT = `${PATH_NAMESPACE_IMPORT}\n`;
export const LINTED_FILE = 'packages/cli/src/example.ts';

export const NODE_FS = 'node:fs';
export const NODE_PATH = 'node:path';
/** The path module AS IT APPEARS IN SOURCE, quotes and all — several suites assert on
 * whether the import survived a fix, and that is a substring check against the output. */
export const QUOTED_NODE_PATH = "'node:path'";
export const NODE_CHILD_PROCESS = 'node:child_process';

export const PATH_CORE_IMPL = 'packages/utils/src/path-core.ts';
export const PATH_UTILS_IMPL = 'packages/utils/src/path-utils.ts';
export const PATH_UTILS_SPEC = 'packages/utils/test/path-utils.test.ts';
export const SAFE_EXEC_IMPL = 'packages/utils/src/safe-exec.ts';

/** The exempt-file list VAT itself passes for `no-raw-node-path`. */
export const PATH_EXEMPT_OPTIONS = [{ exemptFiles: [PATH_CORE_IMPL, PATH_UTILS_IMPL, PATH_UTILS_SPEC] }];

/**
 * `safeModule` — point the fixer at the CONSUMING repo's re-export seam.
 *
 * The narrow-subpath defaults are right only for a repo importing this package
 * directly. An adopter measured what they cost everyone else: of the 61 packages
 * in their workspace that would receive a new import, **52 (620 files) do not
 * declare `@vibe-agent-toolkit/utils`**. Under pnpm's isolated `node_modules`
 * that import does not degrade, it fails to resolve — so the autofix is only as
 * good as its ability to name a specifier that resolves where the fix lands.
 * Across their top 25 affected packages the default resolved in 0; their seam
 * resolved in 24.
 *
 * PER-RULE, because a seam need not split its symbols the way this package does:
 * theirs carries `normalizedTmpdir` but not `safePath`, so `no-os-tmpdir` and
 * `no-raw-node-path` need different targets — what one shared key cannot express.
 */
export const SEAM = '@acme/dev-tools/path-utils';

/**
 * Rule names, named once. Several tables enumerate the same rules from
 * different angles (fixpoint, suppression, `safeModule`), and a rule renamed in
 * one table and not another is a silently skipped suite, not a failure.
 */
export const RULE = {
  rawPath: 'no-raw-node-path',
  tmpdir: 'no-os-tmpdir',
  mkdir: 'no-fs-mkdirSync',
  realpath: 'no-fs-realpathSync',
  execSync: 'no-child-process-execSync',
  cp: 'no-fs-promises-cp',
  normalize: 'no-manual-path-normalize',
} as const;

/** The three `node:path` functions `no-raw-node-path` wraps, in its default order. */
export const WRAPPED_PATH_FUNCTIONS = ['join', 'resolve', 'relative'] as const;
export type WrappedPathFunction = (typeof WRAPPED_PATH_FUNCTIONS)[number];

/** `import { name } from 'module';` — spelled once, so the tables stay readable. */
export function namedImport(name: string, module: string): string {
  return `import { ${name} } from '${module}';`;
}

/** The archetypal offending decode, reused by `no-raw-text-decode` and the placeholder suite. */
export const BUFFER_UTF8_DECODE = "const t = buf.toString('utf-8');";
