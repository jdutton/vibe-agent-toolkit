#!/usr/bin/env bun
/**
 * Repository Structure Validator
 *
 * Validates that the monorepo structure follows conventions to prevent
 * structural sprawl from agentic development (AI code generation).
 *
 * CRITICAL - Security & Confidentiality:
 * - No credential/secret files (.env, credentials.json, certificate files, etc.)
 * - No proprietary adopter names in any tracked file (see contraband-scan.ts)
 *
 * HIGH PRIORITY - File Location Sprawl:
 * - No nested package.json files (only root and packages directories)
 * - Source files must be in packages src or test directories
 * - Test file naming conventions (.test.ts, not .spec.ts)
 *
 * DURABILITY - Claims that rot in silence:
 * - No citations to files under never-committed (gitignored) directories
 * - Vendor claims annotated with @vendor-claim must be re-verified every 90 days
 * - A lane reporting findings must publish per-severity counts beside its status
 *   (ratcheted: the nonconforming list may only shrink)
 *
 * ORIGINAL RULES:
 * - No /examples directories in runtime packages
 * - No /scripts directories (except dev-tools, schema, agent-skills)
 * - No shell scripts (.sh, .ps1, .bat, .cmd) - use TypeScript
 * - No /staging directories in test/fixtures
 * - Test fixtures follow size guidelines (over 100KB must be compressed)
 *
 * Run: bun run validate-structure
 * Use in CI to catch issues before they reach main branch
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// This utility script needs to read dynamic file paths for validation

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGitOrThrow, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import {
  loadTokens,
  scanTextForContraband,
  TOKENS_DEFAULT_FILE,
  TOKENS_ENV,
} from './contraband-scan.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = safePath.join(__dirname, '../../..');

/**
 * Validation error type constants
 */
const ERROR_TYPES = {
  DANGLING_CITATION: 'dangling-citation',
  FORBIDDEN_DIRECTORY: 'forbidden-directory',
  LARGE_FILE: 'large-file',
  SEVERITY_COUNTS: 'severity-counts',
  STALE_VENDOR_CLAIM: 'stale-vendor-claim',
  STRUCTURAL_VIOLATION: 'structural-violation',
} as const;

/**
 * Common directories to skip during validation
 */
const WORKTREES_DIR = '.worktrees';
const COMMON_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude']);
const SKIP_DIRS_WITH_HUSKY = new Set([...COMMON_SKIP_DIRS, '.husky', WORKTREES_DIR]);

interface ValidationError {
  type:
    | 'dangling-citation'
    | 'forbidden-directory'
    | 'large-file'
    | 'severity-counts'
    | 'stale-vendor-claim'
    | 'structural-violation';
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

const errors: ValidationError[] = [];

/**
 * Extensions treated as human-readable text.
 *
 * Allowlist rather than denylist: the content rules below (NUL bytes, dangling
 * citations, vendor-claim staleness) all exist to protect greppable prose and
 * source, so a newly-introduced binary format should never trip them. Note that
 * extensionless files (`.gitignore`, `LICENSE`) are therefore not scanned.
 */
const TEXT_FILE_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.patch',
  '.py', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);

/**
 * Helper: apply a handler to the raw bytes of every git-tracked text file.
 *
 * Tracked-only is deliberate: these rules are about what a *clean clone* shows a
 * contributor, so untracked working-tree files are out of scope by construction.
 */
async function forEachTrackedTextFile(
  handler: (relPath: string, contents: Buffer) => void,
): Promise<void> {
  // `trim: false` — the listing is NUL-delimited, and a path beginning with a
  // space sorts first, so a trim would rename it out of the population.
  const tracked = runGitOrThrow(['ls-files', '-z'], {
    cwd: REPO_ROOT,
    trim: false,
  }) as string;

  for (const relPath of tracked.split('\0')) {
    if (!relPath || !TEXT_FILE_EXTENSIONS.has(extname(relPath).toLowerCase())) {
      continue;
    }

    const fullPath = safePath.join(REPO_ROOT, relPath);
    let contents: Buffer;
    try {
      contents = await readFile(fullPath);
    } catch {
      continue; // Tracked but absent from the working tree (e.g. sparse checkout)
    }

    handler(relPath, contents);
  }
}

/**
 * Helper: apply a handler to every line of every git-tracked text file.
 *
 * The whole `lines` array is passed alongside the index so a rule can inspect a
 * window around the match (some annotations and disclaimers wrap across lines).
 */
async function forEachTrackedTextFileLine(
  handler: (ctx: { relPath: string; lines: readonly string[]; index: number }) => void,
): Promise<void> {
  await forEachTrackedTextFile((relPath, contents) => {
    const lines = contents.toString('utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      handler({ relPath, lines, index });
    }
  });
}

/**
 * Helper: Walk directory tree recursively, calling handler for each entry
 */
async function walkDirectory(
  dir: string,
  relativePath: string,
  options: {
    skipDirs?: Set<string>;
    onDirectory?: (entry: { name: string; fullPath: string; relPath: string }) => Promise<void>;
    onFile?: (entry: { name: string; fullPath: string; relPath: string }) => Promise<void>;
  },
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Directory doesn't exist or not accessible
  }

  for (const entry of entries) {
    const fullPath = safePath.join(dir, entry.name);
    const relPath = safePath.join(relativePath, entry.name);

    if (entry.isDirectory()) {
      // Check if we should skip this directory
      if (options.skipDirs?.has(entry.name)) {
        continue;
      }

      // Call directory handler
      if (options.onDirectory) {
        await options.onDirectory({ name: entry.name, fullPath, relPath });
      }

      // Recurse into subdirectory
      await walkDirectory(fullPath, relPath, options);
    } else if (entry.isFile()) {
      // Call file handler
      if (options.onFile) {
        await options.onFile({ name: entry.name, fullPath, relPath });
      }
    }
  }
}

/**
 * Helper: Apply checker function to all package test/fixtures directories
 */
async function forEachPackageFixturesDir(
  checkDirectory: (dir: string, relativePath: string) => Promise<void>,
): Promise<void> {
  const packagesDir = safePath.join(REPO_ROOT, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const fixturesDir = safePath.join(packagesDir, entry.name, 'test', 'fixtures');
      await checkDirectory(fixturesDir, `packages/${entry.name}/test/fixtures`);
    }
  }
}

/**
 * Rule 1: No /examples directories in runtime-* packages
 * Demos should be in vat-example-cat-agents/examples/
 */
async function validateNoRuntimeExamples(): Promise<void> {
  const packagesDir = safePath.join(REPO_ROOT, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    // Check runtime-* packages for /examples
    if (entry.name.startsWith('runtime-')) {
      const examplesDir = safePath.join(packagesDir, entry.name, 'examples');
      if (existsSync(examplesDir)) {
        errors.push({
          type: ERROR_TYPES.FORBIDDEN_DIRECTORY,
          path: `packages/${entry.name}/examples/`,
          message: `Runtime packages should not have /examples directories. Move demos to vat-example-cat-agents/examples/`,
          severity: 'error',
        });
      }
    }
  }
}

