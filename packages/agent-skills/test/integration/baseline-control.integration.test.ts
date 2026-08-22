/* eslint-disable security/detect-non-literal-fs-filename -- test paths are our own controlled temp dirs */
/**
 * THE CONTROL: a `--baseline` run's skill-absent arm must not be handed the skill.
 *
 * This is the test that did not exist, and its absence is why the original defect
 * shipped and why the FIRST fix for it was itself incomplete. Every prior baseline
 * assertion in this repo tested a pure helper — `buildExecutorPrompt`,
 * `buildEvalWorkItems`, the detector — and no test anywhere ran the harness with
 * `baseline: true`. A mutation pass proved the consequence: restoring the original
 * bug verbatim (hand the control arm the staged subject path) left the entire
 * suite green.
 *
 * So this asserts the PROPERTY, not the mechanisms. A path reaches a child process
 * through four channels — prompt, argv, cwd, and environment — and the first fix
 * closed three of them. `CLAUDE_PLUGIN_ROOT` in the fourth still pointed at the
 * staged plugin root, so one `env | grep` recovered the whole treatment. The
 * assertion below is therefore deliberately phrased over the WHOLE spawn rather
 * than over named fields: any future channel that carries the harness root into
 * the control arm fails here by construction, without anyone remembering to
 * extend a list.
 *
 * The spawn is faked, as in the sibling answer-key canary. The property is about
 * what VAT HANDS the process, which is identical whether the process on the other
 * end is real or fake.
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath, toForwardSlash, type SpawnHeadlessOptions } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import {
  runSkillTestHarness,
  RETAINED_RESULTS_DIRNAME,
  type RunHarnessOptions,
} from '../../src/skill-test/run-harness.js';
import { makeHarnessFakeSpawn } from '../skill-test/spawn-stub.js';
import { setupTempDir } from '../test-helpers.js';

vi.mock('../../src/skill-test/preflight.js', async (io) => (await import('../skill-test/preflight-stub.js')).passingPreflight(io));

const SKILL_NAME = 'control-skill';
const EVAL_ID = 'no-files-eval';
/**
 * One body line long and distinctive enough to become a content needle — the
 * signal an instruction-only skill depends on. Kept out of the eval prompt on
 * purpose: a needle the suite's own text contains is excluded by design.
 */
const SKILL_BODY_LINE = 'Rows are assigned to the nearest bucket whose ceiling exceeds the row value.';
const SKILL_MD = `---\nname: ${SKILL_NAME}\ndescription: A fixture skill for the baseline control test.\n---\n\n# Control\n\n${SKILL_BODY_LINE}\n`;
/** The `--baseline` arm's artifact — the file this whole lane exists to make honest. */
const BASELINE_JSON = 'baseline.json';

const { getTempDir } = setupTempDir('vat-baseline-control-');

/**
 * A subject in PLUGIN layout — the shape the defect was reported against, and the
 * only shape for which `CLAUDE_PLUGIN_ROOT` is set at all. A standalone-skill
 * fixture would pass this test while the hole stayed wide open.
 */
function writePluginFixture(
  skillName: string = SKILL_NAME,
  evalPrompt = 'do the thing',
): { subjectDir: string; pluginRoot: string } {
  const pluginRoot = safePath.join(getTempDir(), 'src', `plugin-${skillName}`);
  const manifestDir = safePath.join(pluginRoot, '.claude-plugin');
  mkdirSyncReal(manifestDir, { recursive: true });
  writeFileSync(
    safePath.join(manifestDir, 'plugin.json'),
    JSON.stringify({ name: 'my-plugin', version: '1.0.0' }) + '\n',
    'utf8',
  );

  const subjectDir = safePath.join(pluginRoot, 'skills', skillName);
  mkdirSyncReal(subjectDir, { recursive: true });
  // eslint-disable-next-line unicorn/prefer-string-replace-all -- test tsconfig lib predates String.replaceAll
  writeFileSync(safePath.join(subjectDir, 'SKILL.md'), SKILL_MD.replace(new RegExp(SKILL_NAME, 'g'), skillName), 'utf8');

  // An eval with NO input `files` — the case whose executor used to fall back to
  // running inside the staged subject dir.
  const evalsDir = safePath.join(subjectDir, 'evals');
  mkdirSyncReal(evalsDir, { recursive: true });
  writeFileSync(
    safePath.join(evalsDir, 'evals.json'),
    JSON.stringify({
      skill_name: skillName,
      evals: [{ id: EVAL_ID, prompt: evalPrompt, expectations: ['it happened'] }],
    }) + '\n',
    'utf8',
  );
  return { subjectDir, pluginRoot };
}

