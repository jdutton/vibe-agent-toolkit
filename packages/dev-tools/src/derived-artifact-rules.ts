/**
 * Structure-gate rules for artifacts that are DERIVED from another file.
 *
 * Every rule here answers the same question — "is this committed copy what
 * its source says?" — and fails when the answer is no, so a stale copy is a
 * red gate rather than the thing a reader trusts. The sources and their copies:
 *
 *   | Source                                   | Derived copy                              |
 *   |------------------------------------------|-------------------------------------------|
 *   | `packages/*\/package.json` workspace deps | every `tsconfig.json` `references` list   |
 *   | the tree (skills, docs, scripts, sites)  | the `<!-- gen:… -->` blocks in `CLAUDE.md`|
 *   | `vibe-validate.config.yaml` `ci:`        | `.github/workflows/validate.yml`          |
 *   | `package.json` workspaces                | `bun.lock` `@vibe-agent-toolkit/*` entries|
 *   | a package's test directories             | its `test:*` scripts                      |
 *   | `.gitignore`                             | the tracked file list (nothing ignored)   |
 *   | scripts that run the CLI binary          | `turbo.json` `<pkg>#build` edges          |
 *
 * Plus two well-formedness rules with no source: `CLAUDE.md` stays under its
 * byte budget, and every `.changes/*.md` fragment parses — and one ratchet,
 * `checkCommentDensity` (`comment-density.ts`), whose "source" is the stored
 * ceilings table that may only move down.
 *
 * Each rule is a pure function of a repo root so a test can point it at a
 * fixture tree; `collectDerivedArtifactFindings` runs them all for the gate.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';

import { validateFragments } from './changelog-fragments.js';
import { checkCommentDensity } from './comment-density.js';
import { GENERATED_DOCUMENTS, regenerateDocument } from './generate-claude-md.js';
import { findStaleTsconfigs } from './generate-tsconfig-refs.js';
import { checkValidateWorkflow, WORKFLOW_PATH } from './generate-workflow.js';
import { ERROR_TYPES, type ValidationError } from './structure-finding.js';
import { isTypeScriptProject, readWorkspaceGraph, type WorkspacePackage } from './workspace-graph.js';

const CLAUDE_MD = 'CLAUDE.md';
/**
 * The byte budget for the root `CLAUDE.md`. It is loaded into every agent
 * session, and its history is a sawtooth — two hand compactions, each followed
 * by regrowth at ~90 lines a month — because a number nobody enforces is a
 * number nobody holds. 20 KiB is the post-compaction size with headroom.
 */
export const CLAUDE_MD_BYTE_BUDGET = 20_480;

const stale = (path: string, message: string): ValidationError => ({
  type: ERROR_TYPES.DERIVED_ARTIFACT_STALE,
  path,
  message,
  severity: 'error',
});

/** Rule: every `tsconfig.json` `references` list is what `package.json` implies. */
export function checkTsconfigReferences(repoRoot: string): ValidationError[] {
  return findStaleTsconfigs(repoRoot).map((file) =>
    stale(
      file.relPath,
      'The `references` list does not match this package\'s workspace dependencies in package.json. ' +
        'References are generated, never hand-edited: run `bun run --cwd packages/dev-tools generate:tsconfig-refs`.',
    ),
  );
}

/**
 * Rule: every `<!-- gen:… -->` block in every generated document holds what
 * the tree says, and every block a document must carry is present.
 */
export function checkGeneratedBlocks(repoRoot: string): ValidationError[] {
  const findings: ValidationError[] = [];
  for (const document of GENERATED_DOCUMENTS) {
    let report: ReturnType<typeof regenerateDocument>;
    try {
      report = regenerateDocument(repoRoot, document);
    } catch (error) {
      findings.push(stale(document.path, error instanceof Error ? error.message : String(error)));
      continue;
    }
    for (const name of report.result.changed) {
      findings.push(
        stale(
          document.path,
          `Generated block "${name}" is stale — the tree no longer matches what is written between its markers. ` +
            'Run `bun run --cwd packages/dev-tools generate:claude-md`; never edit between the markers by hand.',
        ),
      );
    }
    for (const name of report.missing) {
      findings.push(stale(document.path, `No \`<!-- gen:${name} -->\` block: the "${name}" list has nowhere to be regenerated into.`));
    }
  }
  findings.push(...checkNoStrayGeneratedMarkers(repoRoot));
  return findings;
}

const GEN_MARKER = /<!-- \/?gen:[\w-]+ -->/u;

/**
 * Rule: a `<!-- gen:… -->` marker appears only in a registered document.
 * A block pasted into any other tracked Markdown file is never regenerated
 * and never checked — the second copy the registry exists to end.
 */