/**
 * Rule 2: Only specific packages can have /scripts
 * Prevents utility sprawl across packages
 * Allowed: dev-tools (repo utilities), schema, agent-skills (schema generation)
 */
async function validateScriptsLocation(): Promise<void> {
  const packagesDir = safePath.join(REPO_ROOT, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });

  const allowedScriptsPackages = new Set([
    'dev-tools',
    'schema',
    'agent-skills',
    'vat-example-cat-agents', // Uses resource-compiler post-build script
    'vat-development-agents', // Uses resource-compiler post-build script
  ]);

  for (const entry of entries) {
    if (!entry.isDirectory() || allowedScriptsPackages.has(entry.name)) {
      continue;
    }

    const scriptsDir = safePath.join(packagesDir, entry.name, 'scripts');
    if (existsSync(scriptsDir)) {
      errors.push({
        type: ERROR_TYPES.FORBIDDEN_DIRECTORY,
        path: `packages/${entry.name}/scripts/`,
        message: `Only dev-tools, schema, and agent-skills should have /scripts directories. Move utilities to dev-tools package.`,
        severity: 'error',
      });
    }
  }
}

/**
 * Rule 3: No large test fixtures (>100KB) unless compressed
 * Prevents repo bloat from test data
 */
async function validateTestFixtureSizes(): Promise<void> {
  const MAX_SIZE_KB = 100;
  const ALLOWED_LARGE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.tgz', '.tar.gz']);

  async function checkFixturesDir(dir: string, relativePath: string): Promise<void> {
    await walkDirectory(dir, relativePath, {
      onFile: async ({ name, fullPath, relPath }) => {
        const stats = await stat(fullPath);
        const sizeKB = stats.size / 1024;

        if (sizeKB > MAX_SIZE_KB) {
          const ext = name.substring(name.lastIndexOf('.'));
          const isCompressed = ALLOWED_LARGE_EXTENSIONS.has(ext.toLowerCase());

          if (!isCompressed) {
            errors.push({
              type: ERROR_TYPES.LARGE_FILE,
              path: relPath,
              message: `File is ${Math.round(sizeKB)}KB (>${MAX_SIZE_KB}KB). Compress large test fixtures or use external storage.`,
              severity: 'warning',
            });
          }
        }
      },
    });
  }

  await forEachPackageFixturesDir(checkFixturesDir);
}

/**
 * Rule 4: No shell scripts (.sh, .ps1, .bat, .cmd)
 * All automation must be TypeScript for cross-platform compatibility
 */
async function validateNoShellScripts(): Promise<void> {
  const FORBIDDEN_EXTENSIONS = new Set(['.sh', '.ps1', '.bat', '.cmd']);
  const skipDirs = SKIP_DIRS_WITH_HUSKY;

  await walkDirectory(REPO_ROOT, '.', {
    skipDirs,
    onFile: async ({ name, relPath }) => {
      const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
      if (FORBIDDEN_EXTENSIONS.has(ext)) {
        errors.push({
          type: ERROR_TYPES.FORBIDDEN_DIRECTORY,
          path: relPath,
          message: `Shell scripts are forbidden. Use TypeScript for cross-platform automation (packages/dev-tools/src/).`,
          severity: 'error',
        });
      }
    },
  });
}

/**
 * Rule 5: No /staging directories in test/fixtures
 * Staging directories should be temporary and not committed
 */
async function validateNoStagingDirectories(): Promise<void> {
  async function checkFixturesDir(dir: string, relativePath: string): Promise<void> {
    await walkDirectory(dir, relativePath, {
      onDirectory: async ({ name, relPath }) => {
        if (name === 'staging') {
          errors.push({
            type: ERROR_TYPES.FORBIDDEN_DIRECTORY,
            path: relPath,
            message: `Staging directories should not be committed. Add to .gitignore and remove from git.`,
            severity: 'error',
          });
        }
      },
    });
  }

  await forEachPackageFixturesDir(checkFixturesDir);
}

/**
 * Rule 6: No nested package.json files (except in packages/)
 * Prevents AI creating sub-packages or component-level package.json files
 */
async function validateNoNestedPackageJson(): Promise<void> {
  const skipDirs = new Set([...COMMON_SKIP_DIRS, WORKTREES_DIR]);

  await walkDirectory(REPO_ROOT, '.', {
    skipDirs,
    onFile: async ({ name, relPath }) => {
      if (name === 'package.json') {
        // Normalize path separators
        const normalizedPath = relPath.replaceAll('\\', '/');

        // Check if it's in a valid location
        const isRootPackageJson = normalizedPath === 'package.json';
        const isInPackagesDir = /^packages\/[^/]+\/package\.json$/.test(normalizedPath);
        const isInTestFixtures = /^packages\/[^/]+\/test\/fixtures\//.test(normalizedPath);

        if (!isRootPackageJson && !isInPackagesDir && !isInTestFixtures) {
          errors.push({
            type: ERROR_TYPES.FORBIDDEN_DIRECTORY,
            path: relPath,
            message: `Nested package.json detected. Only root, packages/*/, and test/fixtures/ can have package.json files.`,
            severity: 'error',
          });
        }
      }
    },
  });
}

/**
 * Rule 7: Source files must be in src/ or test/ directories
 * Prevents .ts files in wrong locations
 */
async function validateSourceFileLocations(): Promise<void> {
  const skipDirs = SKIP_DIRS_WITH_HUSKY;

  const ALLOWED_ROOT_TS_FILES = new Set([
    // Root config files
    'eslint.config.ts',
    'vitest.config.ts',
    'vitest.integration.config.ts',
    'vitest.system.config.ts',
    'vitest.shared.ts',
    'vitest.workspace.ts',
  ]);

  await walkDirectory(REPO_ROOT, '.', {
    skipDirs,
    onFile: async ({ name, relPath }) => {
      if (!name.endsWith('.ts')) {
        return;
      }

      const normalizedPath = relPath.replaceAll('\\', '/');

      // Allow root config files
      if (ALLOWED_ROOT_TS_FILES.has(normalizedPath)) {
        return;
      }

      // Allow package-level config files (vitest, knip, etc.)
      if (/^packages\/[^/]+\/(vitest\.(config|integration\.config|system\.config)|knip\.config)\.ts$/.test(normalizedPath)) {
        return;
      }

      // Allow schema/scripts (build tooling for JSON Schema generation)
      if (normalizedPath.startsWith('packages/schema/scripts/')) {
        return;
      }

      // Allow agent-skills/scripts (build tooling for JSON Schema generation)
      if (normalizedPath.startsWith('packages/agent-skills/scripts/')) {
        return;
      }

      // Allow skill-test eval fixtures (test input for `vat skill test`, often
      // intentionally broken TypeScript the eval asks an agent to review — not source).
      // NOTE: the `resources/skills/evals/` exclusion is mirrored in eslint.config.js
      // (ignores) and vibe-agent-toolkit.config.yaml (resources.exclude). Keep all
      // three in sync if this path ever moves.
      if (/^packages\/[^/]+\/resources\/skills\/evals\//.test(normalizedPath)) {
        return;
      }

      // Check if in valid location
      const isInPackageSrc = /^packages\/[^/]+\/src\//.test(normalizedPath);
      const isInPackageTest = /^packages\/[^/]+\/test\//.test(normalizedPath);
      const isInPackageExamples = /^packages\/[^/]+\/examples\//.test(normalizedPath);
      const isInPackageAgents = /^packages\/[^/]+\/agents\//.test(normalizedPath); // For vat-development-agents
      const isInPackageGenerated = /^packages\/[^/]+\/generated\//.test(normalizedPath); // Build artifacts
      const isInPackageScripts = /^packages\/[^/]+\/scripts\//.test(normalizedPath); // Build scripts
      const isInDocs = normalizedPath.startsWith('docs/');

      if (!isInPackageSrc && !isInPackageTest && !isInPackageExamples && !isInPackageAgents && !isInPackageGenerated && !isInPackageScripts && !isInDocs) {
        errors.push({
          type: ERROR_TYPES.STRUCTURAL_VIOLATION,
          path: relPath,
          message: `TypeScript file in wrong location. Source files must be in packages/*/src/, packages/*/test/, or packages/*/examples/.`,
          severity: 'error',
        });
      }
    },
  });
}

