#!/usr/bin/env bun
/**
 * Repository Structure Validator
 *
 * Validates that the monorepo structure follows conventions to prevent
 * structural sprawl from agentic development (AI code generation).
 *
 * CRITICAL - Security:
 * - No credential/secret files (.env, credentials.json, certificate files, etc.)
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
 * - No /scripts directories (except dev-tools, agent-schema, agent-skills)
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

import { safeExecSync, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

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
  const tracked = safeExecSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
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
 * Allowed: dev-tools (repo utilities), agent-schema, agent-skills (schema generation)
 */
async function validateScriptsLocation(): Promise<void> {
  const packagesDir = safePath.join(REPO_ROOT, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });

  const allowedScriptsPackages = new Set([
    'dev-tools',
    'agent-schema',
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
        message: `Only dev-tools, agent-schema, and agent-skills should have /scripts directories. Move utilities to dev-tools package.`,
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

      // Allow agent-schema/scripts (build tooling for JSON Schema generation)
      if (normalizedPath.startsWith('packages/agent-schema/scripts/')) {
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
 * HONEST LIMITATIONS: conformance is judged from SOURCE — whether the file
 * declares or assigns an object property named `issueCounts`/`severityCounts`/
 * `counts`. Specifically:
 *   - It cannot tell whether that block is actually reached at runtime.
 *   - It cannot see counts published under a name outside that set.
 *   - The property must start a line. That is deliberate — matching the bare word
 *     anywhere is what made an earlier keyword scan call `packaging-validator.ts`
 *     conforming, because the word "counts" appeared in one of its comments — but
 *     it does mean a counts block written inline on one line reads as
 *     nonconforming. The failure direction is a lane that stays on the list after
 *     being fixed, which someone notices; not a lane that leaves it unfixed.
 * It is a checklist that cannot rot, not a proof of correct output. That coarseness
 * is why the bucket notes below are hand-verified rather than inferred.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Roots whose `.ts` files are scanned for findings-reporting lanes. */
const SEVERITY_COUNTS_SCAN_ROOTS = [
  'packages/cli/src/commands/',
  'packages/agent-skills/src/validators/',
  'packages/claude-marketplace/src/',
] as const;

/** A status drawn from the validation vocabulary, as an emitted or declared value. */
const VALIDATION_STATUS_VALUE = /status\??:[^'\n]*'(?:success|error|warning|failed)'/;
/** A collection of findings, which is what makes a status a *validation* verdict. */
const FINDINGS_COLLECTION = /\b(?:issues|allErrors|activeErrors|activeWarnings|errors|warnings|findings)\b\s*[:.]/;
/** A per-severity counts block, as an object property — not a local, not a comment. */
const SEVERITY_COUNTS_PROPERTY = /^[ \t]*(?:issueCounts|severityCounts|counts)\??[ \t]*:/m;

/** Lanes that publish a per-severity counts block beside their status. */
const SEVERITY_COUNTS_CONFORMING = new Set<string>([
  'packages/cli/src/commands/resources/validate.ts',
]);

/**
 * Lanes that publish a status WITHOUT per-severity counts. This is Wave 2/3's
 * checklist. Remove an entry in the same change that fixes it — a fixed lane
 * left on this list fails the build.
 */
/** The plain case: a status is published and the severity distribution simply is not. */
const NO_COUNTS_BLOCK = 'status published without a per-severity counts block';

const SEVERITY_COUNTS_RATCHET = new Map<string, string>([
  ['packages/cli/src/commands/verify.ts', 'consistency phase reports `passed` even with warnings; findings go to stderr only and never into the archived YAML'],
  ['packages/cli/src/commands/build.ts', NO_COUNTS_BLOCK],
  ['packages/cli/src/commands/audit-settings.ts', 'drops the `overrode` provenance chain, the one question the override chain exists to answer'],
  ['packages/cli/src/commands/audit/hierarchical-output.ts', '`summary.warnings` counts FILES while `issues.warnings` counts FINDINGS — same word, two units, adjacent keys'],
  ['packages/cli/src/commands/corpus/runner.ts', '`statusFromCounts` ignores its own third count, so `audit_clean` absorbs info-only plugins'],
  ['packages/cli/src/commands/claude/marketplace/validate.ts', 'computes error+warning counts but no info term; summary string reads "0 error(s), 0 warning(s)" above N findings'],
  ['packages/cli/src/commands/claude/plugin/build.ts', 'renders info-severity findings with a `[WARNING]` prefix; no counts published'],
  ['packages/cli/src/commands/skills/validate.ts', 'prints "All validations passed" over active warnings; no counts published'],
  ['packages/cli/src/commands/skills/build.ts', 'labels the whole issue set "post-build error(s)" regardless of severity'],
  ['packages/cli/src/commands/skills/package.ts', 'validation display lane; status published without a per-severity counts block'],
  ['packages/cli/src/commands/agent/validate.ts', 'collapses a boolean `valid` into a status; no counts published'],
  ['packages/agent-skills/src/validators/types.ts', 'the shared `ValidationResult` shape itself declares no counts field'],
  ['packages/agent-skills/src/validators/skill-validator.ts', 'computes all three counts, then publishes them only inside a prose `summary` string — a consumer must parse English'],
  ['packages/agent-skills/src/validators/packaging-validator.ts', 'has no info notion at all and maps warning ⇒ success'],
  ['packages/agent-skills/src/validators/unified-validator.ts', NO_COUNTS_BLOCK],
  ['packages/agent-skills/src/validators/marketplace-validator.ts', NO_COUNTS_BLOCK],
  ['packages/agent-skills/src/validators/registry-validator.ts', NO_COUNTS_BLOCK],
  ['packages/claude-marketplace/src/validators/plugin-validator.ts', NO_COUNTS_BLOCK],
  ['packages/claude-marketplace/src/settings/settings-auditor.ts', NO_COUNTS_BLOCK],
]);

/**
 * Scanned files that emit a status but are NOT findings-reporting lanes, with why.
 * Explicit rather than silently filtered: the scan is deliberately over-inclusive,
 * and "why is this not in scope" is exactly the judgement a future reader needs.
 */
const SEVERITY_COUNTS_NOT_APPLICABLE = new Map<string, string>([
  ['packages/cli/src/commands/rag/index-command.ts', 'indexing failures are plain strings, not severity-classified findings; status is a generic success envelope'],
]);

/**
 * Report every findings-reporting lane that is misclassified, newly conforming,
 * or newly appeared.
 */
async function validateSeverityCountsRatchet(): Promise<void> {
  const seen = new Set<string>();

  await forEachTrackedTextFile((relPath, contents) => {
    if (!relPath.endsWith('.ts')) return;
    if (!SEVERITY_COUNTS_SCAN_ROOTS.some((root) => toForwardSlash(relPath).startsWith(root))) return;

    const source = contents.toString('utf8');
    if (!VALIDATION_STATUS_VALUE.test(source) || !FINDINGS_COLLECTION.test(source)) return;

    seen.add(relPath);
    const conforms = SEVERITY_COUNTS_PROPERTY.test(source);

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
        'alongside a findings collection. A status alone cannot express a ' +
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
 