export function checkNoStrayGeneratedMarkers(
  repoRoot: string,
  trackedMarkdown: readonly string[] = trackedMarkdownFiles(repoRoot),
  readText: (relPath: string) => string = (relPath) => readFileSync(safePath.join(repoRoot, relPath), 'utf8'),
): ValidationError[] {
  const registered = new Set(GENERATED_DOCUMENTS.map((document) => document.path));
  return trackedMarkdown
    .filter((relPath) => !registered.has(relPath) && GEN_MARKER.test(readText(relPath)))
    .map((relPath) =>
      stale(
        relPath,
        'Carries a `<!-- gen:… -->` marker but is not in GENERATED_DOCUMENTS (packages/dev-tools/src/generate-claude-md.ts), ' +
          'so the block is never regenerated or checked. Register the document, or link to the one that owns the list.',
      ),
    );
}

/** Every tracked `.md` file, repo-relative with forward slashes. */
function trackedMarkdownFiles(repoRoot: string): string[] {
  const listing = String(runGitOrThrow(['ls-files', '-z', '--', '*.md', '**/*.md'], { cwd: repoRoot, trim: false }));
  return listing.split('\0').filter((rel) => rel.length > 0);
}

/** Rule: the root `CLAUDE.md` stays under its byte budget. */
export function checkClaudeMdByteBudget(repoRoot: string, budget: number = CLAUDE_MD_BYTE_BUDGET): ValidationError[] {
  const bytes = Buffer.byteLength(readFileSync(safePath.join(repoRoot, CLAUDE_MD)));
  if (bytes <= budget) return [];
  return [
    stale(
      CLAUDE_MD,
      `${bytes} bytes, over the ${budget}-byte budget by ${bytes - budget}. This file loads into every agent session; ` +
        'move reference material to the doc that owns it (docs/contributing/content-routing.md says which) and leave a one-line pointer.',
    ),
  ];
}

/** Rule: `.github/workflows/validate.yml` is what its generator produces. */
export function checkValidateWorkflowGenerated(repoRoot: string): ValidationError[] {
  if (checkValidateWorkflow(repoRoot).inSync) return [];
  return [
    stale(
      WORKFLOW_PATH,
      'Differs from what `generate-workflow.ts` renders from vibe-validate.config.yaml. ' +
        'The file is generated: run `bun run --cwd packages/dev-tools generate:workflow`, or change the generator.',
    ),
  ];
}

/**
 * Rule: `bun.lock` resolves every `@vibe-agent-toolkit/*` name (and the
 * umbrella) to the workspace, never to a published copy. A second copy is
 * ~330 MB of `node_modules`, a second native LanceDB binary, and a `vat`
 * binary that is not this tree's — it is how a crucible run once measured the
 * published build while believing it measured the branch.
 */
export function checkLockfileWorkspaceResolutions(repoRoot: string): ValidationError[] {
  const lock = readFileSync(safePath.join(repoRoot, 'bun.lock'), 'utf8');
  const graph = readWorkspaceGraph(repoRoot);
  const names = new Set(graph.packages.map((pkg) => pkg.name));
  const findings: ValidationError[] = [];
  for (const match of lock.matchAll(/"(@vibe-agent-toolkit\/[\w.-]+|vibe-agent-toolkit)@([^"]+)"/g)) {
    const [, name, resolution] = match;
    if (name === undefined || resolution === undefined || !names.has(name)) continue;
    if (resolution.startsWith('workspace:')) continue;
    findings.push(
      stale(
        'bun.lock',
        `${name} resolves to "${resolution}" as well as to the workspace. A published copy of a workspace package ` +
          'has crept into the tree (a dependency depends on it by version); point it at the workspace with a root `overrides` entry.',
      ),
    );
  }
  return findings;
}

/** The scripts every TypeScript project carries, and what they must say. */
export const STANDARD_SCRIPTS = {
  typecheck: 'tsc --noEmit',
  clean: 'rimraf --glob dist "*.tsbuildinfo" .tsc-staging',
  'test:unit': 'vitest run',
  'test:watch': 'vitest',
  'test:integration': 'vitest run --config vitest.integration.config.ts',
  'test:system': 'vitest run --config vitest.system.config.ts',
} as const;

/** The one compile invocation a `build` script may use. */
export const STANDARD_COMPILE = 'tsx ../dev-tools/src/tsc-clean-build.ts';
/** The same script, from inside dev-tools itself. */
const DEV_TOOLS_COMPILE = 'tsx src/tsc-clean-build.ts';
/** Scripts the root owns; a per-package copy is dead code the root never calls. */
const ROOT_OWNED_SCRIPTS = ['lint', 'duplication-check', 'validate-structure', 'pre-publish', 'test:coverage'] as const;

