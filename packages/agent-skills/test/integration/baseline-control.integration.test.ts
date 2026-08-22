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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { runSkillTestHarness, type RunHarnessOptions } from '../../src/skill-test/run-harness.js';
import { makeHarnessFakeSpawn } from '../skill-test/spawn-stub.js';
import { setupTempDir } from '../test-helpers.js';

vi.mock('../../src/skill-test/preflight.js', async (io) => (await import('../skill-test/preflight-stub.js')).passingPreflight(io));

const SKILL_NAME = 'control-skill';
const EVAL_ID = 'no-files-eval';
const SKILL_MD = `---\nname: ${SKILL_NAME}\ndescription: A fixture skill for the baseline control test.\n---\n\n# Control\n`;

const { getTempDir } = setupTempDir('vat-baseline-control-');

/**
 * A subject in PLUGIN layout — the shape the defect was reported against, and the
 * only shape for which `CLAUDE_PLUGIN_ROOT` is set at all. A standalone-skill
 * fixture would pass this test while the hole stayed wide open.
 */
function writePluginFixture(): { subjectDir: string; pluginRoot: string } {
  const pluginRoot = safePath.join(getTempDir(), 'src', 'my-plugin');
  const manifestDir = safePath.join(pluginRoot, '.claude-plugin');
  mkdirSyncReal(manifestDir, { recursive: true });
  writeFileSync(
    safePath.join(manifestDir, 'plugin.json'),
    JSON.stringify({ name: 'my-plugin', version: '1.0.0' }) + '\n',
    'utf8',
  );

  const subjectDir = safePath.join(pluginRoot, 'skills', SKILL_NAME);
  mkdirSyncReal(subjectDir, { recursive: true });
  writeFileSync(safePath.join(subjectDir, 'SKILL.md'), SKILL_MD, 'utf8');

  // An eval with NO input `files` — the case whose executor used to fall back to
  // running inside the staged subject dir.
  const evalsDir = safePath.join(subjectDir, 'evals');
  mkdirSyncReal(evalsDir, { recursive: true });
  writeFileSync(
    safePath.join(evalsDir, 'evals.json'),
    JSON.stringify({
      skill_name: SKILL_NAME,
      evals: [{ id: EVAL_ID, prompt: 'do the thing', expectations: ['it happened'] }],
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

/** Every string VAT hands one spawn: prompt, cwd, sandbox, plugin dirs, env values. */
function spawnSurface(opts: {
  prompt: string;
  cwd?: string;
  sandboxDir: string;
  pluginDirs: string[];
  env?: NodeJS.ProcessEnv;
}): string {
  const envValues = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${String(v)}`);
  return [opts.prompt, opts.cwd ?? '', opts.sandboxDir, ...opts.pluginDirs, ...envValues].join('\n');
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

    const harnessRoot = toForwardSlash(result.harnessPath);
    const surface = toForwardSlash(spawnSurface(control[0] as never));

    // The whole point, stated once: nothing VAT hands the control arm may lead to
    // the staged skill. Not the prompt, not argv, not cwd, not the environment.
    expect(surface, `control arm was handed the harness root:\n${surface}`).not.toContain(harnessRoot);

    // And specifically the channel the first fix missed.
    expect((control[0] as { env?: NodeJS.ProcessEnv }).env ?? {}).not.toHaveProperty('CLAUDE_PLUGIN_ROOT');

    // The treatment arm still gets everything it needs — otherwise "isolated" is
    // indistinguishable from "broken", and the A/B measures nothing.
    expect(toForwardSlash(spawnSurface(treatment[0] as never))).toContain(harnessRoot);
    expect((treatment[0] as { env?: NodeJS.ProcessEnv }).env ?? {}).toHaveProperty('CLAUDE_PLUGIN_ROOT');
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
    expect(toForwardSlash(controlCwd ?? '')).toContain(toForwardSlash(result.workspacesPath ?? '@none'));
    expect(toForwardSlash(controlCwd ?? '')).not.toContain(toForwardSlash(result.harnessPath));
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
      executorExtraStdout: (opts) =>
        opts.pluginDirs.length === 0
          ? JSON.stringify({
              type: 'assistant',
              message: {
                content: [{
                  type: 'tool_use',
                  name: 'Bash',
                  input: { command: `cat ../${harnessTail}/${SKILL_NAME}/SKILL.md` },
                }],
              },
            })
          : undefined,
    });

    const result = await runSkillTestHarness(baselineOpts(subjectDir, fake.spawn));
    expect(result.exitCode, result.summary).toBe(0);

    const baselinePath = safePath.join(getTempDir(), 'harness', 'results', 'baseline.json');
    expect(existsSync(baselinePath), 'baseline.json was never written').toBe(true);
    const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      baselineIntegrity?: { contaminated?: boolean; findings?: Array<{ evalId?: string }> };
    };

    expect(parsed.baselineIntegrity, 'baselineIntegrity block missing').toBeDefined();
    expect(parsed.baselineIntegrity?.contaminated).toBe(true);
    expect(parsed.baselineIntegrity?.findings?.[0]?.evalId).toBe(EVAL_ID);
  });

  // The block is unconditional: its ABSENCE must mean "this file predates the
  // check", never "checked and clean". Only an always-written field carries that.
  it('stamps a clean verdict into baseline.json when the control arm behaves', async () => {
    const { subjectDir } = writePluginFixture();
    const fake = makeHarnessFakeSpawn({});

    const result = await runSkillTestHarness(baselineOpts(subjectDir, fake.spawn));
    expect(result.exitCode, result.summary).toBe(0);

    const parsed = JSON.parse(
      readFileSync(safePath.join(getTempDir(), 'harness', 'results', 'baseline.json'), 'utf8'),
    ) as { baselineIntegrity?: { contaminated?: boolean; findings?: unknown[] } };

    expect(parsed.baselineIntegrity?.contaminated).toBe(false);
    expect(parsed.baselineIntegrity?.findings).toEqual([]);
  });
});