function baselineOpts(
  subjectDir: string,
  spawn: RunHarnessOptions['spawn'],
  extra: Partial<RunHarnessOptions> = {},
): RunHarnessOptions {
  return {
    subject: SKILL_NAME,
    repoRoot: getTempDir(),
    out: safePath.join(getTempDir(), 'harness'),
    subjectSource: { path: subjectDir },
    subjectScaffoldDir: subjectDir,
    acknowledgedRunsSkillCode: true,
    allowUnverifiedSkillSource: true,
    baseline: true,
    ...(spawn === undefined ? {} : { spawn }),
    ...extra,
  };
}

/**
 * The DEFAULT invocation: no `--out`, no `--workdir`, no `--keep` — the one
 * `vat-skill-testing.md`'s copy-paste example uses, and the only one for which
 * `harnessCreated` is true and cleanup actually fires.
 *
 * Every other test in this file passes `out:` or `keep: true`, which is exactly
 * why none of them could see that cleanup deleted `results/baseline.json` inside
 * the harness's own `finally` before the caller ever got the result back. The
 * subject name is a parameter because the derived harness root is a pure function
 * of it (`<tmp>/vat-skill-test/<sanitized>-<hash8>`) and lands in the REAL OS temp
 * dir, shared with every other run on the machine — so this test needs a name no
 * other test or developer run will collide with.
 */
function defaultRunOpts(
  subjectDir: string,
  spawn: RunHarnessOptions['spawn'],
  subject: string,
): RunHarnessOptions {
  const opts = baselineOpts(subjectDir, spawn);
  delete opts.out;
  opts.subject = subject;
  return opts;
}

/**
 * EVERY value VAT hands one spawn, serialized whole — not an enumeration of the
 * fields we currently think matter.
 *
 * This used to name five fields (`prompt`, `cwd`, `sandboxDir`, `pluginDirs`,
 * `env`) while `SpawnHeadlessOptions` carries seven, and a mutation that routed the
 * staged skill dir through `model` — which `assembleClaudeArgs` puts straight onto
 * argv as `--model <path>` — left all four tests green. An allowlist here reproduces,
 * one level up, exactly the failure this file exists to prevent: the first fix closed
 * three of four channels, and its test closed five of seven fields. Serializing the
 * whole options object is what makes the docblock's "by construction" claim true.
 */
function spawnSurface(opts: Record<string, unknown>): string {
  return JSON.stringify(opts, (_key, value) => (typeof value === 'function' ? undefined : value));
}

/**
 * Fold a path or a serialized surface into one comparable spelling, mirroring the
 * production `normalizeForMatch`. `JSON.stringify` escapes a Windows separator as
 * `\\`, which becomes `//` under a naive slash flip and then matches no
 * single-slash needle — so collapsing slash runs is what keeps these assertions
 * alive on Windows rather than merely green.
 */
/**
 * Extra stream-json emitted by the CONTROL arm alone.
 *
 * Only its transcript is scanned, so putting the evidence on both arms would let
 * a test pass on a detector that read the wrong one. The arm is identified the
 * way the whole file identifies it — the one spawned with no plugin dirs.
 */
function controlArmEmits(
  build: (opts: SpawnHeadlessOptions) => unknown,
): (opts: SpawnHeadlessOptions) => string | undefined {
  return (opts) => (opts.pluginDirs.length === 0 ? JSON.stringify(build(opts)) : undefined);
}