/**
 * Rule 8: Test file naming conventions
 * Enforces consistent test patterns across the codebase
 */
async function validateTestFileNaming(): Promise<void> {
  await walkDirectory(REPO_ROOT, '.', {
    skipDirs: COMMON_SKIP_DIRS,
    onFile: async ({ name, relPath }) => {
      const normalizedPath = relPath.replaceAll('\\', '/');

      // Check for .spec.ts files (we use .test.ts)
      if (name.endsWith('.spec.ts')) {
        errors.push({
          type: ERROR_TYPES.STRUCTURAL_VIOLATION,
          path: relPath,
          message: `Use .test.ts instead of .spec.ts for consistency.`,
          severity: 'error',
        });
      }

      // Check that integration tests are in test/integration/
      if (name.endsWith('.integration.test.ts') && !normalizedPath.includes('/test/integration/')) {
        errors.push({
          type: ERROR_TYPES.STRUCTURAL_VIOLATION,
          path: relPath,
          message: `Integration tests must be in test/integration/ directory.`,
          severity: 'error',
        });
      }

      // Check that system tests are in test/system/
      if (name.endsWith('.system.test.ts') && !normalizedPath.includes('/test/system/')) {
        errors.push({
          type: ERROR_TYPES.STRUCTURAL_VIOLATION,
          path: relPath,
          message: `System tests must be in test/system/ directory.`,
          severity: 'error',
        });
      }

      // Check that regular test files are NOT in integration/ or system/
      if (
        name.endsWith('.test.ts') &&
        !name.endsWith('.integration.test.ts') &&
        !name.endsWith('.system.test.ts') &&
        (normalizedPath.includes('/test/integration/') || normalizedPath.includes('/test/system/'))
      ) {
        errors.push({
          type: ERROR_TYPES.STRUCTURAL_VIOLATION,
          path: relPath,
          message: `Unit tests in integration/system directories must use .integration.test.ts or .system.test.ts suffix.`,
          severity: 'error',
        });
      }
    },
  });
}

/**
 * Fail on any proprietary adopter name that has entered a git-tracked file.
 *
 * The population is `git ls-files` — every tracked text file, defined independently of
 * the tokens being searched for — so this asserts ABSENCE rather than classifying files.
 * See {@link file://./contraband-scan.ts} for why that distinction matters, why the token
 * list is stored hashed, and how to add an entry.
 *
 * Severity is `error`, not `warning`: unlike the other rules here, a violation that
 * reaches `main` is unfixable — it lands in public git history, GitHub release bodies,
 * and npm tarballs, none of which a later commit can retract.
 */
async function validateNoContrabandTokens(): Promise<void> {
  const { tokens, path: tokensPath } = loadTokens(REPO_ROOT);
  if (tokens.length === 0) {
    errors.push({
      type: ERROR_TYPES.STRUCTURAL_VIOLATION,
      path: TOKENS_DEFAULT_FILE,
      message: `No contraband token list found, so the adopter-name gate did not run. Set $${TOKENS_ENV} to a token file, or create a gitignored ${TOKENS_DEFAULT_FILE} in the repo root (one token per line). CI must supply this — a confidentiality gate that finds nothing because it has nothing to look for reads as a clean bill of health.`,
      severity: 'warning',
    });
    return;
  }
  console.log(`   contraband scan: ${tokens.length} token(s) from ${tokensPath ?? 'an unnamed source'}`);

  // `trim: false` — NUL-delimited, and this population is a confidentiality
  // gate: a path dropped from it is a file the scan never reads.
  const lsFiles = String(runGitOrThrow(['ls-files', '-z'], { cwd: REPO_ROOT, trim: false }));
  const tracked = lsFiles
    .split('\0')
    .filter((p: string) => p.length > 0)
    .filter((p: string) => !BINARY_EXTENSION.test(p));

  for (const relPath of tracked) {
    let text: string;
    try {
      text = await readFile(safePath.join(REPO_ROOT, relPath), 'utf8');
    } catch {
      continue; // unreadable or deleted-but-tracked; other rules cover structure
    }
    for (const hit of scanTextForContraband(text, tokens)) {
      errors.push({
        type: ERROR_TYPES.STRUCTURAL_VIOLATION,
        path: `${relPath}:${hit.line}`,
        // Never echo the matched text — that would reintroduce the name into CI logs.
        message: `Proprietary adopter name (${hit.form} form) detected. These must never enter this public repo: a leak here cannot be retracted from git history, releases, or npm. Replace it with an abstract description ("an adopter", "a 90-skill adopter") or a synthetic example.`,
        severity: 'error',
      });
    }
  }
}

/**
 * Rule 9: Text source files must not contain NUL bytes
 *
 * Git and ripgrep classify a file as binary when it contains a NUL byte in its
 * first 8000 bytes, and then report only "Binary file X matches" — they never
 * print the matching line. So a single stray NUL makes a source file invisible
 * to every grep-based sweep over the repo: audits, refactors, and codemods all
 * skip it silently while appearing to succeed.
 *
 * This is an agentic-development hazard specifically: an AI edit that means to
 * emit the two-character escape `\0` can emit the raw control byte instead, and
 * nothing else in the toolchain complains (it is a legal SourceCharacter, so
 * ESLint and tsc both pass it clean).
 */
