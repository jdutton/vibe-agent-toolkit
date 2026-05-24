/**
 * Unit tests for the (entry × prompt × attempt × target) run-matrix loop.
 *
 * These tests drive the contract:
 *  - scripted drivers iterate full N attempts per prompt
 *  - manual drivers short-circuit to N=1 regardless of repeatN
 *  - install-failure on attempt 0 fills remaining attempts as install-failed
 *    without further `invoke` calls for the same (skill, prompt, target) cell
 *
 * The fake driver isolates the loop from real claude-code / manual driver
 * behavior; per-attempt profile isolation is verified separately in the
 * claude-code driver tests.
 */

import type * as ChildProcessModule from 'node:child_process';
import { mkdtempSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { runMatrix } from '../../src/compat-empirical/run/run-matrix.js';
import { ClaudeCodeDriver } from '../../src/compat-empirical/runtimes/claude-code.js';
import * as tempProfile from '../../src/compat-empirical/runtimes/shared/temp-profile.js';
import type * as TempProfileModule from '../../src/compat-empirical/runtimes/shared/temp-profile.js';
import type {
  CorpusEntry,
  DriverMode,
  ExitStatus,
  RuntimeObservation,
  Target,
  TriggerPrompt,
} from '../../src/compat-empirical/types.js';

const FAKE_TRANSCRIPT_DIR = safePath.join(normalizedTmpdir(), 'vat-run-loop-test-transcripts');
const FAKE_TRANSCRIPT_LOG = safePath.join(normalizedTmpdir(), 'vat-run-loop-fake.log');
const SKILL_A = 'skill-a';
const TARGET_CLAUDE_CODE: Target = 'claude-code';
const PROMPT_POS_1 = 'pos-1';
const PROMPT_NEG_1 = 'neg-1';

interface FakeDriver {
  target: Target;
  driverMode: DriverMode;
  setup: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
}

interface InvokeArgs {
  skillId: string;
  promptId: string;
  attemptIdx: number;
}

function buildFakeObservation(args: InvokeArgs, target: Target): RuntimeObservation {
  const exitStatus: ExitStatus = 'completed';
  return {
    skillId: args.skillId,
    target,
    startedAt: new Date().toISOString(),
    durationMs: 1,
    exitStatus,
    invocationDetected: true,
    outputText: 'fake',
    toolUseEvents: [],
    errors: [],
    installResult: { ok: true, notes: 'ok' },
    transcriptPath: FAKE_TRANSCRIPT_LOG,
    driverMode: 'scripted',
    promptId: args.promptId,
    attemptIdx: args.attemptIdx,
  };
}

function makeFakeDriver(target: Target, mode: DriverMode = 'scripted'): FakeDriver {
  return {
    target,
    driverMode: mode,
    setup: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue({ ok: true, notes: 'ok' }),
    invoke: vi.fn(async (invokeOpts: InvokeArgs) => buildFakeObservation(invokeOpts, target)),
  };
}

function makeEntry(): CorpusEntry {
  return {
    id: SKILL_A,
    bucket: 'own',
    source: { kind: 'local', path: '/fake' },
    skillRelPath: 'SKILL.md',
    expectedCapabilities: [],
    triggerPromptRefs: [PROMPT_POS_1, PROMPT_NEG_1],
  };
}

function makePromptMap(): Map<string, TriggerPrompt> {
  return new Map<string, TriggerPrompt>([
    [
      PROMPT_POS_1,
      {
        id: PROMPT_POS_1,
        forSkillId: SKILL_A,
        prompt: 'p1',
        expectedBehavior: { description: 'd', invocationSignals: [] },
        authoring: 'hand',
        kind: 'positive',
      },
    ],
    [
      PROMPT_NEG_1,
      {
        id: PROMPT_NEG_1,
        forSkillId: SKILL_A,
        prompt: 'p2',
        expectedBehavior: { description: 'd', invocationSignals: [] },
        authoring: 'hand',
        kind: 'negative',
      },
    ],
  ]);
}

function fakeStage(): { entryId: string; rootDir: string; skillPath: string } {
  return { entryId: SKILL_A, rootDir: '/fake', skillPath: '/fake/SKILL.md' };
}

/**
 * Wire up the standard single-entry / two-prompt matrix against the given
 * driver and run it. Extracted so each test reads as "configure driver, run,
 * assert" without duplicating the matrix-construction boilerplate.
 */
async function runWithDriver(driver: FakeDriver, repeatN: number): Promise<RuntimeObservation[]> {
  return runMatrix({
    entries: [makeEntry()],
    promptById: makePromptMap(),
    drivers: new Map([[driver.target, driver]]),
    repeatN,
    transcriptsDir: FAKE_TRANSCRIPT_DIR,
    stageFn: fakeStage,
  });
}

describe('runMatrix iteration', () => {
  it('runs entries × prompts × N attempts for scripted drivers', async () => {
    const driver = makeFakeDriver(TARGET_CLAUDE_CODE);
    const observations = await runWithDriver(driver, 3);

    // 1 entry × 2 prompts × 3 attempts × 1 target = 6 observations
    expect(observations).toHaveLength(6);
    expect(driver.invoke).toHaveBeenCalledTimes(6);

    const promptIds = observations.map((o) => o.promptId);
    expect(promptIds.filter((p) => p === PROMPT_POS_1)).toHaveLength(3);
    expect(promptIds.filter((p) => p === PROMPT_NEG_1)).toHaveLength(3);

    const attemptIndexes = new Set(observations.map((o) => o.attemptIdx));
    expect(attemptIndexes).toEqual(new Set([0, 1, 2]));
    expect(observations.every((o) => [0, 1, 2].includes(o.attemptIdx))).toBe(true);
  });

  it('manual drivers short-circuit to N=1 regardless of repeatN', async () => {
    const driver = makeFakeDriver('claude-chat', 'manual');
    const observations = await runWithDriver(driver, 3);

    // 1 entry × 2 prompts × 1 attempt (short-circuited) × 1 target = 2
    expect(observations).toHaveLength(2);
    expect(driver.invoke).toHaveBeenCalledTimes(2);
    expect(observations.every((o) => o.attemptIdx === 0)).toBe(true);
  });

  it('install-failure for attempt 0 fills remaining slots with install-failed observations', async () => {
    const driver = makeFakeDriver(TARGET_CLAUDE_CODE);
    // Fail install for the very first call (pos-1, attempt 0).
    // Attempts 1 and 2 for pos-1 short-circuit; install is never re-checked.
    // neg-1 then proceeds normally for all 3 attempts.
    driver.install.mockResolvedValueOnce({ ok: false, notes: 'bundle missing' });

    const observations = await runWithDriver(driver, 3);

    expect(observations).toHaveLength(6);

    const pos1 = observations.filter((o) => o.promptId === PROMPT_POS_1);
    expect(pos1).toHaveLength(3);
    expect(pos1.every((o) => o.exitStatus === 'error')).toBe(true);
    expect(pos1.every((o) => o.errors[0]?.startsWith('install failed'))).toBe(true);
    expect(pos1.every((o) => !o.installResult.ok)).toBe(true);
    expect(pos1.every((o) => o.installResult.notes === 'bundle missing')).toBe(true);

    const pos1Attempts = pos1.map((o) => o.attemptIdx).sort((a, b) => a - b);
    expect(pos1Attempts).toEqual([0, 1, 2]);

    // invoke was called for neg-1's 3 attempts but never for pos-1.
    expect(driver.invoke).toHaveBeenCalledTimes(3);
    const invokedPromptIds = driver.invoke.mock.calls.map(
      (call) => (call[0] as InvokeArgs).promptId,
    );
    expect(invokedPromptIds.every((p) => p === PROMPT_NEG_1)).toBe(true);
  });

  it('emits one observation per (entry, prompt, attempt, target) iteration with correct ids', async () => {
    const driver = makeFakeDriver(TARGET_CLAUDE_CODE);
    const observations = await runWithDriver(driver, 2);

    // Verify uniqueness of (skillId, promptId, attemptIdx, target) tuples.
    const tuples = observations.map(
      (o) => `${o.skillId}|${o.promptId}|${o.attemptIdx}|${o.target}`,
    );
    expect(new Set(tuples).size).toBe(tuples.length);
    expect(tuples).toHaveLength(4);
  });

  it('extends to N=5 when first 3 attempts are ambiguous', async () => {
    // Per-prompt attempt counter; attempt 2 of each prompt produces a
    // not-invoked observation, so criterion #1 (mixed trigger outcomes)
    // fires and the loop runs 2 more attempts (indices 3 and 4).
    const attemptsByPrompt = new Map<string, number>();
    const driver = makeFakeDriver(TARGET_CLAUDE_CODE);
    driver.invoke.mockImplementation(async (invokeOpts: InvokeArgs) => {
      const seenBefore = attemptsByPrompt.get(invokeOpts.promptId) ?? 0;
      attemptsByPrompt.set(invokeOpts.promptId, seenBefore + 1);
      const invoked = invokeOpts.attemptIdx !== 2;
      return {
        ...buildFakeObservation(invokeOpts, TARGET_CLAUDE_CODE),
        invocationDetected: invoked,
        outputText: invoked ? 'fake' : 'agent ignored the skill',
      };
    });

    const observations = await runWithDriver(driver, 3);

    // Both pos-1 and neg-1 should extend (each has attempt 2 not-invoked).
    const pos1 = observations.filter((o) => o.promptId === PROMPT_POS_1);
    const neg1 = observations.filter((o) => o.promptId === PROMPT_NEG_1);
    expect(pos1).toHaveLength(5);
    expect(neg1).toHaveLength(5);

    const pos1AttemptIdxs = pos1.map((o) => o.attemptIdx).sort((a, b) => a - b);
    expect(pos1AttemptIdxs).toEqual([0, 1, 2, 3, 4]);
    const neg1AttemptIdxs = neg1.map((o) => o.attemptIdx).sort((a, b) => a - b);
    expect(neg1AttemptIdxs).toEqual([0, 1, 2, 3, 4]);

    // invoke was called 5 times per prompt × 2 prompts = 10 total.
    expect(driver.invoke).toHaveBeenCalledTimes(10);
  });
});

/**
 * Per-attempt independence test for the claude-code driver. The load-bearing
 * invariant: two consecutive invoke() calls must operate on different homeDir
 * paths, otherwise prior session/cache state contaminates the next attempt and
 * the harness silently masks runtime variance.
 *
 * We don't depend on `claude` being on PATH — both `setup()` (CLI check) and
 * the spawn are bypassed via module mocks so the test exercises only the
 * profile lifecycle.
 */

// Shared mutable state used inside the vi.mock factories. Hoisted via
// vi.hoisted() so the factories — which are themselves hoisted — can capture
// it safely (vi.mock's factory runs before any top-level `const` is bound).
// FAKE_HOME_PREFIX has to be hoisted for the same reason (factories read it
// at hoist time, before module-scope `const`s are initialized).
// FAKE_HOME_PREFIX is a synthetic string used only to assert identity-by-path
// inside the spawn mock — it is never written to or read from disk, so the
// "publicly-writable-directories" guidance for `/tmp/...` is N/A here.
const { spawnedHomes, FAKE_HOME_PREFIX } = vi.hoisted(() => ({
  spawnedHomes: [] as string[],
  FAKE_HOME_PREFIX: '<fake-home>/',
}));

vi.mock('../../src/compat-empirical/runtimes/shared/temp-profile.js', async () => {
  const actual = await vi.importActual<typeof TempProfileModule>(
    '../../src/compat-empirical/runtimes/shared/temp-profile.js',
  );
  let counter = 0;
  return {
    ...actual,
    createTempProfile: vi.fn(() => {
      counter += 1;
      const homeDir = `${FAKE_HOME_PREFIX}${counter}`;
      return { homeDir, claudeDir: `${homeDir}/.claude`, skillsDir: `${homeDir}/.claude/skills` };
    }),
    installSkillIntoProfile: vi.fn(() => `${FAKE_HOME_PREFIX}skill-install`),
    teardownTempProfile: vi.fn(),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn((_cmd: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawnedHomes.push(options.env['HOME'] ?? '');
      const noopStream = { on: (_e: string, _l: () => void): void => undefined };
      let closeListener: ((code: number) => void) | undefined;
      const child = {
        stdout: noopStream,
        stderr: noopStream,
        kill: (): void => undefined,
        on(event: string, listener: (code: number) => void): typeof child {
          if (event === 'close') {
            closeListener = listener;
            queueMicrotask(() => closeListener?.(0));
          }
          return child;
        },
      };
      return child as never;
    }),
  };
});

describe('ClaudeCodeDriver per-attempt independence', () => {
  it('recreates the temp profile on each invoke (different homeDir per attempt)', async () => {
    const transcriptDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-claude-code-invoke-test-'));

    spawnedHomes.length = 0;
    (tempProfile.createTempProfile as ReturnType<typeof vi.fn>).mockClear();
    (tempProfile.teardownTempProfile as ReturnType<typeof vi.fn>).mockClear();

    const driver = new ClaudeCodeDriver();
    const fakeSkill = { entryId: SKILL_A, rootDir: '/fake', skillPath: '/fake/SKILL.md' };

    const baseOpts = {
      skillId: SKILL_A,
      promptId: PROMPT_POS_1,
      triggerPrompt: 'do the thing',
      expected: { description: 'd', invocationSignals: [] },
      transcriptDir,
      skill: fakeSkill,
    };

    await driver.invoke({ ...baseOpts, attemptIdx: 0 });
    await driver.invoke({ ...baseOpts, attemptIdx: 1 });

    // createTempProfile + teardownTempProfile were each called twice — once per invoke.
    expect(tempProfile.createTempProfile).toHaveBeenCalledTimes(2);
    expect(tempProfile.teardownTempProfile).toHaveBeenCalledTimes(2);
    // Each invoke operated on a distinct homeDir.
    expect(spawnedHomes).toHaveLength(2);
    expect(spawnedHomes[0]).not.toBe(spawnedHomes[1]);
    expect(new Set(spawnedHomes).size).toBe(2);
  });
});