/** A single assistant text block, the shape a model answers in. */
const assistantText = (text: string): unknown => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
});

/** A single Bash tool_use block, the shape a model reaches with. */
const assistantBash = (command: string): unknown => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
});

/**
 * The integrity block read back off disk, which is the only place it reaches an
 * operator. Reading it rather than trusting the in-memory result is the point:
 * a block computed and never written is the failure this file already caught once.
 */
function readBaselineIntegrity(resultsDir: string = safePath.join(getTempDir(), 'harness', RETAINED_RESULTS_DIRNAME)): {
  contaminated?: boolean;
  signals?: string[];
  findings?: Array<{ evalId?: string }>;
} {
  const baselinePath = safePath.join(resultsDir, BASELINE_JSON);
  expect(existsSync(baselinePath), 'baseline.json was never written').toBe(true);
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
    baselineIntegrity?: { contaminated?: boolean; signals?: string[]; findings?: Array<{ evalId?: string }> };
  };
  expect(parsed.baselineIntegrity, 'baselineIntegrity block missing').toBeDefined();
  return parsed.baselineIntegrity ?? {};
}

/**
 * Run a baseline harness to completion and hand back the integrity block it left
 * on disk — the sequence every verdict assertion in this file needs, and the one
 * whose middle step (the run actually succeeding) is what stops a later assertion
 * passing against a file some earlier test wrote.
 */
async function runBaselineForIntegrity(
  subjectDir: string,
  spawn: RunHarnessOptions['spawn'],
  extra: Partial<RunHarnessOptions> = {},
): Promise<ReturnType<typeof readBaselineIntegrity>> {
  const result = await runSkillTestHarness(baselineOpts(subjectDir, spawn, extra));
  expect(result.exitCode, result.summary).toBe(0);
  return readBaselineIntegrity();
}

function fold(value: string): string {
  // eslint-disable-next-line unicorn/prefer-string-replace-all -- test tsconfig lib predates String.replaceAll
  return toForwardSlash(value).replace(/\/{2,}/g, '/').toLowerCase();
}