async function validateNoNulBytesInTextFiles(): Promise<void> {
  await forEachTrackedTextFile((relPath, contents) => {
    const offset = contents.indexOf(0);
    if (offset === -1) {
      return;
    }

    const line = contents.subarray(0, offset).toString('utf8').split('\n').length;
    errors.push({
      type: ERROR_TYPES.STRUCTURAL_VIOLATION,
      path: relPath,
      message:
        `Contains a NUL byte at line ${line} (offset ${offset}). Git and ripgrep will ` +
        `treat this file as binary and skip its contents, hiding it from every ` +
        `grep-based sweep. Replace the raw byte with the escape sequence ` +
        String.raw`\0` +
        `, or drop the sentinel entirely.`,
      severity: 'error',
    });
  });
}

/**
 * Directories that are gitignored and therefore NEVER present in a clone.
 *
 * The invariant: because git never carries these paths, any reference to a *file*
 * inside one is dangling by construction — not by accident, and not something a
 * link checker will ever catch, since there is no version of the repository in
 * which the target exists. A reader who is told "per <spec> §6" and cannot open
 * <spec> has been handed an unfalsifiable justification.
 *
 * Keep in sync with .gitignore (currently lines 88-90).
 */
const NEVER_COMMITTED_DIRS = ['docs/plans/', 'docs/superpowers/', '.superpowers/'] as const;

/**
 * Where a design doc goes when it needs to be citable.
 * See docs/research/2026-06-24-skill-test-eval-runner-design.md, whose own
 * preamble records that it was promoted out of a gitignored dir for this reason.
 */
const PROMOTED_DOC_HOME = 'docs/research/';

/**
 * Tail of a path that names a concrete FILE (…/something.ext) rather than a
 * directory or a glob. This is the whole basis for telling a citation apart from
 * a pattern: `docs/plans/**` and `docs/plans/` name the directory, whereas
 * `docs/plans/<some-design>.md` claims a readable source exists.
 */
const CITED_FILE_TAIL = /^[\w./-]*[\w-]\.[a-z]{2,5}/;

/**
 * Phrases that make a citation self-disclaiming.
 *
 * If the prose around the path already tells the reader the target is not in the
 * repository, the pointer misleads nobody — and saying so is precisely the
 * fallback this gate recommends when a doc cannot be promoted. Scanned over a
 * small window because the path and the disclaimer often land on adjacent lines.
 */
const CITATION_DISCLAIMERS = [
  'not in the repository',
  'not in the repo',
  'not tracked',
  'untracked',
  'gitignored',
  'not committed',
  'uncommitted',
  'never committed',
];
const CITATION_DISCLAIMER_WINDOW = 2;

/** Collect every reference on `line` that names a file under a never-committed dir. */
function findNeverCommittedCitations(line: string): string[] {
  const found: string[] = [];

  for (const dir of NEVER_COMMITTED_DIRS) {
    let at = line.indexOf(dir);
    while (at !== -1) {
      const tail = CITED_FILE_TAIL.exec(line.slice(at + dir.length));
      if (tail) {
        found.push(dir + tail[0]);
      }
      at = line.indexOf(dir, at + dir.length);
    }
  }

  return found;
}

/** True when the prose around `index` admits the cited target is not committed. */
function isSelfDisclaimingCitation(lines: readonly string[], index: number): boolean {
  const from = Math.max(0, index - CITATION_DISCLAIMER_WINDOW);
  const to = Math.min(lines.length, index + CITATION_DISCLAIMER_WINDOW + 1);
  const window = lines.slice(from, to).join(' ').toLowerCase();
  return CITATION_DISCLAIMERS.some((phrase) => window.includes(phrase));
}

/**
 * Rule 10: No citations to files under never-committed directories
 *
 * `docs/plans/` and `docs/superpowers/` are gitignored working dirs. Tracked files
 * that cite documents inside them point at nothing a contributor or adopter can
 * open, and the prose is usually load-bearing ("Per spec … §6"), so the rule the
 * citation stood for cannot be reconstructed.
 *
 * The rule, stated: a reference counts as a *citation* only when it names a
 * concrete file (a path segment with an extension). Naming the directory itself —
 * as an exclusion glob (`docs/plans/**`), or in prose explaining the convention —
 * is not a citation and is never reported. A citation is additionally exempt when
 * the surrounding lines say the target is not committed.
 */