/** Does the package hold unit tests (a `*.test.ts` outside `integration/` and `system/`)? */
function hasUnitTests(repoRoot: string, pkg: WorkspacePackage): boolean {
  const testDir = safePath.join(repoRoot, 'packages', pkg.dir, 'test');
  if (!existsSync(testDir)) return false;
  return readdirSync(testDir, { recursive: true, encoding: 'utf8' }).some((file) => {
    const rel = toForwardSlash(file);
    return (
      rel.endsWith('.test.ts') &&
      !rel.endsWith('.integration.test.ts') &&
      !rel.endsWith('.system.test.ts') &&
      !rel.startsWith('integration/') &&
      !rel.startsWith('system/')
    );
  });
}

/**
 * Rule: every TypeScript project has the standard script set, spelled the one
 * way, and nothing the root already owns.
 *
 * `build` may add steps around the compile (`validate-help-files && …`, `… &&
 * bun run generate:schemas`) but must invoke the one compile script — `utils`
 * used to be the single package on `rimraf dist && tsc`, the delete-then-emit
 * that script exists to prevent, on the one package everything else reads.
 * `test:*` scripts are required exactly where the matching test tier exists
 * and forbidden where it does not, so a script cannot be an orphan.
 */
export function checkPackageScripts(repoRoot: string): ValidationError[] {
  const graph = readWorkspaceGraph(repoRoot);
  return graph.packages
    .filter((pkg) => isTypeScriptProject(pkg, repoRoot))
    .flatMap((pkg) => {
      const path = `packages/${pkg.dir}/package.json`;
      const scripts = (pkg.manifest['scripts'] ?? {}) as Record<string, string>;
      return [...buildScriptProblems(pkg, scripts), ...tierScriptProblems(repoRoot, pkg, scripts), ...rootOwnedScriptProblems(scripts)].map(
        (message): ValidationError => ({ type: ERROR_TYPES.STRUCTURAL_VIOLATION, path, message, severity: 'error' }),
      );
    });
}

/** The `build` chain compiles through the one script, and never through bare `tsc`. */
function buildScriptProblems(pkg: WorkspacePackage, scripts: Record<string, string>): string[] {
  const compile = pkg.dir === 'dev-tools' ? DEV_TOOLS_COMPILE : STANDARD_COMPILE;
  const buildChain = Object.entries(scripts)
    .filter(([name]) => name === 'build' || name.startsWith('build:'))
    .map(([, script]) => script)
    .join(' && ');
  const problems: string[] = [];
  if (!buildChain.includes(compile)) {
    problems.push(`\`build\` (or a \`build:*\` step it runs) must compile through \`${compile}\`; found: ${JSON.stringify(scripts['build'])}`);
  }
  if (buildChain.split('&&').some((step) => /^\s*tsc(\s|$)/.test(step))) {
    problems.push('`build` invokes `tsc` directly; the compile goes through the atomic-promotion script so `dist/` stays readable while it is written.');
  }
  return problems;
}

/** Every standard script is spelled the one way, and `test:*` exists exactly where its tier does. */
function tierScriptProblems(repoRoot: string, pkg: WorkspacePackage, scripts: Record<string, string>): string[] {
  const unit = hasUnitTests(repoRoot, pkg);
  const tiers: Record<string, boolean> = {
    'test:unit': unit,
    'test:watch': unit,
    'test:integration': existsSync(safePath.join(repoRoot, 'packages', pkg.dir, 'test', 'integration')),
    'test:system': existsSync(safePath.join(repoRoot, 'packages', pkg.dir, 'test', 'system')),
  };
  const problems: string[] = [];
  for (const [name, expected] of Object.entries(STANDARD_SCRIPTS)) {
    const required = tiers[name] ?? true;
    const actual = scripts[name];
    if (required && actual !== expected) {
      problems.push(`\`${name}\` must be exactly ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`);
    } else if (!required && actual !== undefined) {
      problems.push(`\`${name}\` is declared but the package has no matching test tier on disk — an orphan script runs nothing and reads as coverage.`);
    }
  }
  return problems;
}

/** Scripts the root already owns; a per-package copy is dead code. */
function rootOwnedScriptProblems(scripts: Record<string, string>): string[] {
  return ROOT_OWNED_SCRIPTS.filter((name) => name in scripts).map(
    (name) => `\`${name}\` is owned by the root package.json and never called per package; delete it.`,
  );
}

/**
 * Rule: nothing tracked is gitignored.
 *
 * A tracked file that matches `.gitignore` was force-added, and from then on
 * it is the worst of both states: edits to it show up (so it looks
 * maintained) while a NEW sibling is silently ignored and old ones go stale
 * unnoticed. Twenty generated files sat that way for six months.
 */