describe('baseline control arm (integration)', () => {
  it('hands the skill-absent arm no path to the skill through ANY channel', async () => {
    const { subjectDir } = writePluginFixture();
    const control: Array<Record<string, unknown>> = [];
    const treatment: Array<Record<string, unknown>> = [];

    const fake = makeHarnessFakeSpawn({
      onExecutorSpawn: (opts) => {
        // The control arm is the one spawned with no plugin dirs.
        (opts.pluginDirs.length === 0 ? control : treatment).push({ ...opts });
      },
    });

    const result = await runSkillTestHarness(baselineOpts(subjectDir, fake.spawn));

    expect(result.exitCode, result.summary).toBe(0);
    // Both arms ran — a baseline run that silently produced only one arm would
    // otherwise satisfy every assertion below vacuously.
    expect(control, 'no skill-absent arm was spawned').toHaveLength(1);
    expect(treatment, 'no skill-present arm was spawned').toHaveLength(1);

    const harnessRoot = fold(result.harnessPath);
    const surface = fold(spawnSurface(control[0] as Record<string, unknown>));

    // The whole point, stated once: nothing VAT hands the control arm may lead to
    // the staged skill. Not the prompt, not argv, not cwd, not the environment.
    expect(surface, `control arm was handed the harness root:\n${surface}`).not.toContain(harnessRoot);

    // And specifically the channel the first fix missed.
    expect((control[0] as { env?: NodeJS.ProcessEnv }).env ?? {}).not.toHaveProperty('CLAUDE_PLUGIN_ROOT');

    // The treatment arm still gets everything it needs — otherwise "isolated" is
    // indistinguishable from "broken", and the A/B measures nothing.
    expect(fold(spawnSurface(treatment[0] as Record<string, unknown>))).toContain(harnessRoot);
    expect((treatment[0] as { env?: NodeJS.ProcessEnv }).env ?? {}).toHaveProperty('CLAUDE_PLUGIN_ROOT');
  });

  /**
   * The FIFTH channel, and the one an audit of "what does VAT hand this process"
   * structurally cannot find: not a path into either arm, but a directory both arms
   * own. The two arms of one eval are queued adjacently into a bounded-parallel
   * pool, so they run at the same time; when they shared a workspace the control
   * arm could `ls`, read whatever the treatment had just written, and answer from
   * it — scoring like the treatment, erasing the lift, and leaving a transcript
   * with no harness path in it for the detector to find. Each arm's own cwd was
   * correct in isolation and wrong as a pair.
   */
  it('gives each arm its own workspace, so the control cannot read the treatment output', async () => {
    const { subjectDir } = writePluginFixture();
    const cwds = new Map<string, string>();

    const fake = makeHarnessFakeSpawn({
      onExecutorSpawn: (opts) => {
        cwds.set(opts.pluginDirs.length === 0 ? 'control' : 'treatment', opts.cwd ?? '');
      },
    });

    const result = await runSkillTestHarness(baselineOpts(subjectDir, fake.spawn, { keep: true }));

    expect(result.exitCode, result.summary).toBe(0);
    const controlCwd = fold(cwds.get('control') ?? '');
    const treatmentCwd = fold(cwds.get('treatment') ?? '');

    expect(controlCwd, 'no skill-absent arm was spawned').not.toBe('');
    expect(treatmentCwd, 'no skill-present arm was spawned').not.toBe('');
    expect(controlCwd, 'both arms were given the SAME working directory').not.toBe(treatmentCwd);
    // Neither may sit inside the other, which a naive `<ws>/<id>` vs `<ws>/<id>/without`
    // layout would satisfy the inequality above while still sharing everything.
    expect(controlCwd.startsWith(treatmentCwd + '/')).toBe(false);
    expect(treatmentCwd.startsWith(controlCwd + '/')).toBe(false);
  });

  /**
   * BLINDING. `buildExecutorPrompt`'s docblock promises the executor "must NEVER
   * be told (directly or by implication) that it is being tested, evaluated, or
   * graded" — and the workspace layout was quietly breaking that promise in the
   * loudest possible place. The prompt states the working directory verbatim, and
   * the directory was `…/vat-skill-test-ws-<token>/without/e1`, so each arm read
   * which side of the A/B it was on in a string it cannot avoid. It also named
   * the sibling: `../with/<id>/` was a guessable path to the treatment arm's live
   * output.
   *
   * The assertion is over the WHOLE spawn surface, not the prompt alone: the same
   * path is also the `cwd`, the `sandboxDir`, and an `--add-dir` argv slot, so
   * checking one field would leave three telling the arm the same thing.
   */
  it('never tells either arm which arm it is', async () => {
    const { subjectDir } = writePluginFixture();
    const seen = new Map<string, string>();

    const fake = makeHarnessFakeSpawn({
      onExecutorSpawn: (opts) => {
        seen.set(opts.pluginDirs.length === 0 ? 'control' : 'treatment', spawnSurface({ ...opts }));
      },
    });

    const result = await runSkillTestHarness(baselineOpts(subjectDir, fake.spawn));
    expect(result.exitCode, result.summary).toBe(0);
    expect(seen.size, 'both arms must have spawned').toBe(2);

    for (const [arm, surface] of seen) {
      // Path SEGMENTS, not a substring scan: "with" occurs in ordinary prose, and
      // the prompt legitimately contains English.
      // eslint-disable-next-line local/no-hardcoded-path-split -- `fold` already forward-slashed this; splitting on separators is the point
      const segments = new Set(fold(surface).split(/[/"\\,\s]+/));
      expect(segments, `the ${arm} arm was handed a path segment naming an arm`).not.toContain('with');
      expect(segments, `the ${arm} arm was handed a path segment naming an arm`).not.toContain('without');
    }
  });

  it("runs the control arm in its own workspace, never in the staged skill", async () => {
    const { subjectDir } = writePluginFixture();
    let controlCwd: string | undefined;

    const fake = makeHarnessFakeSpawn({
      onExecutorSpawn: (opts) => {
        if (opts.pluginDirs.length === 0) controlCwd = opts.cwd;
      },
    });

    const result = await runSkillTestHarness(baselineOpts(subjectDir, fake.spawn, { keep: true }));

    expect(result.exitCode, result.summary).toBe(0);
    expect(controlCwd).toBeDefined();
    expect(fold(controlCwd ?? '')).toContain(fold(result.workspacesPath ?? '@none'));
    expect(fold(controlCwd ?? '')).not.toContain(fold(result.harnessPath));
  });

  // The detector's whole value is that it makes a bad number LOUD. Mutation
  // testing showed both "compute the findings and throw them away" and "never
  // write the block" survived the suite — the detector was covered as a pure
  // function and unwired in practice.
  it('stamps a contaminated verdict into baseline.json when the control arm reaches the skill', async () => {
    const { subjectDir } = writePluginFixture();

    // A RELATIVE reach, which is the natural one — the control arm's cwd and the
    // harness root are siblings under the OS temp dir, so the model climbs rather
    // than typing an absolute path. The absolute root never appears in this
    // transcript, so a literal `indexOf(harnessRoot)` cannot see it; the two
    // trailing segments are what make it evidence.
    const harnessTail = toForwardSlash(safePath.join(getTempDir(), 'harness')).split('/').slice(-2).join('/');

    const fake = makeHarnessFakeSpawn({
      executorExtraStdout: controlArmEmits(() => assistantBash(`cat ../${harnessTail}/${SKILL_NAME}/SKILL.md`)),
    });

    const integrity = await runBaselineForIntegrity(subjectDir, fake.spawn);
    expect(integrity.contaminated).toBe(true);
    expect(integrity.findings?.[0]?.evalId).toBe(EVAL_ID);
  });

  // The block is unconditional: its ABSENCE must mean "this file predates the
  // check", never "checked and clean". Only an always-written field carries that.
  it('stamps a clean verdict into baseline.json when the control arm behaves', async () => {
    const { subjectDir } = writePluginFixture();

    const integrity = await runBaselineForIntegrity(subjectDir, makeHarnessFakeSpawn({}).spawn);
    expect(integrity.contaminated).toBe(false);
    expect(integrity.findings).toEqual([]);
  });

  /**
   * The reach every other signal is structurally blind to, and the common case:
   * an INSTRUCTION-ONLY skill, which ships no executable, found as an ambient copy,
   * which carries no harness path. `grep -rl "<phrase>" .` → `Read` → answer left
   * nothing for a path needle or a name needle to match, so `contaminated: false`
   * meant "saw no evidence" while reading as "verified none".
   *
   * The transcript below quotes the skill and names NOTHING — no path, no
   * executable, no directory. Only content can see it.
   */
  it('flags a control arm that quotes the skill without naming any path', async () => {
    const { subjectDir } = writePluginFixture();

    const fake = makeHarnessFakeSpawn({
      executorExtraStdout: controlArmEmits(() => assistantText(`Following the guidance: ${SKILL_BODY_LINE}`)),
    });

    const integrity = await runBaselineForIntegrity(subjectDir, fake.spawn);

    expect(integrity.signals, 'the content signal was not armed').toContain('skill-content');
    expect(integrity.contaminated, 'a quoted-skill reach went undetected').toBe(true);
    expect(integrity.findings?.[0]?.evalId).toBe(EVAL_ID);
  });

  /**
   * The other half of the content signal, and the half that decides whether it is
   * usable at all: an adopter who quotes a sentence of their own SKILL.md in an
   * eval prompt hands it to the arm THROUGH vat. The arm echoing the prompt it was
   * given is not the arm reaching the skill — and without the exclusion, every run
   * of that suite would be stamped contaminated, control and treatment alike.
   *
   * Asserted at the harness rather than on the derivation, because what has to be
   * right here is that the run's own eval text reaches the exclusion at all.
   */
  it('does not flag the control arm for echoing a skill line its own eval prompt carried', async () => {
    const { subjectDir } = writePluginFixture(SKILL_NAME, `Explain this rule: ${SKILL_BODY_LINE}`);

    const fake = makeHarnessFakeSpawn({
      executorExtraStdout: controlArmEmits(() => assistantText(`The rule says: ${SKILL_BODY_LINE}`)),
    });

    const integrity = await runBaselineForIntegrity(subjectDir, fake.spawn);

    // Unarmed, not merely quiet: the sole candidate needle was the excluded line,
    // and `signals` has to say so rather than report a clean check that never ran.
    expect(integrity.signals, 'the excluded needle was still armed').not.toContain('skill-content');
    expect(integrity.contaminated, 'echoing the prompt was reported as a reach').toBe(false);
  });

  /**
   * The executable-name signal must not fire on the control arm's OWN scratch
   * files, and the only thing that tells them apart from a reach is a path root
   * the harness has to thread in.
   *
   * A review found 8/8 realistic clean behaviours firing the old pattern —
   * `python3 analyze.py` against a declared `scripts/analyze.py`, `Wrote
   * report.md`, `saved to summary.txt` — each stamping `contaminated: true`, whose
   * attached instruction is "discard the delta". A check that routinely destroys
   * good runs is not erring safely; it teaches operators to ignore the one warning
   * that matters.
   *
   * The pattern now requires a path, and the path must escape the arm's own
   * workspace. The absolute self-reference below is the form that needs
   * `armWorkspaceDir` WIRED rather than inferred: the executor prompt states the
   * working directory absolutely, so the arm reuses that absolute path routinely,
   * and every mention would otherwise read as an escape. Asserting it here rather
   * than on the detector alone is the point — the unit tests pass `armWorkspaceDir`
   * themselves, so they cannot see the harness failing to.
   */
  it('does not flag the control arm for running its own scratch script', async () => {
    const { subjectDir } = writePluginFixture();

    const fake = makeHarnessFakeSpawn({
      // Both clean forms in one transcript: the bare filename an arm writes and
      // reports, and its own workspace named ABSOLUTELY, which is the spelling
      // its prompt handed it.
      executorExtraStdout: controlArmEmits((opts) =>
        assistantBash(`python3 summary.py && node ${opts.cwd ?? ''}/scripts/summary.mjs`),
      ),
    });

    const integrity = await runBaselineForIntegrity(subjectDir, fake.spawn, {
      declaredExecutables: [{ name: 'summary', howInvoked: 'python3 scripts/summary.py', kind: 'python' }],
    });

    // The signal must be ARMED — otherwise this passes because nothing looked,
    // which is the failure mode `signals` exists to expose.
    expect(integrity.signals, 'the executable signal was not armed').toContain('declared-executable');
    expect(
      integrity.contaminated,
      `a clean control arm was reported contaminated: ${JSON.stringify(integrity.findings)}`,
    ).toBe(false);
  });

  /**
   * The scrub must SAY what it withheld, and say it truthfully — the withholding is
   * the only visible sign that the control arm was degraded, and a degraded control
   * scores lower, which reports as skill lift.
   *
   * Two things were wrong. The mutation audit found the stderr write was pinned by
   * nothing: every assertion was on `scrubControlArmEnv`'s RETURN VALUE, so deleting
   * the write left the suite green — the same "testing a pure helper never pins its
   * wiring" class this lane has now hit four times. And the one line it did write
   * described a merged list as "naming the harness root" when half of it is dropped
   * by NAME whatever its value: on this very run CLAUDE_PLUGIN_ROOT's value is under
   * the harness root only incidentally, and in the installed-plugin-cache case it is
   * not under it at all.
   *
   * So this asserts at the CALL SITE, on a run that triggers BOTH rules — plugin
   * layout supplies the rule-1 key, the declared `env:` supplies the rule-2 value —
   * and pins each name to the reason that actually caught it.
   */
  it('says on stderr what it withheld from the control arm, and by which rule', async () => {
    const { subjectDir } = writePluginFixture();
    const fake = makeHarnessFakeSpawn({});
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      stderr.push(String(chunk));
      return true;
    });

    let result: Awaited<ReturnType<typeof runSkillTestHarness>>;
    try {
      result = await runSkillTestHarness(
        baselineOpts(subjectDir, fake.spawn, {
          // Interpolated at stage time, so the value genuinely names this run's
          // harness root rather than a literal a test author guessed.
          env: { SNAPSHOT: '${harnessRoot}/staged/data.json' },
        }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(result.exitCode, result.summary).toBe(0);
    const withheld = stderr.filter((line) => line.includes('withheld'));

    const byName = withheld.find((line) => line.includes('by name, whatever their value'));
    expect(byName, `no rule-1 withholding line on stderr:\n${withheld.join('')}`).toBeDefined();
    expect(byName).toContain('CLAUDE_PLUGIN_ROOT');
    // The rule-2 line's wording must not be applied to it — that was the bug.
    expect(byName).not.toContain('SNAPSHOT');

    const byValue = withheld.find((line) => line.includes('because their value names the harness root'));
    expect(byValue, `no rule-2 withholding line on stderr:\n${withheld.join('')}`).toBeDefined();
    expect(byValue).toContain('SNAPSHOT');
    expect(byValue).not.toContain('CLAUDE_PLUGIN_ROOT');
  });

  /**
   * Three rounds of work went into making the control arm's number honest. This is
   * the test that asks whether the honest number is still on disk when the command
   * exits — on the invocation the docs tell adopters to use.
   *
   * It ran on the DEFAULT path: `harnessCreated` true, so `cleanupHarness` fired
   * from `runSkillTestHarness`'s own `finally` and `rmSync(recursive)`'d the harness
   * root — with `results/` inside it — before `run.ts` printed the `Harness:` line
   * that pointed at it. `--baseline --help` says to read `baselineIntegrity` in
   * `baseline.json`; the run's help says failing evals live in `grading.json`;
   * neither file existed by the time the process returned to the operator.
   *
   * The other half of the assertion matters just as much: cleanup must still evict
   * the staged untrusted skill bytes. "Retain the results" must not quietly become
   * "retain everything", or every default run leaves an executable copy of the
   * subject in OS tmp.
   */
  it('leaves results/ on disk after a DEFAULT run (no --out, no --workdir, no --keep)', async () => {
    // Distinct from SKILL_NAME: the harness root is derived from the subject name
    // into the shared OS temp dir, so a name reused by another test would have the
    // two runs fighting over one directory (and one lockfile).
    const subject = 'default-run-retention-skill';
    const { subjectDir } = writePluginFixture(subject);
    const fake = makeHarnessFakeSpawn({});

    const result = await runSkillTestHarness(defaultRunOpts(subjectDir, fake.spawn, subject));
    try {
      expect(result.exitCode, result.summary).toBe(0);

      // Reported, not derived — the operator is handed this path, and it has to be
      // the one that survived.
      expect(result.resultsPath, 'the run did not report where its artifacts went').toBeDefined();
      const resultsDir = result.resultsPath ?? '';

      for (const artifact of [BASELINE_JSON, 'grading.json', 'friction.json', 'tool-eval.json']) {
        expect(
          existsSync(safePath.join(resultsDir, artifact)),
          `${artifact} did not survive the default run's own cleanup`,
        ).toBe(true);
      }

      // baseline.json is not merely present — it still parses and still carries the
      // block the three prior rounds exist to make trustworthy.
      expect(readBaselineIntegrity(resultsDir).contaminated).toBe(false);

      // …and nothing else did. The staged subject tree is what cleanup is FOR.
      expect(readdirSync(result.harnessPath)).toEqual([RETAINED_RESULTS_DIRNAME]);
    } finally {
      // This harness root is in the machine's real temp dir, not the suite's
      // per-test dir, so the suite has to reap what it deliberately made survive.
      rmSync(result.harnessPath, { recursive: true, force: true });
    }
  });
});
