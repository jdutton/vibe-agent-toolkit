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
        '--i-understand-this-runs-skill-code',
        '--out',
        outDir,
      ]);

      expect(result.status).toBe(0);
      // Dry-run must mention the assembled command (not spawn). The run summary
      // now lands on stdout (programmatic-consumer routing); only the security
      // warning and the `Harness:` debug line stay on stderr.
      expect(result.stdout).toContain('dry-run');
      // grading.json must NOT exist — dry-run does not spawn Claude.
      const gradingPath = safePath.join(outDir, 'results', 'grading.json');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path, controlled by this file
      expect(fs.existsSync(gradingPath)).toBe(false);
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
});
