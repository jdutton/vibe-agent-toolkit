/* eslint-disable sonarjs/no-duplicate-string */
/**
 * System tests for `vat skill test run`.
 *
 * Verifies the end-to-end wiring of the command: help text is accurate,
 * the safety gate fires before any spawn attempt, and (when claude+auth
 * are available) dry-run assembles the command without spawning.
 *
 * CI-safe design:
 *   - ALWAYS-RUNS cases need no claude binary and spend no tokens.
 *   - GUARDED cases are skipped via describe.skipIf when claude or auth
 *     are absent so the test suite passes cleanly in credential-less CI.
 *
 * Harness layout note:
 *   The `vat skill test run` harness derives a root under <os-tmp>/vat-skill-test/<key>/
 *   (or uses --out). Staging runs BEFORE the bootstrap check, copying the subject
 *   skill into <harnessRoot>/<subjectName>/. The harness then looks for the
 *   subject's own evals/evals.json inside that staged dir. We therefore put
 *   evals/evals.json INSIDE the fixture skill dir and let staging carry it —
 *   exercising the real eval-resolution path (no manual seeding into the root).
 *
 *   When a fixture skill has NO evals/, the harness scaffolds an evals.json
 *   template next to the subject source (the fixture skill dir) and exits 3.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

import { stagedDirName } from '@vibe-agent-toolkit/agent-skills';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createSuiteContext,
  executeCli,
  writeTestFile,
} from './test-common.js';

// ---------------------------------------------------------------------------
// claude + auth detection (module-level, synchronous)
// ---------------------------------------------------------------------------

const hasClaude = (() => {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- probing for claude CLI presence; not user-supplied
    return spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

const authed = (() => {
  if (!hasClaude) return false;
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- probing claude auth status; not user-supplied
    const r = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8' });
    return r.status === 0 && (JSON.parse(r.stdout) as Record<string, unknown>).loggedIn === true;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const TEMP_DIR_PREFIX = 'vat-skill-test-';

/** Minimal evals.json content matching the schema in schemas.md. */
const TRIVIAL_EVALS_JSON = JSON.stringify(
  {
    skill_name: 'poc-skill',
    evals: [
      {
        id: 1,
        prompt: 'Say the word "hello" and nothing else.',
        expected_output: 'The model says hello.',
        expectations: ['The response contains the word hello.'],
      },
    ],
  },
  null,
  2,
);

/**
 * Build a minimal packaged skill source directory in-test.
 * Contains SKILL.md (valid frontmatter) and, by default, evals/evals.json so
 * staging carries it into the harness and the real eval-resolution path runs.
 *
 * @param dir - Parent directory to create the skill inside.
 * @param skillName - Skill name used in SKILL.md frontmatter.
 * @param withEvals - When true (default), write evals/evals.json inside the skill.
 * @returns Absolute path to the skill directory.
 */
function buildFixtureSkillDir(dir: string, skillName = 'poc-skill', withEvals = true): string {
  const skillDir = safePath.join(dir, skillName);
  mkdirSyncReal(skillDir, { recursive: true });

  // SKILL.md — name + description must meet VAT validation requirements.
  const skillMd = [
    '---',
    `name: ${skillName}`,
    `description: Use when a developer needs to test the ${skillName} skill against a trivial prompt for POC purposes.`,
    '---',
    '',
    `# ${skillName}`,
    '',
    'This is a minimal fixture skill created at test runtime.',
    '',
  ].join('\n');

  writeTestFile(safePath.join(skillDir, 'SKILL.md'), skillMd);

  if (withEvals) {
    const evalsDir = safePath.join(skillDir, 'evals');
    mkdirSyncReal(evalsDir, { recursive: true });
    writeTestFile(safePath.join(evalsDir, 'evals.json'), TRIVIAL_EVALS_JSON);
  }

  return skillDir;
}

/**
 * Create the harness --out dir up front with the required 0700 mode so that
 * run-harness's mkdirSyncReal(harnessRoot, { mode: 0o700 }) on an existing dir
 * (which ignores mode on most platforms) still finds the correct mode.
 */