export function checkNoTrackedIgnoredFiles(repoRoot: string): ValidationError[] {
  const listing = String(runGitOrThrow(['ls-files', '-z', '-ci', '--exclude-standard'], { cwd: repoRoot, trim: false }));
  return listing
    .split('\0')
    .filter((rel) => rel.length > 0)
    .map((rel) =>
      stale(
        rel,
        'Tracked, but matches .gitignore — it was force-added. Either stop ignoring the path or `git rm --cached` it; ' +
          'a file in both states is regenerated by the build and never committed again.',
      ),
    );
}

/**
 * Whether the turbo task at `key` lists `edge` in its `dependsOn`.
 *
 * turbo.json is JSONC (comments), so this is a text scan: the task's object
 * runs from its key to the next closing brace, and the edge must be inside it.
 */
function turboBlockDependsOn(turbo: string, key: string, edge: string): boolean {
  const start = turbo.indexOf(key);
  const end = start === -1 ? -1 : turbo.indexOf('}', start);
  return start !== -1 && end !== -1 && turbo.slice(start, end).includes(edge);
}

/**
 * Rule: a package whose scripts run the CLI binary has a `turbo.json` edge on
 * `@vibe-agent-toolkit/cli#build`. The edge list in turbo.json is hand-written
 * ("To register a new adopter package, add a `<pkg>#build` entry below"); this
 * derives the population from the scripts so a forgotten entry is a red gate
 * rather than a racing `ERR_MODULE_NOT_FOUND` on a cold cache.
 */
export function checkTurboAdopterEdges(repoRoot: string): ValidationError[] {
  const turbo = readFileSync(safePath.join(repoRoot, 'turbo.json'), 'utf8');
  const findings: ValidationError[] = [];
  for (const pkg of readWorkspaceGraph(repoRoot).packages) {
    const scripts = (pkg.manifest['scripts'] ?? {}) as Record<string, string>;
    const runsCli = Object.entries(scripts).filter(([, script]) => script.includes('cli/dist/bin/vat.js'));
    if (runsCli.length === 0) continue;
    // Which turbo task runs the binary: `build` itself, or a `build:*` task turbo
    // runs separately (`build:skills`). A `build:code`-style step runs INSIDE
    // `build`, so it counts as `build`.
    const tasks = new Set(
      runsCli.map(([name]) => (name === 'build:skills' ? 'build:skills' : 'build')),
    );
    for (const task of tasks) {
      const key = `"${pkg.name}#${task}"`;
      // A `build:*` task is also covered transitively: the package's own
      // `#build` carries the edge and the generic task depends on `build`.
      const viaBuild =
        task !== 'build' &&
        turboBlockDependsOn(turbo, `"${pkg.name}#build"`, '"@vibe-agent-toolkit/cli#build"') &&
        turboBlockDependsOn(turbo, `"${task}"`, '"build"');
      if (!viaBuild && !turboBlockDependsOn(turbo, key, '"@vibe-agent-toolkit/cli#build"')) {
        findings.push(
          stale(
            'turbo.json',
            `${pkg.name} runs the CLI binary in its \`${task}\` script but turbo.json has no ${key} task depending on ` +
              '"@vibe-agent-toolkit/cli#build". Without the edge turbo may run it while the CLI or a package it imports is mid-rebuild.',
          ),
        );
      }
    }
  }
  return findings;
}

/** Rule: every `.changes/*.md` fragment is well-formed. */
export function checkChangelogFragments(repoRoot: string): ValidationError[] {
  return validateFragments(repoRoot).map((problem) => ({
    type: ERROR_TYPES.STRUCTURAL_VIOLATION,
    path: problem.relPath,
    message: `${problem.reason}. See .changes/README.md for the fragment shape.`,
    severity: 'error' as const,
  }));
}

/** Every rule above, for the gate. */
export function collectDerivedArtifactFindings(repoRoot: string): ValidationError[] {
  const rules: Array<(root: string) => ValidationError[]> = [
    checkTsconfigReferences,
    checkGeneratedBlocks,
    checkClaudeMdByteBudget,
    checkValidateWorkflowGenerated,
    checkLockfileWorkspaceResolutions,
    checkPackageScripts,
    checkNoTrackedIgnoredFiles,
    checkTurboAdopterEdges,
    checkChangelogFragments,
    checkCommentDensity,
  ];
  const findings: ValidationError[] = [];
  for (const rule of rules) {
    try {
      findings.push(...rule(repoRoot));
    } catch (error) {
      // A rule that cannot run is a finding, not a pass: the artifact it
      // guards was not checked.
      findings.push(stale(rule.name, `Rule did not run: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  return findings;
}