async function validateNoCitationsToNeverCommittedDirs(): Promise<void> {
  await forEachTrackedTextFileLine(({ relPath, lines, index }) => {
    const citations = findNeverCommittedCitations(lines[index] ?? '');
    if (citations.length === 0 || isSelfDisclaimingCitation(lines, index)) {
      return;
    }

    for (const cited of citations) {
      errors.push({
        type: ERROR_TYPES.DANGLING_CITATION,
        path: `${relPath}:${index + 1}`,
        message:
          `Cites \`${cited}\`, which is gitignored and so absent from every clone — ` +
          `the citation is dangling by construction, not by accident. Fix it one of ` +
          `three ways: promote the document into a committed location (` +
          `${PROMOTED_DOC_HOME} is this repo's home for promoted design docs) and cite ` +
          `it there; inline the rule the citation was standing in for; or, if neither ` +
          `is possible, state in the same breath that the target is not committed ` +
          `(e.g. "(uncommitted)") so the reader is not sent looking.`,
        // Warning, not error: the existing citations predate this gate, and a
        // dangling pointer never breaks a build. Visible on every run instead.
        severity: 'warning',
      });
    }
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Gate: a lane that reports findings must publish per-severity COUNTS beside
 * its status, not only the status.
 *
 * Every "issues → status" collapse in this repo maps a three-valued severity
 * distribution onto two or three status values, and every one of them resolves
 * the unrepresentable case to the REASSURING answer: info-only ⇒ `success`,
 * warnings ⇒ "All validations passed". That direction is why none of it was ever
 * reported as a bug — it yields silence, never a false alarm. A consumer cannot
 * recover the distribution from the status, so the distribution has to travel
 * next to it. Publishing counts does not make the collapse correct; it makes the
 * collapse *checkable* by a consumer that disagrees with it.
 *
 * This lands as a RATCHET rather than a warning. A warning on 20 existing lanes
 * is a warning everyone learns to scroll past. The ratchet asserts both
 * directions: a listed lane must still be nonconforming (so fixing one without
 * removing it from the list fails the build), and any findings-reporting lane
 * missing from all three buckets fails (so a new lane must be classified at
 * birth). The list can therefore only shrink.
 *
 * HONEST LIMITATIONS: both questions — "is this a lane?" and "does it publish the
 * distribution?" — are answered from SOURCE TEXT, by the recognisers below. Every
 * limitation is therefore a way that text can be right while the recogniser is
 * wrong. Split by which question it damages, because the two fail in opposite
 * directions: a missed LANE is silent, a missed COUNTS block is loud.
 *
 * Limits on seeing a lane at all — these fail SILENTLY, the direction that matters:
 *   - A status typed by a named alias declared in ANOTHER file is invisible. The
 *     alias recogniser reads a `type <X>Status = '…'` declaration, so it only sees
 *     the file that OWNS the vocabulary. A lane doing `import type { RunStatus }`
 *     and never spelling a literal is seen only if it calls the shared collapse.
 *     Nothing in this repo does that today; the day one does, it joins silently.
 *   - The alias name must contain `Status`. `type Verdict = 'ok' | 'error'` is not
 *     matched. Widening to any string-literal union would sweep in every unrelated
 *     enum in three package roots, and an over-inclusive scan gets its escape hatch
 *     used until the escape hatch is where lanes go to disappear.
 *   - A status computed rather than declared — assembled from a variable, or
 *     returned by a local helper with an inferred type — is invisible unless the
 *     helper is the shared one.
 *
 * Limits on judging conformance — these fail LOUDLY (a fixed lane stays listed):
 *   - It cannot tell whether the counts block is actually reached at runtime.
 *   - Counts published under a name outside `issueCounts`/`severityCounts`/`counts`
 *     are seen only when they carry the `errors`+`warnings`+`info` SHAPE, or came
 *     from the shared counter. Two of three severity names, or three different
 *     names, still reads as nonconforming.
 *   - The property must start a line. That is deliberate — matching the bare word
 *     anywhere is what made an earlier keyword scan call `packaging-validator.ts`
 *     conforming, because the word "counts" appeared in one of its comments — but
 *     it does mean a counts block written inline on one line reads as
 *     nonconforming. The failure direction is a lane that stays on the list after
 *     being fixed, which someone notices; not a lane that leaves it unfixed.
 *   - Comments are STRIPPED before any of these tests run. `packaging-validator.ts`
 *     fooled the scan a second time the moment a doc comment was added telling
 *     readers to call `countBySeverity(result.allErrors)` — prose about the fix
 *     read as the fix. A comment-only false positive fails in the *reassuring*
 *     direction (a lane silently leaves the checklist), which is the one direction
 *     this ratchet exists to prevent, so it is worth the crude stripper below.
 *
 * And one limitation that is neither: the unit of judgement is the FILE. A file
 * declaring two verdicts — as `corpus/report.ts` does — is classified once, so a
 * bucket entry can be true of one of them and say nothing about the other. That is
 * why the bucket notes name each verdict separately.
 *
 * It is a checklist that cannot rot, not a proof of correct output. That coarseness
 * is why the bucket notes below are hand-verified rather than inferred.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Strip `/* *\/` blocks and `//` line comments so prose ABOUT the counts contract
 * cannot read as the contract.
 *
 * Crude on purpose — it is not a TypeScript parser. The `//` arm requires the
 * slashes to be preceded by start-of-line or whitespace, which keeps `https://`
 * inside a string literal intact; a `//` inside a quoted string mid-line would
 * still truncate that line, and losing a line can only move a lane from
 * conforming to nonconforming, which fails loudly.
 */
function stripTsComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** Roots whose `.ts` files are scanned for findings-reporting lanes. */
const SEVERITY_COUNTS_SCAN_ROOTS = [
  'packages/cli/src/commands/',
  'packages/agent-skills/src/validators/',
  'packages/claude-marketplace/src/',
] as const;

/**
 * The verdict vocabulary, as ONE alternation shared by every recogniser below.
 *
 * Written once on purpose. It used to live inline in the status-value regex alone,
 * and it omitted `ok` — which is exactly the success value `corpus/report.ts`'s
 * `ReviewStatus` uses. A vocabulary that exists in one place cannot drift out of
 * step with a second copy that a later recogniser would have needed.
 */
const STATUS_VOCABULARY = 'success|error|warning|failed|ok';

/** A status drawn from the validation vocabulary, as an emitted or declared value. */
// eslint-disable-next-line security/detect-non-literal-regexp -- composed from module constants, never from input
const VALIDATION_STATUS_VALUE = new RegExp(String.raw`status\??:[^'\n]*'(?:${STATUS_VOCABULARY})'`);
/**
 * A DECLARED status vocabulary: `type <Something>Status = 'ok' | 'error' | …`.
 *
 * Independent evidence of a lane, like {@link SHARED_COLLAPSE_CALL} and for the
 * same reason: a TypeScript type-alias declaration is a structural fact about the
 * file, not a keyword shape that a refactor can rename away. It exists because
 * {@link VALIDATION_STATUS_VALUE} requires a string LITERAL on the `status:` line,
 * so the moment a lane hoists its vocabulary into a named type — `status:
 * ReviewStatus` — the lane became invisible to the ratchet entirely. Invisible is
 * the worst failure this gate has: it is silent, so nothing ever notices.
 *
 * `[^;]{0,200}?` spans the line breaks of a multi-line union while stopping at the
 * statement terminator, so a later unrelated string cannot be read as a member.
 */
// eslint-disable-next-line security/detect-non-literal-regexp -- composed from module constants, never from input
const DECLARED_STATUS_VOCABULARY = new RegExp(
  String.raw`^[ \t]*(?:export[ \t]+)?type[ \t]+\w*Status\b[^;]{0,200}?'(?:${STATUS_VOCABULARY})'`,
  'm',
);
/**
 * A collection of findings, which is what makes a status a *validation* verdict.
 *
 * This list is the recogniser's weak point, and it has already failed twice for
 * the same reason: a lane names its findings something the list does not know,
 * and silently leaves the population. `audit.ts` escaped via its *status* (see
 * `classifySeverityCountsLane`); `pipeline/check.ts` escaped via its findings,
 * which it calls `violations`. When adding a lane, either reuse a noun already
 * here or add yours — a lane the scan cannot see is a lane no one is ratcheting.
 */
const FINDINGS_COLLECTION = /\b(?:issues|allErrors|activeErrors|activeWarnings|errors|warnings|findings|violations)\b\s*[:.]/;
/**
 * A call to the ONE shared issues→status/counts pair.
 *
 * Independent evidence of a findings-reporting lane, and stronger than any
 * keyword: a file that calls `countBySeverity` has the distribution in hand
 * whatever it names the array it counted. Migrating `corpus/runner.ts` onto the
 * shared pair deleted its last `errors:`-shaped line and made it INVISIBLE to
 * {@link FINDINGS_COLLECTION} — the population must not be defined by a keyword
 * that a legitimate refactor can delete.
 */
const SHARED_COLLAPSE_CALL = /\b(?:calculateValidationStatus|countBySeverity)\s*\(/;
/**
 * A per-severity counts block, as an object property — not a local, not a comment.
 *
 * `[:,]` accepts the ES shorthand `issueCounts,` as well as `issueCounts: ...`;
 * shorthand publishes the same field to the same consumer, and requiring the
 * colon made a genuinely fixed lane read as nonconforming.
 */
const SEVERITY_COUNTS_PROPERTY = /^[ \t]*(?:issueCounts|severityCounts|counts)\??[ \t]*[:,]/m;
/**
 * The per-severity counts SHAPE — `errors`, `warnings` AND `info` all declared as
 * properties — whatever the block containing them is called.
 *
 * Name-independent on purpose: `corpus/report.ts` publishes exactly the
 * `SeverityCounts` fields under the name `summary`, built by spreading
 * `countBySeverity` in its runner. Judging that block by its name alone called a
 * conforming lane nonconforming. All three are required together because `errors`
 * alone is just a findings array, and `info` is the bucket every collapse in this
 * repo loses — a shape that names `info` is a distribution, not a pass/fail pair.
 *
 * Three independent line-anchored tests rather than one regex spanning the block:
 * adjacency would have to be expressed as a nested quantifier, and a nested
 * quantifier here buys strictness this gate does not need at a cost the linter
 * correctly refuses. Not requiring adjacency can only over-accept, and
 * over-accepting fails LOUDLY — a lane listed as conforming that is not will be
 * caught by the reader of the bucket note, which is hand-verified anyway.
 */
const SEVERITY_COUNTS_SHAPE_PARTS = [
  /^[ \t]*errors\??[ \t]*[:,]/m,
  /^[ \t]*warnings\??[ \t]*[:,]/m,
  /^[ \t]*info\??[ \t]*[:,]/m,
] as const;
/**
 * Derivation from the shared `SeverityCounts` type, which is STRONGER evidence
 * than {@link SEVERITY_COUNTS_SHAPE_PARTS}: three hand-declared properties are a
 * shape someone re-verifies by eye, whereas `interface X extends SeverityCounts`
 * is enforced by the compiler and gains any bucket the shared type gains.
 *
 * This arm exists because the refactor that STRENGTHENED a lane broke the gate.
 * `corpus/report.ts` hand-declared `errors`/`warnings`/`info` on `AuditSummary`
 * even though `corpus/runner.ts` builds it by spreading `countBySeverity()`;
 * making it `extends SeverityCounts` deleted all three declarations and this
 * gate reported the improved file as a REGRESSION. Same failure mode that
 * `SHARED_COLLAPSE_CALL` was added for, one level up in the type system: a
 * population defined by a keyword is emptied by the refactor that fixes it.
 *
 * DERIVATION only — `extends` or an intersection. A bare mention is NOT enough,
 * and the first version of this arm which accepted one was measurably wrong: it
 * certified a file for a string literal (`'expected SeverityCounts'`), a pure
 * CONSUMER (`function render(c: SeverityCounts)`), a bare re-export, and even an
 * unrelated identifier of the same name. Worse, it silently WEAKENED the ratchet
 * on the three listed lanes that conform via {@link SEVERITY_COUNTS_PROPERTY}
 * rather than the shared collapse (`phase-utils.ts`, `skills/package.ts`,
 * `validators/types.ts`): deleting the counts field from any of them leaves the
 * `import type { SeverityCounts }` line behind, which the bare name matched — so
 * the regression each of their bucket notes exists to catch went silent.
 *
 * Deriving is the only shape that actually publishes the distribution, and it is
 * what `corpus/report.ts` does. Consuming one is not publishing one.
 */
const SHARED_COUNTS_TYPE = /\bextends\s+SeverityCounts\b|\bSeverityCounts\s*&|&\s*SeverityCounts\b/;

/** Lanes that publish a per-severity counts block beside their status. */
const SEVERITY_COUNTS_CONFORMING = new Set<string>([
  'packages/cli/src/commands/resources/validate.ts',
  // Migrated onto the shared `calculateValidationStatus` + `countBySeverity`
  // pair, which ended five separate collapses and three different answers for
  // an info-only issue set.
  'packages/cli/src/commands/audit.ts',
  'packages/cli/src/commands/claude/marketplace/validate.ts',
  'packages/cli/src/commands/corpus/runner.ts',
  'packages/agent-skills/src/validators/types.ts',
  'packages/agent-skills/src/validators/skill-validator.ts',
  'packages/agent-skills/src/validators/unified-validator.ts',
  'packages/agent-skills/src/validators/marketplace-validator.ts',
  'packages/agent-skills/src/validators/registry-validator.ts',
  'packages/claude-marketplace/src/validators/plugin-validator.ts',
  'packages/cli/src/commands/verify.ts',
  'packages/cli/src/commands/build.ts',
  // Newly ENTERED the lane population by migrating onto the shared collapse: its
  // `status` used to be the two-valued packaging gate verdict, which structurally
  // could not say `warning` while the command exited 1 for one.
  'packages/cli/src/commands/skill/review.ts',
  // File counts and finding counts are now named apart (`summary.filesWith*` vs
  // `issueCounts`), so the two denominators can no longer be read as one.
  'packages/cli/src/commands/audit/hierarchical-output.ts',
  'packages/cli/src/commands/skills/validate.ts',
  'packages/cli/src/commands/skills/build.ts',
  'packages/cli/src/commands/claude/plugin/build.ts',
  // Publishes `ValidationResult.issueCounts` and never calls the shared counter,
  // so it conforms only because the block is built from a real object
  // (`{ issueCounts: counts }` → `yaml.stringify`) rather than hand-spelled
  // `process.stdout.write` lines. Written that way ON PURPOSE: a hand-spelled
  // line is invisible to this gate's source scan.
  'packages/cli/src/commands/skills/package.ts',
  'packages/cli/src/commands/audit-settings.ts',
  'packages/claude-marketplace/src/settings/settings-auditor.ts',
  // Entered the lane population when child stdout stopped being inherited and
  // started being folded into `phases[]`. It declares the `issueCounts` field of
  // `PhaseResult` — the in-process phases in `verify.ts`/`build.ts` populate it,
  // and subprocess phases deliberately leave it absent because the child's own
  // counts ride along verbatim under `report` rather than being recomputed into
  // a second, weaker answer. Listed here rather than NOT_APPLICABLE on purpose:
  // this keeps a live assertion that the counts field cannot silently vanish.
  'packages/cli/src/commands/phase-utils.ts',
  // Was INVISIBLE to this gate, not merely unclassified: it declares `status:
  // AuditStatus` / `status: ReviewStatus`, and the old status recogniser demanded a
  // string literal on the `status:` line. Conforms on the audit side — `AuditSummary`
  // now `extends SeverityCounts` and is built as `{...countBySeverity(allIssues),
  // files_scanned}` by `corpus/runner.ts`, so the distribution is the shared counter's
  // own output, published under the name `summary` and type-checked against it. `ReviewOutcome` deliberately carries no severity counts: its status is
  // a lane-EXECUTION outcome (`'ok'` iff every `vat skill review` subprocess ran), and
  // `ReviewSummary` publishes that distribution — reviewed/failed/skills_scanned. The
  // review findings themselves live in the sibling review.md rather than being
  // recomputed here into a second, weaker answer.
  'packages/cli/src/commands/corpus/report.ts',
]);

/**
 * Lanes that publish a status WITHOUT per-severity counts. Remove an entry in the
 * same change that fixes it — a fixed lane left on this list fails the build.
 *
 * Started at 19. Both survivors are deliberate rather than pending: one collapses
 * a boolean, and one is a two-valued BUILD GATE whose result is mutated in place
 * after construction, so a stored count would go stale rather than help.
 */
const SEVERITY_COUNTS_RATCHET = new Map<string, string>([
  ['packages/cli/src/commands/agent/validate.ts', 'collapses a boolean `valid` into a status; no counts published'],
  ['packages/agent-skills/src/validators/packaging-validator.ts', 'two-valued gate status with no counts field; `allErrors` carries info issues that no `activeInfo` bucket exposes, and the result is mutated in place by `applyConfigVerdicts`, so a stored count would go stale'],
]);

/**
 * Scanned files that emit a status but are NOT findings-reporting lanes, with why.
 * Explicit rather than silently filtered: the scan is deliberately over-inclusive,
 * and "why is this not in scope" is exactly the judgement a future reader needs.
 */
const SEVERITY_COUNTS_NOT_APPLICABLE = new Map<string, string>([
  ['packages/cli/src/commands/rag/index-command.ts', 'indexing failures are plain strings, not severity-classified findings; status is a generic success envelope'],
]);

/** What the ratchet believes about one scanned file, from its source alone. */
interface LaneClassification {
  /** The file emits a validation verdict, so the ratchet has an opinion about it. */
  isLane: boolean;
  /** The per-severity distribution travels beside that verdict. */
  publishesCounts: boolean;
}

/**
 * Classify one file's source. Pure, and exported so the blind spots of these
 * recognisers can be tested directly instead of only through a whole-repo run —
 * a repo-wide scan that happens to be green cannot tell you WHICH lanes it saw.
 */
export function classifySeverityCountsLane(contents: string): LaneClassification {
  const source = stripTsComments(contents);
  // Calling the shared collapse is sufficient on its own: it is what makes a
  // file a findings-reporting lane. Requiring a literal status value AND a
  // findings-shaped keyword hid `audit.ts` the moment its status became
  // `calculateValidationStatus(issues)` instead of `status: 'error'` — the
  // migration that fixed the lane is what erased it from the checklist.
  const usesSharedCollapse = SHARED_COLLAPSE_CALL.test(source);
  return {
    isLane:
      usesSharedCollapse ||
      DECLARED_STATUS_VOCABULARY.test(source) ||
      (VALIDATION_STATUS_VALUE.test(source) && FINDINGS_COLLECTION.test(source)),
    // Calling the shared counter IS publishing the distribution, even when the
    // lane's own field is named something else (`corpus/runner.ts` spreads it
    // into an `AuditSummary`).
    publishesCounts:
      usesSharedCollapse ||
      SHARED_COUNTS_TYPE.test(source) ||
      SEVERITY_COUNTS_PROPERTY.test(source) ||
      SEVERITY_COUNTS_SHAPE_PARTS.every((part) => part.test(source)),
  };
}

/**
 * Report every findings-reporting lane that is misclassified, newly conforming,
 * or newly appeared.
 */
async function validateSeverityCountsRatchet(): Promise<void> {
  const seen = new Set<string>();

  await forEachTrackedTextFile((relPath, contents) => {
    if (!relPath.endsWith('.ts')) return;
    if (!SEVERITY_COUNTS_SCAN_ROOTS.some((root) => toForwardSlash(relPath).startsWith(root))) return;

    const { isLane, publishesCounts: conforms } = classifySeverityCountsLane(contents.toString('utf8'));
    if (!isLane) return;

    seen.add(relPath);

    if (SEVERITY_COUNTS_NOT_APPLICABLE.has(relPath)) {
      return;
    }

    if (SEVERITY_COUNTS_RATCHET.has(relPath)) {
      if (conforms) {
        errors.push({
          type: ERROR_TYPES.SEVERITY_COUNTS,
          path: relPath,
          message:
            'This lane now publishes per-severity counts, but is still listed in ' +
            'SEVERITY_COUNTS_RATCHET. Remove its entry — the list may only shrink.',
          severity: 'error',
        });
      }
      return;
    }

    if (SEVERITY_COUNTS_CONFORMING.has(relPath)) {
      if (!conforms) {
        errors.push({
          type: ERROR_TYPES.SEVERITY_COUNTS,
          path: relPath,
          message:
            'This lane is listed as publishing per-severity counts, but no ' +
            '`issueCounts`/`severityCounts`/`counts` property was found — a regression.',
          severity: 'error',
        });
      }
      return;
    }

    errors.push({
      type: ERROR_TYPES.SEVERITY_COUNTS,
      path: relPath,
      message:
        'Unclassified findings-reporting lane: it publishes a validation status ' +
        'alongside a findings collection, declares a status vocabulary ' +
        "(`type …Status = 'ok' | …`), or calls the shared issues→status " +
        'collapse. A status alone cannot express a ' +
        'three-valued severity distribution, and every existing collapse resolves ' +
        'the ambiguous case to the reassuring one. Publish a per-severity counts ' +
        'block beside the status and add this file to SEVERITY_COUNTS_CONFORMING, ' +
        'or record why it cannot in SEVERITY_COUNTS_RATCHET / ' +
        'SEVERITY_COUNTS_NOT_APPLICABLE.',
      severity: 'error',
    });
  });

  // A bucket entry naming a file the scan no longer reaches is a stale row: it
  // silently stops asserting anything, which is how a ratchet quietly dies.
  const classified = [
    ...SEVERITY_COUNTS_RATCHET.keys(),
    ...SEVERITY_COUNTS_CONFORMING,
    ...SEVERITY_COUNTS_NOT_APPLICABLE.keys(),
  ];
  for (const relPath of classified) {
    if (!seen.has(relPath)) {
      errors.push({
        type: ERROR_TYPES.SEVERITY_COUNTS,
        path: relPath,
        message:
          'Stale severity-counts entry: this file is no longer a findings-reporting ' +
          'lane (moved, renamed, or no longer emits a validation status). Remove its entry.',
        severity: 'error',
      });
    }
  }
}

/** Extensions this scan does not open — archives, images, fonts, and lockfiles. */
const BINARY_EXTENSION = /\.(?:zip|tgz|gz|tar|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|lock)$/i;

/**
 * Vendor-claim annotation: `@vendor-claim reviewed=YYYY-MM-DD verify=<how>`
 *
 * Marks a statement about the *outside world* — another vendor's install paths, a
 * runtime's capabilities, semantics read out of someone else's binary, a
 * platform's command flags. Such claims cannot be tested: the repo's own tests
 * can only read the table back to itself, so they pass forever while the world
 * moves. What they need instead is a human re-reading the source on a clock, and
 * this annotation is what puts them on one.
 *
 * Grammar — one line, wherever a comment or prose line is legal:
 *
 *     <marker> @vendor-claim reviewed=YYYY-MM-DD verify=<how to re-verify>
 *
 * `<marker>` is an optional leading `//`, `*`, `#`, `-`, `>` or `<!--`, so the same
 * form works in TypeScript comments and in markdown prose, list items,
 * blockquotes, and HTML comments. The tag must be the first thing on the line
 * after that marker — a mid-sentence mention of the tag in prose is a discussion
 * of the annotation, not an instance of it.
 *
 * `verify=` runs to end of line and is mandatory. A date alone tells you the claim
 * is stale without telling you what to go read, which is not actionable; the
 * "how" is half the annotation. Give a URL, a document name, or "run X".
 */
const VENDOR_CLAIM_MAX_AGE_DAYS = 90; // Matches docs/external/'s documented refresh policy
const VENDOR_CLAIM_TAG = '@vendor-claim';
const VENDOR_CLAIM_MARKERS = ['//', '*', '#', '<!--', '-', '>'] as const;
const VENDOR_CLAIM_BODY = /^reviewed=(\d{4}-\d{2}-\d{2})\s+verify=(\S.*)$/;

/** Strip one leading comment/list marker so the same grammar works in TS and markdown. */
function stripLineMarker(line: string): string {
  const trimmed = line.trimStart();
  for (const marker of VENDOR_CLAIM_MARKERS) {
    if (trimmed.startsWith(marker)) {
      return trimmed.slice(marker.length).trimStart();
    }
  }
  return trimmed;
}

interface VendorClaim {
  reviewed: string;
  verify: string;
}

/**
 * Parse one line as a vendor-claim annotation.
 * `undefined` = not an annotation; `null` = an annotation that does not parse.
 */
function parseVendorClaim(line: string): VendorClaim | null | undefined {
  const bare = stripLineMarker(line);
  if (!bare.startsWith(VENDOR_CLAIM_TAG)) {
    return undefined;
  }

  const rest = bare.slice(VENDOR_CLAIM_TAG.length);
  if (rest !== '' && !rest.startsWith(' ') && !rest.startsWith('\t')) {
    return undefined; // A longer tag that merely shares this prefix
  }

  const body = VENDOR_CLAIM_BODY.exec(rest.trimStart());
  if (!body) {
    return null;
  }

  // Trailing `-->` belongs to the HTML comment, not to the instruction.
  let verify = (body[2] ?? '').trim();
  if (verify.endsWith('-->')) {
    verify = verify.slice(0, -3).trim();
  }

  return { reviewed: body[1] ?? '', verify };
}

/** Whole days elapsed since an ISO date, or NaN if the date is not real. */
function daysSinceIsoDate(isoDate: string, now: Date): number {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(then)) {
    return Number.NaN;
  }
  return Math.floor((now.getTime() - then) / 86_400_000);
}

/**
 * Rule 11: Vendor claims must be re-verified every 90 days
 *
 * Severity is `warning` on purpose. A review that came due must not fail an
 * unrelated commit — that is how a gate earns a permanent `--no-verify` and stops
 * being read at all. The job here is to be *visible on a clock*, not to block.
 */
async function validateVendorClaimFreshness(): Promise<void> {
  const now = new Date();

  await forEachTrackedTextFileLine(({ relPath, lines, index }) => {
    const claim = parseVendorClaim(lines[index] ?? '');
    if (claim === undefined) {
      return;
    }

    const path = `${relPath}:${index + 1}`;
    const age = claim ? daysSinceIsoDate(claim.reviewed, now) : Number.NaN;

    if (!claim || !Number.isFinite(age)) {
      errors.push({
        type: ERROR_TYPES.STALE_VENDOR_CLAIM,
        path,
        message:
          `Malformed @vendor-claim annotation. Expected ` +
          `\`@vendor-claim reviewed=YYYY-MM-DD verify=<how to re-verify>\` with a real ` +
          `calendar date. As written this annotation can never come due, so the claim ` +
          `it guards is unwatched.`,
        severity: 'warning',
      });
      return;
    }

    if (age > VENDOR_CLAIM_MAX_AGE_DAYS) {
      errors.push({
        type: ERROR_TYPES.STALE_VENDOR_CLAIM,
        path,
        message:
          `Claim about the outside world last verified ${age} days ago — ` +
          `${age - VENDOR_CLAIM_MAX_AGE_DAYS} days past the ${VENDOR_CLAIM_MAX_AGE_DAYS}-day ` +
          `review window. To re-verify: ${claim.verify}\n     ` +
          `Then update reviewed= to today's date. No test can contradict this claim, ` +
          `so this warning is the only thing watching it.`,
        severity: 'warning',
      });
    }
  });
}

/**
 * Print validation results
 */
function printResults(): void {
  if (errors.length === 0) {
    console.log('✅ Repository structure validation passed!');
    return;
  }

  const errorCount = errors.filter((e) => e.severity === 'error').length;
  const warningCount = errors.filter((e) => e.severity === 'warning').length;

  // Three outcomes, three headlines. This used to print "failed" whenever any
  // entry existed, while `validate()` exits 0 unless one is error-severity — so a
  // warnings-only run announced failure and then succeeded. Anything reading the
  // headline and anything reading the exit code reached opposite conclusions.
  if (errorCount === 0) {
    console.log(`\n⚠️  Repository structure validation passed with warnings:`);
  } else {
    console.log(`\n❌ Repository structure validation failed:`);
  }
  console.log(`   ${errorCount} errors, ${warningCount} warnings\n`);

  // Group by type
  const byType = errors.reduce(
    (acc, error) => {
      const list = (acc[error.type] ??= []);
      list.push(error);
      return acc;
    },
    {} as Record<string, ValidationError[]>,
  );

  for (const [type, typeErrors] of Object.entries(byType)) {
    console.log(`\n${type.toUpperCase().replaceAll('-', ' ')}:`);
    for (const error of typeErrors) {
      const icon = error.severity === 'error' ? '❌' : '⚠️';
      console.log(`  ${icon} ${error.path}`);
      console.log(`     ${error.message}\n`);
    }
  }
}

/**
 * Main validation function
 */
async function validate(): Promise<void> {
  console.log('🔍 Validating repository structure...\n');

  // NOTE: Secret file protection is handled by .gitignore + vibe-validate pre-commit hooks
  // which scan for secrets anywhere in code content

  // Critical - Confidentiality (unfixable once merged; see contraband-scan.ts)
  await validateNoContrabandTokens();

  // High Priority - File Location Sprawl
  await validateNoNestedPackageJson();
  await validateSourceFileLocations();
  await validateTestFileNaming();

  // Original Rules
  await validateNoRuntimeExamples();
  await validateScriptsLocation();
  await validateNoShellScripts();
  await validateNoStagingDirectories();
  await validateTestFixtureSizes();
  await validateNoNulBytesInTextFiles();

  // Durability - claims that rot in silence
  await validateNoCitationsToNeverCommittedDirs();
  await validateVendorClaimFreshness();
  await validateSeverityCountsRatchet();

  printResults();

  // Exit with error code if there are errors (not warnings)
  const hasErrors = errors.some((e) => e.severity === 'error');
  if (hasErrors) {
    process.exit(1);
  }
}

// Run validation
if (import.meta.main) {
  try {
    await validate();
  } catch (error) {
    console.error('Validation script failed:', error);
    process.exit(2);
  }
}

export { validate, type ValidationError };
 