function prepareOutDir(outDir: string): void {
  mkdirSyncReal(outDir, { recursive: true, mode: 0o700 });
}

/** One `files:` entry: a repo-relative source injected at `dest` inside the built dist. */
interface InjectedFile {
  source: string;
  dest: string;
}

/**
 * YAML lines for one `skills.config.<name>` entry that injects `files:` into the
 * skill's built dist. Injected files are not link-walked from markdown, so the
 * block also allows PACKAGED_UNREFERENCED_FILE (otherwise an error).
 */
function skillFilesConfigLines(
  skillName: string,
  files: InjectedFile[],
  reason: string,
): string[] {
  return [
    `    ${skillName}:`,
    '      files:',
    ...files.flatMap(f => [`        - source: ${f.source}`, `          dest: ${f.dest}`]),
    '      validation:',
    '        allow:',
    '          PACKAGED_UNREFERENCED_FILE:',
    '            - paths: ["**"]',
    `              reason: ${reason}`,
  ];
}

/**
 * Write the synthetic project's vibe-agent-toolkit.config.yaml: every skill under
 * `skills/**` is declared, plus whatever per-skill `skills.config` lines the caller
 * supplies (see {@link skillFilesConfigLines}).
 */
function writeDeclaredProjectConfig(projectRoot: string, perSkillLines: string[]): void {
  const lines = [
    'version: 1',
    'skills:',
    '  include:',
    '    - "skills/**/SKILL.md"',
    ...perSkillLines,
    '',
  ];
  writeTestFile(safePath.join(projectRoot, 'vibe-agent-toolkit.config.yaml'), lines.join('\n'));
}

/**
 * Build a synthetic VAT project that DECLARES a single pool skill via
 * vibe-agent-toolkit.config.yaml (`skills.include`). Returns the project root
 * (pass it as the CLI cwd so `findProjectRoot`/`resolveSkillReference` anchor on
 * it) and the declared skill name (its bare reference). Fully synthetic — never a
 * real adopter skill.
 *
 * The skill source lands at `<root>/skills/<name>/SKILL.md` (+ evals/evals.json
 * inside). A declared pool skill builds to `<root>/dist/skills/<name>`.
 *
 * When `injectEvals` is true the config also injects the skill's evals/evals.json
 * INTO the built dist via a `files:` mapping — because `packageSkill` copies only
 * link-walked resources, not the whole source tree, so the harness-staged dist
 * would lack evals/ without this. Needed for a full build -> stage -> grade run.
 */
function buildDeclaredPoolProject(
  parentDir: string,
  skillName = 'poc-skill',
  injectEvals = true,
): { projectRoot: string; skillName: string } {
  const projectRoot = safePath.join(parentDir, 'project');
  const skillsDir = safePath.join(projectRoot, 'skills');
  mkdirSyncReal(skillsDir, { recursive: true });
  // Writes skills/<name>/SKILL.md (+ evals/evals.json) with valid frontmatter.
  buildFixtureSkillDir(skillsDir, skillName);

  writeDeclaredProjectConfig(
    projectRoot,
    injectEvals
      ? [
          '  config:',
          ...skillFilesConfigLines(
            skillName,
            [{ source: `skills/${skillName}/evals/evals.json`, dest: 'evals/evals.json' }],
            'evals injected for skill-test staging, not linked from markdown',
          ),
        ]
      : [],
  );
  return { projectRoot, skillName };
}

// ---------------------------------------------------------------------------
// Companion-build fixture (issue #158)
// ---------------------------------------------------------------------------

/** Companion alias for the declared companion staged via `--with`. */
const DECLARED_COMPANION_ALIAS = 'helper';
/** Companion alias for the declared companion staged via `--with-optional`. */
const OPTIONAL_COMPANION_ALIAS = 'opt';
/** Companion alias for the UNDECLARED (negative-control) companion. */
const UNDECLARED_COMPANION_ALIAS = 'raw';
/** Where the companion's `files:` mapping injects its build artifact inside the dist. */
const COMPANION_ARTIFACT_DEST = 'bin/tool.mjs';
/** Byte-exact contents of the injected build artifact (asserted after staging). */
const COMPANION_ARTIFACT_BODY = '#!/usr/bin/env node\nprocess.stdout.write("companion-tool-v1\\n");\n';

/**
 * Build a synthetic project declaring THREE pool skills — a SUBJECT and two
 * COMPANIONS (one staged as required, one as optional) — plus one UNDECLARED
 * skill dir used as the negative control.
 *
 * Each COMPANION carries a `files:` mapping that injects a build artifact into its
 * packaged dist. That injection happens ONLY inside `packageSkill`, so it is the
 * observable proof that a `--with`/`--with-optional` companion mapping to a
 * declared skill was BUILT rather than tree-copied from source (issue #158).
 *
 * NO skill ships evals/, so the run stops at the harness's bootstrap check
 * (exit 3) — which fires AFTER companion build + staging but BEFORE preflight and
 * any Claude spawn. That keeps this guard deterministic and token-free in
 * credential-less CI, which is exactly where it has to bite.
 *
 * The artifact SOURCE lives under `build-artifacts/` and is written at test
 * runtime: a committed fixture dir named `dist/` (or `build/`, `node_modules/`,
 * `coverage/`) is gitignored at the repo root and silently vanishes in a clean CI
 * clone.
 */
function buildCompanionArtifactProject(parentDir: string): {
  projectRoot: string;
  subjectName: string;
  companionSourceDir: string;
  optionalCompanionSourceDir: string;
  undeclaredSourceDir: string;
} {
  const projectRoot = safePath.join(parentDir, 'project');
  const skillsDir = safePath.join(projectRoot, 'skills');
  mkdirSyncReal(skillsDir, { recursive: true });

  const subjectName = 'poc-skill';
  buildFixtureSkillDir(skillsDir, subjectName, false);
  const companionSourceDir = buildFixtureSkillDir(skillsDir, 'helper-skill', false);
  const optionalCompanionSourceDir = buildFixtureSkillDir(skillsDir, 'helper-optional-skill', false);
  // Same shape as the companions, but OUTSIDE the `skills/**` include glob, so it
  // maps to no declared skill and is staged as raw source.
  const undeclaredSourceDir = buildFixtureSkillDir(
    safePath.join(projectRoot, 'vendor'),
    'raw-skill',
    false,
  );

  const artifactSource = 'build-artifacts/bin/tool.mjs';
  const artifactDir = safePath.join(projectRoot, 'build-artifacts', 'bin');
  mkdirSyncReal(artifactDir, { recursive: true });
  writeTestFile(safePath.join(artifactDir, 'tool.mjs'), COMPANION_ARTIFACT_BODY);

  const injectReason = 'build artifact injected at package time; not linked from markdown';
  const injected = [{ source: artifactSource, dest: COMPANION_ARTIFACT_DEST }];
  writeDeclaredProjectConfig(projectRoot, [
    '  config:',
    ...skillFilesConfigLines('helper-skill', injected, injectReason),
    ...skillFilesConfigLines('helper-optional-skill', injected, injectReason),
  ]);

  return {
    projectRoot,
    subjectName,
    companionSourceDir,
    optionalCompanionSourceDir,
    undeclaredSourceDir,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const ctx = createSuiteContext(TEMP_DIR_PREFIX, import.meta.url);

/**
 * Assert the CLI exit status, surfacing the harness's own error in the failure
 * message. A bare `expect(status).toBe(n)` hides WHY the command exited
 * differently — the harness prints its error to stderr right before exiting.
 * The CI reporter truncates long messages from the front, and the leading
 * security-warning banner is boilerplate, so we front-load the LAST few
 * non-empty stderr lines, where `run.ts` writes the actionable `Error: …`.
 */
function expectStatus(
  result: { status: number | null; stdout: string; stderr: string },
  expected: number,
): void {
  const lastLines = (result.stderr || '')
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim().length > 0)
    .slice(-6)
    .join(' | ');
  expect(
    result.status,
    `expected exit ${expected}, got ${String(result.status)}. Harness stderr (tail): ${lastLines.slice(-600)}`,
  ).toBe(expected);
}

/**
 * Absolute path of `relPath` inside the harness-staged directory for the companion
 * staged under `alias`. Staging maps a name onto a single safe path segment via
 * `stagedDirName` (basename slug + hash), so the dir name is derived, not guessed.
 */
function stagedPath(outDir: string, alias: string, relPath: string): string {
  return safePath.join(outDir, stagedDirName(alias), relPath);
}

/** Assert `results/provenance.json` exists under `outDir` and return its parsed contents. */
function readProvenance(outDir: string): Record<string, unknown> {
  const provenancePath = safePath.join(outDir, 'results', 'provenance.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
  expect(fs.existsSync(provenancePath)).toBe(true);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
  return JSON.parse(fs.readFileSync(provenancePath, 'utf-8')) as Record<string, unknown>;
}

/**
 * Shared scaffold for declared-pool skill dry-run tests.
 *
 * Builds a synthetic VAT project declaring 'poc-skill', optionally pre-creates
 * the built dist dir, invokes `vat skill test run --dry-run`, asserts exit 0,
 * and returns the CLI result + outDir path for per-test assertions.
 *
 * @param outDirName       - Name for the output dir (nested inside the temp dir).
 * @param withPreBuiltDist - When true, pre-creates a stale dist dir so a NON-building
 *   dry run stages it rather than falling back to the source dir.
 * @param noBuild - Add `--no-build`. `--dry-run` alone BUILDS once acknowledged, so
 *   this is the only way to reach the stale/fallback branches now.
 */
async function runDeclaredDryRun(
  outDirName: string,
  withPreBuiltDist = false,
  noBuild = false,
): Promise<{ result: Awaited<ReturnType<typeof executeCli>>; outDir: string }> {
  const tempDir = ctx.createTempDir();
  const { projectRoot, skillName } = buildDeclaredPoolProject(tempDir, 'poc-skill');
  if (withPreBuiltDist) {
    buildFixtureSkillDir(safePath.join(projectRoot, 'dist', 'skills'), skillName, false);
  }
  const outDir = safePath.join(tempDir, outDirName);
  prepareOutDir(outDir);

  const result = await executeCli(
    ctx.binPath,
    [
      'skill', 'test', 'run', skillName,
      '--dry-run',
      ...(noBuild ? ['--no-build'] : []),
      '--i-understand-this-runs-skill-code',
      '--out', outDir,
    ],
    { cwd: projectRoot },
  );

  expectStatus(result, 0);
  return { result, outDir };
}

describe('vat skill test run (system)', () => {
  beforeAll(ctx.setup);
  afterEach(ctx.cleanup);

  // -------------------------------------------------------------------------
  // ALWAYS-RUNS: CI-safe cases (no claude binary required)
  // -------------------------------------------------------------------------

  it('--help exits 0 and documents key flags', async () => {
    const result = await executeCli(ctx.binPath, ['skill', 'test', 'run', '--help']);

    expect(result.status).toBe(0);
    // All three flags called out in the task brief must appear.
    expect(result.stdout).toContain('--dry-run');
    expect(result.stdout).toContain('--i-understand-this-runs-skill-code');
    expect(result.stdout).toContain('--auth');
    // Exit code table must be present.
    expect(result.stdout).toContain('Exit Codes:');
  });

  it('exits 2 without --i-understand-this-runs-skill-code (safety gate fires)', async () => {
    const tempDir = ctx.createTempDir();
    const skillDir = buildFixtureSkillDir(tempDir);
    const outDir = safePath.join(tempDir, 'harness-gate');
    prepareOutDir(outDir);

    // The fixture skill ships evals/evals.json, so staging carries it and the
    // bootstrap check passes. Without the ack flag, preflight (claude binary
    // absent) or the ack enforcement that follows both map to exit code 2.
    const result = await executeCli(ctx.binPath, [
      'skill',
      'test',
      'run',
      skillDir,
      '--out',
      outDir,
    ]);

    expectStatus(result, 2);

    // Confirm grading.json was NOT written inside the harness root.
    const gradingPath = safePath.join(outDir, 'results', 'grading.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
    expect(fs.existsSync(gradingPath)).toBe(false);
  });

  it('exits 3 and scaffolds an evals.json template when the skill has no evals/', async () => {
    const tempDir = ctx.createTempDir();
    // Build a fixture skill WITHOUT evals/ so the bootstrap path fires.
    const skillDir = buildFixtureSkillDir(tempDir, 'poc-skill', false);
    const outDir = safePath.join(tempDir, 'harness-bootstrap');
    prepareOutDir(outDir);

    const result = await executeCli(ctx.binPath, [
      'skill',
      'test',
      'run',
      skillDir,
      '--i-understand-this-runs-skill-code',
      '--out',
      outDir,
    ]);

    expectStatus(result, 3);

    // Bootstrap (exit 3) is the happy "wrote a template, fill it in" path — it
    // must NOT be printed as a hard error. The message reaches the user without
    // the `Error:` prefix and points at the scaffolded template.
    expect(result.stderr).not.toContain('Error: Wrote');
    expect(result.stderr).toContain('evals.json template');

    // The scaffold must persist next to the subject source (the fixture skill dir).
    const scaffoldPath = safePath.join(skillDir, 'evals', 'evals.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
    expect(fs.existsSync(scaffoldPath)).toBe(true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
    const template = JSON.parse(fs.readFileSync(scaffoldPath, 'utf-8')) as Record<string, unknown>;
    expect(template['skill_name']).toBe('poc-skill');
    expect(Array.isArray(template['evals'])).toBe(true);
  });

  it('--dry-run with no evals/ describes the scaffold path WITHOUT writing it (exit 3)', async () => {
    const tempDir = ctx.createTempDir();
    // Fixture skill WITHOUT evals/ so the bootstrap path fires — but under
    // --dry-run, which must never touch the filesystem. (Bootstrap fires before
    // the auth-gated preflight, so this needs neither claude nor auth.)
    const skillDir = buildFixtureSkillDir(tempDir, 'poc-skill', false);
    const outDir = safePath.join(tempDir, 'harness-bootstrap-dryrun');
    prepareOutDir(outDir);

    const result = await executeCli(ctx.binPath, [
      'skill',
      'test',
      'run',
      skillDir,
      '--dry-run',
      '--out',
      outDir,
    ]);

    // Same bootstrap-needed signal as a real run — the precondition (no eval
    // suite) is identical; only the side effect differs.
    expectStatus(result, 3);

    const scaffoldPath = safePath.join(skillDir, 'evals', 'evals.json');
    // The whole point: --dry-run must NOT scaffold the template on disk.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
    expect(fs.existsSync(scaffoldPath)).toBe(false);

    // Instead it must say what a real run WOULD write, and where.
    expect(result.stderr).toContain('dry-run');
    expect(result.stderr).toContain(scaffoldPath);
    expect(result.stderr).not.toContain('Error:');
  });

  it('exits 2 with a "vat build" hint when --no-build is used and the dist is absent', async () => {
    // A config-declared pool skill resolves to `buildable`; --no-build with no
    // built dist fails in resolveSubjectForTest (SkillBuildError -> exit 2) BEFORE
    // any spawn, so this case needs neither claude nor auth and runs in normal CI.
    const tempDir = ctx.createTempDir();
    const { projectRoot, skillName } = buildDeclaredPoolProject(tempDir, 'poc-skill', false);

    // cwd MUST be the synthetic project root so the bare name resolves against its
    // config (not an ancestor's). No dist/ exists, so --no-build cannot stage.
    const result = await executeCli(
      ctx.binPath,
      ['skill', 'test', 'run', skillName, '--no-build'],
      { cwd: projectRoot },
    );

    expectStatus(result, 2);
    // The actionable hint must point the user at `vat build`.
    expect(result.stderr).toContain('vat build');
  });

  // -------------------------------------------------------------------------
  // ALWAYS-RUNS regression guard for issue #158.
  //
  // The user-visible claim of #158 is that a `--with`/`--with-optional` companion
  // which maps to a DECLARED skill gets BUILT — so its `files:` build-artifact
  // injection runs — instead of being tree-copied as raw source. #158's real-world
  // symptom was a companion backed by a bundled executable staging non-functional
  // and hanging the executor with no diagnostic.
  //
  // The assertion is therefore on BYTES ON DISK under the staged companion dir, not
  // on a path string or a mock call: `files:` injection happens inside
  // `packageSkill`, which every unit/integration companion test mocks away.
  //
  // Both companions ride ONE CLI invocation so the declared and undeclared arms are
  // compared under identical conditions; the undeclared arm is the teeth-check
  // (a raw-source stage of the same-shaped skill must NOT carry the artifact).
  // -------------------------------------------------------------------------

  it('builds --with/--with-optional companions that map to declared skills, injecting their files: artifacts into the staged dirs', async () => {
    const tempDir = ctx.createTempDir();
    const {
      projectRoot,
      subjectName,
      companionSourceDir,
      optionalCompanionSourceDir,
      undeclaredSourceDir,
    } = buildCompanionArtifactProject(tempDir);
    const outDir = safePath.join(tempDir, 'harness-companion-build');
    prepareOutDir(outDir);

    // cwd MUST be the synthetic project root so both the bare subject name and the
    // companion source paths resolve against ITS config (not an ancestor's).
    const result = await executeCli(
      ctx.binPath,
      [
        'skill', 'test', 'run', subjectName,
        '--with', `${DECLARED_COMPANION_ALIAS}=path:${companionSourceDir}`,
        '--with-optional', `${OPTIONAL_COMPANION_ALIAS}=path:${optionalCompanionSourceDir}`,
        '--with', `${UNDECLARED_COMPANION_ALIAS}=path:${undeclaredSourceDir}`,
        '--i-understand-this-runs-skill-code',
        '--out', outDir,
      ],
      { cwd: projectRoot },
    );

    // Exit 3 = the subject ships no evals/, so the harness stopped at its bootstrap
    // check. That check runs AFTER companion resolution + staging and BEFORE
    // preflight/spawn — no claude binary, no auth, no tokens, same result in CI.
    expectStatus(result, 3);

    // THE CLAIM: each companion's `files:`-injected build artifact is a real file
    // under its staged dir. It exists in the built dist ONLY — nothing copies it
    // from the source tree, so raw-source staging cannot produce it. Asserted for
    // BOTH arms: `--with` and `--with-optional` resolve through separate call sites.
    for (const alias of [DECLARED_COMPANION_ALIAS, OPTIONAL_COMPANION_ALIAS]) {
      const artifactPath = stagedPath(outDir, alias, COMPANION_ARTIFACT_DEST);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
      expect(fs.existsSync(artifactPath), `injected artifact missing at ${artifactPath}`).toBe(true);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
      expect(fs.readFileSync(artifactPath, 'utf-8')).toBe(COMPANION_ARTIFACT_BODY);
    }

    // NEGATIVE CONTROL: a same-shaped companion whose path maps to NO declared skill
    // is staged as raw source. It must stage (SKILL.md present — proving the
    // assertions above are not passing merely because staging happened at all) and
    // it must NOT carry the injected artifact.
    const rawSkillMd = stagedPath(outDir, UNDECLARED_COMPANION_ALIAS, 'SKILL.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
    expect(fs.existsSync(rawSkillMd), `undeclared companion not staged at ${rawSkillMd}`).toBe(true);
    const rawArtifact = stagedPath(outDir, UNDECLARED_COMPANION_ALIAS, COMPANION_ARTIFACT_DEST);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
    expect(fs.existsSync(rawArtifact)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // GUARDED dry-run (skipped when claude + auth are absent)
  // -------------------------------------------------------------------------

  describe.skipIf(!authed)('dry-run (requires claude + auth)', () => {
    it('exits 0, shows assembled command, and does not write grading.json', async () => {
      const tempDir = ctx.createTempDir();
      // Fixture skill ships evals/evals.json; staging carries it so the harness
      // genuinely resolves the staged subject's evals — no manual seeding.
      const skillDir = buildFixtureSkillDir(tempDir);
      const outDir = safePath.join(tempDir, 'harness-dry');
      prepareOutDir(outDir);

      const result = await executeCli(ctx.binPath, [
        'skill',
        'test',
        'run',
        skillDir,
        '--dry-run',
        '--model',
        'claude-opus-4-8',
        '--i-understand-this-runs-skill-code',
        '--out',
        outDir,
      ]);

      expect(result.status).toBe(0);
      // Dry-run must mention the assembled command (not spawn). The run summary
      // now lands on stdout (programmatic-consumer routing); only the security
      // warning and the `Harness:` debug line stay on stderr.
      expect(result.stdout).toContain('dry-run');
      // The assembled command surfaces the model passed verbatim to claude --model,
      // and the selected model is echoed to stderr on every run.
      expect(result.stdout).toContain('--model claude-opus-4-8');
      expect(result.stderr).toContain('Model: claude-opus-4-8');
      // grading.json must NOT exist — dry-run does not spawn Claude.
      const gradingPath = safePath.join(outDir, 'results', 'grading.json');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
      expect(fs.existsSync(gradingPath)).toBe(false);
    });

    it('--no-build --dry-run for a declared pool skill (no dist): says it did NOT build, flags the source fallback', async () => {
      // Synthetic declared project; the bare name resolves to `buildable`.
      // --no-build + no dist → falls back to source (dryRunStagedExistingDist=false).
      const { result, outDir } = await runDeclaredDryRun('harness-dry-declared-nodist', false, true);

      // Must be explicit that nothing was built
      expect(result.stdout).toContain('Staged the declared skill WITHOUT building');
      // Must say it fell back to source since no dist exists yet
      expect(result.stdout).toContain('fell back to the source dir');
      // grading.json must NOT be written
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
      expect(fs.existsSync(safePath.join(outDir, 'results', 'grading.json'))).toBe(false);
      // Provenance must exist (written before the dry-run short-circuit)
      const provenance = readProvenance(outDir);
      // Summary must reference the provenance fingerprint and path
      expect(result.stdout).toContain(String(provenance['fingerprint']));
      expect(result.stdout).toContain('provenance.json');
    });

    it('--no-build --dry-run for a declared pool skill (existing dist): says it did NOT build, flags stale', async () => {
      // Pre-create the expected dist dir (no evals/) so the non-building dry run
      // stages it instead of falling back. The harness reads the authored evals from
      // source so the bootstrap check passes. (dryRunStagedExistingDist=true)
      const { result } = await runDeclaredDryRun('harness-dry-declared-stale', true, true);

      // Must be explicit that nothing was built
      expect(result.stdout).toContain('Staged the declared skill WITHOUT building');
      // Must warn that the preview used an unbuilt (possibly stale) dist
      expect(result.stdout).toContain('STALE');
      // Must point users at `vat build`
      expect(result.stdout).toContain('vat build');
      // Must reference the provenance path
      expect(result.stdout).toContain('provenance.json');
    });
  });

  // -------------------------------------------------------------------------
  // GUARDED e2e (skipped unless claude + auth + VAT_SKILL_TEST_E2E=1)
  //
  // This block is gated behind an explicit opt-in env var in addition to the
  // authed check because:
  //   1. Token cost: a real Claude session is spawned on every run.
  //   2. Non-determinism: LLM responses make the test non-deterministic,
  //      which breaks the reliability expectation of `bun run validate` and
  //      the pre-commit hook that runs it.
  //
  // To run e2e locally: VAT_SKILL_TEST_E2E=1 bunx vitest run --config
  // vitest.system.config.ts packages/cli/test/system/skill-test.system.test.ts
  // -------------------------------------------------------------------------

  describe.skipIf(!(authed && process.env['VAT_SKILL_TEST_E2E'] === '1'))('end-to-end (requires claude + auth + VAT_SKILL_TEST_E2E=1)', () => {
    it('runs the experimenter and writes valid grading.json', async () => {
      const tempDir = ctx.createTempDir();
      const skillDir = buildFixtureSkillDir(tempDir);
      const outDir = safePath.join(tempDir, 'harness-e2e');
      prepareOutDir(outDir);

      const result = await executeCli(ctx.binPath, [
        'skill',
        'test',
        'run',
        skillDir,
        '--i-understand-this-runs-skill-code',
        '--out',
        outDir,
      ]);

      // Exit 0 = harness ran to completion and produced a valid grading.json.
      expect(result.status).toBe(0);

      // grading.json must exist and be parseable with the expected shape.
      const gradingPath = safePath.join(outDir, 'results', 'grading.json');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
      expect(fs.existsSync(gradingPath)).toBe(true);

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
      const raw = JSON.parse(fs.readFileSync(gradingPath, 'utf-8')) as Record<string, unknown>;
      // Validate the top-level shape expected by parseGradingJson.
      expect(Array.isArray(raw['expectations'])).toBe(true);
      const expectations = raw['expectations'] as unknown[];
      expect(expectations.length).toBeGreaterThan(0);

      const first = expectations[0] as Record<string, unknown>;
      expect(typeof first['text']).toBe('string');
      expect(typeof first['passed']).toBe('boolean');
    });
  });

  // -------------------------------------------------------------------------
  // GUARDED build/dist resolution (skipped unless claude + auth + E2E=1)
  //
  // These exercise resolveSkillReference -> build -> stage end-to-end and spawn
  // a real Claude session, so they are gated exactly like the e2e block above.
  // -------------------------------------------------------------------------

  describe.skipIf(!(authed && process.env['VAT_SKILL_TEST_E2E'] === '1'))('build + dist resolution (requires claude + auth + VAT_SKILL_TEST_E2E=1)', () => {
    it('builds a declared pool skill, stages its dist, and writes provenance.json', async () => {
      const tempDir = ctx.createTempDir();
      // Synthetic project declaring one pool skill; the bare name resolves to
      // `buildable`, so run.ts builds it (packageSkill) and stages the dist.
      // injectEvals=false: NO `files:` mapping ships evals into the dist, so the
      // built dist lacks evals/. The harness must overlay the authored eval suite
      // from the source scaffold dir onto the staged dist — otherwise a declared
      // skill would bootstrap forever (regression guard for the dist-vs-source bug).
      const { projectRoot, skillName } = buildDeclaredPoolProject(tempDir, 'poc-skill', false);
      const outDir = safePath.join(tempDir, 'harness-build');
      prepareOutDir(outDir);

      const result = await executeCli(
        ctx.binPath,
        ['skill', 'test', 'run', skillName, '--i-understand-this-runs-skill-code', '--out', outDir],
        { cwd: projectRoot },
      );

      // Exit 0 = built, staged (with the overlaid eval suite), and graded the dist.
      // Specifically NOT exit 3 — the overlay means it never bootstraps.
      expect(result.status).toBe(0);

      // provenance.json records what was staged + tested; rebuilt MUST be true here.
      expect(readProvenance(outDir)['rebuilt']).toBe(true);
      const gradingPath = safePath.join(outDir, 'results', 'grading.json');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
      expect(fs.existsSync(gradingPath)).toBe(true);
    });

    it('stages a pre-built dist path as-is without rebuilding', async () => {
      const tempDir = ctx.createTempDir();
      // An already-built skill dir (stands in for dist/skills/<name>), passed by
      // absolute path. A definite-path subject resolves to `source`, never
      // `buildable`, so packageSkill never runs — it is staged verbatim.
      const distDir = buildFixtureSkillDir(tempDir, 'prebuilt-skill');
      const outDir = safePath.join(tempDir, 'harness-prebuilt');
      prepareOutDir(outDir);

      const result = await executeCli(ctx.binPath, [
        'skill',
        'test',
        'run',
        distDir,
        '--i-understand-this-runs-skill-code',
        '--out',
        outDir,
      ]);

      expect(result.status).toBe(0);

      // No-rebuild semantics: a definite-path subject is staged as-is, so rebuilt is false.
      expect(readProvenance(outDir)['rebuilt']).toBe(false);

      // A definite-path subject is never built, so run.ts never attempts (and never
      // fails) a skill build.
      expect(result.stderr).not.toContain('Skill build failed');
    });
  });
});
