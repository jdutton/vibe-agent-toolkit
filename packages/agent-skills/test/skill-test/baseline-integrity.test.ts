import { describe, expect, it } from 'vitest';

import {
  type BaselineContaminationScan,
  activeContaminationSignals,
  armExpectationSkew,
  BaselineIntegritySchema,
  detectBaselineContamination,
  harnessNeedles,
  siblingArmNeedles,
  vatPrivateDirNeedles,
  type BaselineContaminationHit,
  type ContaminationSignal,
  type DetectBaselineContaminationInput,
  scrubControlArmEnv,
  skillContentNeedles,
  summarizeBaselineIntegrity,
  type ArmEvalGrade,
  type BaselineContamination,
  type BaselineIntegrity,
  type SummarizeBaselineIntegrityInput,
} from '../../src/skill-test/baseline-integrity.js';
import { resolveHarnessRoot } from '../../src/skill-test/harness-location.js';
import { resolveHarnessLocation } from '../../src/skill-test/run-harness.js';

// Synthetic paths used only as string needles for the detector — nothing is read
// or written here, so the publicly-writable-directory concern does not apply.
/* eslint-disable sonarjs/publicly-writable-directories -- inert test literals; the detector never touches the filesystem */
const TMP_DIR = '/tmp';
const HARNESS_DIR = '/tmp/vat-skill-test';
const HARNESS_ROOT = '/tmp/vat-skill-test/my-skill-abc12345';
const WS_ROOT = '/tmp/vat-skill-test-ws-abc';
/** vat's private tmp dirs: the held answer key, and the grader's nonce dir. */
const HOLD_DIR = '/tmp/vat-skill-evals-1111aaaa2222bbbb';
const GRADER_DIR = '/tmp/vat-skill-grade-3333cccc4444dddd';
/* eslint-enable sonarjs/publicly-writable-directories */
/** The treatment arm's live working directory, one `ls ..` from the control's. */
const SIBLING_ARM = `${WS_ROOT}/1111aaaa2222bbbb`;
const BUNDLE_NAME = 'bucket-map';
/** The directory name vat puts every harness root under — needle 3. */
const VAT_HARNESS_DIR_NAME = 'vat-skill-test';
const EXCERPT_ELLIPSIS = '…';
/**
 * How a FULL absolute needle comes back in `hit.match`: leading segments dropped,
 * marked with `…/`. The drop is a privacy rule — the untruncated root is
 * `C:/Users/<username>/AppData/…` on Windows and `/Users/<name>/…` under an `--out`
 * into a checkout, and `match` is the short opaque-looking field people paste into
 * bug reports.
 *
 * The marker is also what still tells the two spellings apart, which several tests
 * below depend on: a match on the FULL-root needle reports `…/a/b`, while a match
 * on the two-segment SUFFIX needle reports a bare `a/b`. Written out rather than
 * computed from the production helper, so these stay assertions and not tautologies.
 */
const REDACTED = '…/';
const KIND_HARNESS_PATH = 'harness-path' as const;
const KIND_DECLARED_EXECUTABLE = 'declared-executable' as const;
const KIND_SIBLING_ARM = 'sibling-arm' as const;
const KIND_VAT_PRIVATE_DIR = 'vat-private-dir' as const;
const KIND_SKILL_CONTENT = 'skill-content' as const;
const REASON_CWD_UNTRACKED = 'cwd-untracked' as const;
const REASON_UNPARSED = 'transcript-unparsed' as const;
/** A scratch file in the arm's own cwd — the innocuous read every session makes. */
const OWN_NOTES = 'cat notes.md';
const ALL_SIGNALS: ContaminationSignal[] = [
  KIND_HARNESS_PATH,
  KIND_SIBLING_ARM,
  KIND_VAT_PRIVATE_DIR,
  KIND_SKILL_CONTENT,
  KIND_DECLARED_EXECUTABLE,
];
// A workspaces-root path: under the tmp root like the real one, but deliberately
// NOT under HARNESS_ROOT — the control arm must keep its own fixtures.
const WS_FIXTURES = `${WS_ROOT}/eval-1/fixtures`;
// The control arm's own workspace ROOT — a sibling of the treatment's under the
// workspaces root, never under HARNESS_ROOT.
const ARM_WORKSPACE = `${WS_ROOT}/7f2a91c4`;
// ...and where the executor is ACTUALLY spawned: one level deeper, in the eval's
// own directory. The two are one directory apart and that level decides every
// relative reach — `../../..` from here is the OS temp dir (where vat's harness
// root and private dirs are siblings of the arm), while from the arm ROOT the same
// climb overshoots and lands where no needle can see it.
const ARM_CWD = `${ARM_WORKSPACE}/lookup-1`;
/** The relative climb from ARM_CWD to the OS temp dir the arm's tree sits under. */
const UP_TO_TMP = '../../..';

/* ────────────────────── transcript builders ────────────────────── */

/** The stream-json events that bracket every session these builders emit. */
const INIT_EVENT = '{"type":"system","subtype":"init"}';
const RESULT_EVENT = '{"type":"result","subtype":"success"}';
/** The shared title for every table row asserting a clean verdict. */
const STAYS_CLEAN = 'stays clean: %s';
/** A relative read the arm makes wherever its cwd happens to be. */
const READ_SKILL_MD = 'cat SKILL.md';
/** A relative read that only resolves into the harness from `<tmp>/vat-skill-test`. */
const REACH_FROM_HARNESS_DIR = 'cat my-skill-abc12345/staged/s/SKILL.md';
/** ...and the one that only resolves from the harness ROOT. */
const REACH_FROM_HARNESS_ROOT = 'cat staged/s/SKILL.md';

let toolCallSeq = 0;

/**
 * Bash calls attributed to an agent CONTEXT — `null` is the main agent, any other
 * value is a Task subagent's tool-use id. The cwd of one must not move the other.
 */
function agentSession(...steps: ReadonlyArray<readonly [parent: string | null, command: string]>): string {
  const lines = [INIT_EVENT];
  for (const [parent, command] of steps) {
    toolCallSeq += 1;
    lines.push(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { content: [{ type: 'tool_use', id: `toolu_${toolCallSeq}`, name: 'Bash', input: { command } }] },
    }));
  }
  lines.push(RESULT_EVENT);
  return lines.join('\n');
}

function bashEvent(command: string): string {
  toolCallSeq += 1;
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `toolu_${toolCallSeq}`, name: 'Bash', input: { command } }] },
  });
}

function toolResultEvent(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${toolCallSeq}`, content: text }] },
  });
}

/** One Bash call, or a Bash call paired with the output it got back. */
type BashStep = string | readonly [command: string, output: string];

/**
 * A session of Bash calls IN ORDER. The Bash tool keeps its working directory
 * across calls, and this builder is what lets a test say so — the defect that
 * forced this module's redesign is only visible across two calls.
 */
function bashSession(...steps: readonly BashStep[]): string {
  const lines = [INIT_EVENT];
  for (const step of steps) {
    const command = typeof step === 'string' ? step : step[0];
    lines.push(bashEvent(command));
    if (typeof step !== 'string') lines.push(toolResultEvent(step[1]));
  }
  lines.push(RESULT_EVENT);
  return lines.join('\n');
}

/** One Bash tool call carrying `command`. */
function transcriptWith(command: string): string {
  return bashSession(command);
}

/** One non-Bash tool call — `Read`, `Glob`, and friends. */
function toolTranscript(name: string, input: unknown): string {
  toolCallSeq += 1;
  return [
    INIT_EVENT,
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: `toolu_${toolCallSeq}`, name, input }] },
    }),
    RESULT_EVENT,
  ].join('\n');
}

/* ────────────────────── detector helpers ────────────────────── */

/**
 * Hits from a STRUCTURED scan.
 *
 * Every test that goes through here asserts the scan did NOT degrade, which is
 * the load-bearing half: a degraded scan silently falls back to the flat text
 * match this redesign replaced, so without this assertion a test could pass for
 * the old reason and nobody would know. Degradation gets its own describe block.
 */
function scanHits(input: DetectBaselineContaminationInput): BaselineContaminationHit[] {
  const scan = detectBaselineContamination({ armWorkspaceDir: ARM_WORKSPACE, armCwd: ARM_CWD, ...input });
  expect(scan.degraded, `scan degraded (${scan.degraded?.detail ?? ''}) — it never reached the structured path`)
    .toBeUndefined();
  return scan.hits;
}

describe('detectBaselineContamination', () => {
  it('returns no hits for a clean skill-absent transcript', () => {
    expect(scanHits({ transcript: transcriptWith('ls -la && cat README.md'), harnessRoot: HARNESS_ROOT })).toEqual([]);
  });

  // The signal that matters: the control arm reached into vat's own staged trees.
  // Nothing points it there any more, so a mention means it went looking.
  it('flags a transcript that names a path under the harness root', () => {
    const hits = scanHits({
      transcript: transcriptWith(`node ${HARNESS_ROOT}/staged/my-skill/scripts/bundle.mjs lookup`),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
    expect(hits[0]?.match).toBe(`${REDACTED}vat-skill-test/my-skill-abc12345`);
    expect(hits[0]?.excerpt).toContain('bundle.mjs');
  });

  // The case vat cannot prevent: an ambient copy in the adopter's own repo or
  // plugin cache. No harness path appears, but the declared executable does.
  //
  // The path is ABSOLUTE, and that is the realistic spelling as well as the
  // load-bearing one. This case used to be written `node ./dist/skills/…`, which
  // predates per-arm workspaces: the arm's cwd is now a staged tree under OS tmp,
  // so a relative `./dist/…` names something in the arm's own scratch space, not
  // the adopter's build output.
  it('flags a declared executable run from a path vat does not own', () => {
    const hits = scanHits({
      transcript: transcriptWith('node /users/dev/myrepo/dist/skills/my-skill/scripts/bucket-map.mjs "source"'),
      harnessRoot: HARNESS_ROOT,
      executableNames: [BUNDLE_NAME],
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_DECLARED_EXECUTABLE);
    expect(hits[0]?.match).toBe(BUNDLE_NAME);
  });

  it('does not double-count one reach as both a harness path and an executable', () => {
    const hits = scanHits({
      transcript: transcriptWith(`node ${HARNESS_ROOT}/staged/s/scripts/bucket-map.mjs x`),
      harnessRoot: HARNESS_ROOT,
      executableNames: [BUNDLE_NAME],
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });

  // A 1-2 char name occurs constantly in ordinary JSON and prose; matching it
  // would fire on every run and train the operator to ignore the warning.
  it('skips executable names too short to be a real signal', () => {
    expect(
      scanHits({
        transcript: transcriptWith('echo "a b c" | wc -l'),
        harnessRoot: HARNESS_ROOT,
        executableNames: ['wc', 'a'],
      }),
    ).toEqual([]);
  });

  it('bounds the excerpt so a huge tool result cannot bloat baseline.json', () => {
    const hits = scanHits({
      transcript: transcriptWith(`${'x'.repeat(50_000)} ${HARNESS_ROOT} ${'y'.repeat(50_000)}`),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.excerpt.length ?? 0).toBeLessThan(HARNESS_ROOT.length + 200);
    expect(hits[0]?.excerpt.length ?? 0).toBeGreaterThan(0);
  });
});

/**
 * DEFECT (a): the Bash tool KEEPS ITS CWD ACROSS CALLS, so a `cd` in one call
 * governs every later one. The flat scan could not see that, and its bare-name
 * needle required a leading `/` that a post-`cd` relative path never has — so the
 * chain below, which ends with the control arm EXECUTING the skill's own bundled
 * script, read `contaminated: false` with all four signals reported "armed".
 *
 * The one-shot `cd ../../vat-skill-test` the old rule was justified against DOES
 * keep its slash. The two-step chain is the natural exploration order and was in
 * none of the 99 tests.
 */
describe('detectBaselineContamination — the cwd is carried across calls', () => {
  const HARNESS = '/tmp/vat-skill-test/my-skill-1a2b3c4d'; // eslint-disable-line sonarjs/publicly-writable-directories -- inert literal

  it('follows a multi-call cd chain into the harness and flags the reach', () => {
    const transcript = bashSession(
      [`cd ${UP_TO_TMP} && ls`, 'vat-skill-test  vat-skill-test-ws-abc'],
      ['cd vat-skill-test && ls', 'my-skill-1a2b3c4d'],
      ['cd my-skill-1a2b3c4d && ls staged', 'my-skill'],
      ['cat staged/my-skill/SKILL.md', '# my skill'],
      ['python3 staged/my-skill/scripts/csvsum.py ../data.csv', 'rows=3 total=42'],
    );
    const hits = scanHits({ transcript, harnessRoot: HARNESS, executableNames: ['csvsum'] });

    expect(hits.map((h) => h.kind), 'the cd chain read clean').toContain(KIND_HARNESS_PATH);
    // Not merely "a hit": the FULL-root needle, which only a correct three-step cwd
    // walk can reconstruct — no single command in this transcript spells it. The
    // `…/` marker is what says the full needle matched rather than the two-segment
    // suffix one; the segments themselves are dropped for privacy, not for brevity.
    expect(hits[0]?.match).toBe(`${REDACTED}vat-skill-test/my-skill-1a2b3c4d`);
    expect(transcript).not.toContain(HARNESS);
  });

  // Each `cd` in a `&&` chain governs the next command in the SAME call, not just
  // the next call. Both directions of carrying have to work.
  it('applies a cd to the rest of its own command line', () => {
    const hits = scanHits({
      transcript: transcriptWith(`cd ${UP_TO_TMP}/vat-skill-test && cat my-skill-abc12345/staged/s/SKILL.md`),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.match).toBe(`${REDACTED}vat-skill-test/my-skill-abc12345`);
  });

  // Navigating INTO vat's staged tree is not orientation, whatever the arm does
  // once it is there — so the `cd` target is itself a reach.
  it('flags a cd into the harness even when nothing is read afterwards', () => {
    const hits = scanHits({
      transcript: bashSession(`cd ${UP_TO_TMP}`, 'cd vat-skill-test'),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });

  // ...while a cd chain that stays inside the arm's own tree is just working.
  it('does not fire on a cd chain that never leaves the arm workspace', () => {
    expect(
      scanHits({
        transcript: bashSession('cd ..', 'ls', 'cd lookup-1 && cat data.csv'),
        harnessRoot: HARNESS_ROOT,
      }),
    ).toEqual([]);
  });
});

/**
 * DEFECT (b): anything that PRINTS a path supplies the leading slash a bare-name
 * needle wanted, so ordinary orientation was convicted. `find ../../..` produced
 * two `vat-private-dir` hits — the verdict reserved for "reached the held answer
 * key" — and a `find` for the fixture the arm was TOLD to work on stamped
 * `sibling-arm`. Nothing was opened in any of them.
 *
 * The fix is structural: a needle is matched against the resolved paths a tool
 * call names in its INPUT, never against what the call PRINTED.
 */
describe('detectBaselineContamination — a listing is not a reach', () => {

  const TEMP_LISTING = `${HARNESS_DIR}\n${HOLD_DIR}\n${GRADER_DIR}\n${WS_ROOT}\n`;
  const orientation: ReadonlyArray<readonly [string, string, string]> = [
    [
      'find one level up prints every vat dir in the temp root',
      `find ${UP_TO_TMP} -maxdepth 1 -type d`,
      TEMP_LISTING,
    ],
    [
      'find hunting the fixture it was told to work on prints the other arm',
      'find /private/var/folders -name data.csv',
      `${SIBLING_ARM}/lookup-1/fixtures/data.csv\n${ARM_CWD}/fixtures/data.csv\n`,
    ],
    [
      'ls of the temp dir prints every sibling as a full path',
      `ls -d ${TMP_DIR}/*`,
      TEMP_LISTING,
    ],
    [
      'a recursive listing prints paths under the harness',
      `ls -R ${WS_ROOT}`,
      `${HARNESS_ROOT}/staged/s/SKILL.md\n`,
    ],
  ];

  it.each(orientation)(STAYS_CLEAN, (_label, command, output) => {
    // Guard against a vacuous row: the OUTPUT must really carry something a needle
    // would match, or the row proves nothing about where we stopped looking.
    expect(
      detectBaselineContamination({
        transcript: transcriptWith(output),
        harnessRoot: HARNESS_ROOT,
        siblingArmDir: SIBLING_ARM,
        vatPrivateDirs: [HOLD_DIR, GRADER_DIR],
        armWorkspaceDir: ARM_WORKSPACE,
        armCwd: ARM_CWD,
      }).hits,
      'row is vacuous: this output matches no needle even when treated as input',
    ).not.toEqual([]);

    expect(
      scanHits({
        transcript: bashSession([command, output]),
        harnessRoot: HARNESS_ROOT,
        siblingArmDir: SIBLING_ARM,
        vatPrivateDirs: [HOLD_DIR, GRADER_DIR],
      }),
      `orientation convicted: ${command}`,
    ).toEqual([]);
  });

  // ...but an enumeration whose SEARCH ROOT is vat's staged tree is a reach: the
  // arm chose that directory, which it could only do by going looking.
  it('still fires when the enumeration is AIMED at the harness', () => {
    const hits = scanHits({
      transcript: bashSession([`find ${UP_TO_TMP}/vat-skill-test -name SKILL.md`, 'nothing found']),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });

  // A tool RESULT is where a declared executable's own output lands, and the
  // arm's own script may legitimately be named the same thing.
  it('does not read an executable name out of tool output', () => {
    expect(
      scanHits({
        transcript: bashSession(['ls /users/dev/myrepo/dist/skills', 'scripts/summary.mjs\n']),
        harnessRoot: HARNESS_ROOT,
        executableNames: ['summary'],
      }),
    ).toEqual([]);
  });

  // Looking at a file is not running it. The executable signal's claim is "the arm
  // RAN the skill's tool", so only a retrieval-intent call can support it.
  it('does not fire the executable signal on an enumeration of the same path', () => {
    const path = '/users/dev/myrepo/dist/skills/s/scripts/summary.mjs';
    expect(
      scanHits({ transcript: transcriptWith(`ls -l ${path}`), harnessRoot: HARNESS_ROOT, executableNames: ['summary'] }),
      'listing a path was reported as running it',
    ).toEqual([]);
    expect(
      scanHits({ transcript: transcriptWith(`node ${path}`), harnessRoot: HARNESS_ROOT, executableNames: ['summary'] }),
      'running the same path was NOT reported',
    ).toHaveLength(1);
  });
});

/**
 * The scan is only as good as its two prerequisites — parseable stream-json and a
 * cwd it can follow. When either is missing it falls back to the flat text match
 * this module used to be, and it must SAY SO: `contaminated: false` from a
 * degraded scan is written with exactly the same bytes as one from a scan that
 * actually looked.
 */
describe('detectBaselineContamination — degraded scans', () => {
  it('degrades, and still scans, when the transcript is not stream-json', () => {
    const scan = detectBaselineContamination({
      transcript: `the executor wrote plain text and mentioned ${HARNESS_ROOT}/staged/s/SKILL.md`,
      harnessRoot: HARNESS_ROOT,
      armWorkspaceDir: ARM_WORKSPACE,
      armCwd: ARM_CWD,
    });

    expect(scan.degraded?.reason).toBe(REASON_UNPARSED);
    expect(scan.hits, 'a degraded scan must still be a scan').toHaveLength(1);
  });

  it('degrades when no arm workspace was threaded through, so nothing anchors a relative path', () => {
    const scan = detectBaselineContamination({
      transcript: transcriptWith('cat ../../x/SKILL.md'),
      harnessRoot: HARNESS_ROOT,
    });

    expect(scan.degraded?.reason).toBe('cwd-unknown');
  });

  it('degrades on a cd it cannot evaluate, rather than trusting a cwd it knows is wrong', () => {
    const scan = detectBaselineContamination({
      transcript: bashSession('cd "$SKILL_HOME"', READ_SKILL_MD),
      harnessRoot: HARNESS_ROOT,
      armWorkspaceDir: ARM_WORKSPACE,
      armCwd: ARM_CWD,
    });

    expect(scan.degraded?.reason).toBe(REASON_CWD_UNTRACKED);
    expect(scan.degraded?.detail).toContain('$SKILL_HOME');
  });

  it.each([
    ['a bare cd, which goes home', 'cd'],
    ['cd -, which goes wherever it was before', 'cd -'],
    ['a backtick expansion', 'cd `cat where.txt`'],
  ])('degrades on %s', (_label, command) => {
    const scan = detectBaselineContamination({
      transcript: bashSession(command, READ_SKILL_MD),
      harnessRoot: HARNESS_ROOT,
      armWorkspaceDir: ARM_WORKSPACE,
      armCwd: ARM_CWD,
    });

    expect(scan.degraded?.reason, `"${command}" was treated as tracked`).toBe(REASON_CWD_UNTRACKED);
  });

  // The flat fallback's bare-name rule, which is the ONLY thing standing between a
  // directory LISTING and a contaminated verdict once the structured scan is out of
  // play. It has no consumer in the structured path (every resolved path is
  // absolute, so a bare-name needle always has its leading slash) — this is where
  // it earns its place.
  it('keeps the leading-boundary rule in the fallback, so a listing is not a verdict', () => {
    const scan = detectBaselineContamination({
      transcript: 'plain text, not stream-json\nvat-skill-test\nvat-skill-test-ws-abc\n',
      harnessRoot: HARNESS_ROOT,
    });

    expect(scan.degraded).toBeDefined();
    expect(scan.hits).toEqual([]);
  });

  // ...and the fallback still catches what it always caught.
  it('still finds an absolute reach in the fallback', () => {
    const scan = detectBaselineContamination({
      transcript: `not stream-json at all: cat ${HARNESS_ROOT}/staged/s/SKILL.md`,
      harnessRoot: HARNESS_ROOT,
    });

    expect(scan.hits).toHaveLength(1);
    expect(scan.hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });

  // The flat fallback's executable check keeps its own shape-inspecting predicate,
  // because there is no cwd to resolve against. Both directions, because the
  // predicate is the ONLY thing separating them once the structured scan is out of
  // play: a positive alone stays green with the predicate hard-wired to "escapes".
  it.each([
    ['a home-rooted reach into the plugin cache', 'python3 ~/.claude/plugins/acme/skills/s/summary.py', 1],
    ['the arm\'s own relative script', 'node ./scripts/summary.mjs input.csv', 0],
  ])('still judges an executable reach by path shape in the fallback: %s', (_label, command, expected) => {
    const scan = detectBaselineContamination({
      transcript: `not stream-json: ${command}`,
      harnessRoot: HARNESS_ROOT,
      executableNames: ['summary'],
      armWorkspaceDir: ARM_WORKSPACE,
    });

    expect(scan.degraded?.reason).toBe(REASON_UNPARSED);
    expect(scan.hits, `fallback misjudged: ${command}`).toHaveLength(expected);
  });
});

// These are the cases a hardcoded POSIX literal cannot reach. The original
// version of this file used '/tmp/vat-skill-test/...' as BOTH needle and
// haystack, so it behaved identically on all three OSes, never touched
// resolveHarnessRoot or JSON escaping, and passed on Windows CI while the
// detector could not fire there at all.
describe('detectBaselineContamination — real path forms', () => {
  it('fires on the harness root that resolveHarnessRoot actually produces', () => {
    const real = resolveHarnessRoot(['my-skill']);

    expect(
      scanHits({ transcript: transcriptWith(`cat ${real}/staged/my-skill/SKILL.md`), harnessRoot: real }),
    ).toHaveLength(1);
  });

  // Windows: safePath.join forward-slashes every path VAT derives, while the
  // child's command is backslashed — and stream-json ESCAPES those, so the raw
  // transcript holds doubled backslashes. A literal indexOf can never match, and
  // a tokenizer that treats every backslash as an escape eats the separators and
  // leaves `c:usersdev…`, which matches nothing either.
  it('fires on a Windows-shaped, JSON-escaped backslash path', () => {
    const harnessRoot = 'C:/Users/dev/AppData/Local/Temp/vat-skill-test/my-skill-1a2b3c4d';
    const native = String.raw`C:\Users\dev\AppData\Local\Temp\vat-skill-test\my-skill-1a2b3c4d\staged\s\SKILL.md`;
    const transcript = transcriptWith(`type ${native}`);

    expect(transcript).toContain(String.raw`\\`); // the escaping is really present
    expect(scanHits({ transcript, harnessRoot })).toHaveLength(1);
  });

  // macOS: VAT derives /private/var/... (realpath) but $TMPDIR — which IS on the
  // child env allowlist — hands the arm /var/..., so the arm reports the one
  // spelling the needle does not contain.
  it('fires when the arm reports the non-realpath $TMPDIR spelling', () => {
    const harnessRoot = '/private/var/folders/2k/abc/T/vat-skill-test/my-skill-830fad22';
    const transcript = transcriptWith('find /var/folders/2k/abc/T/vat-skill-test/my-skill-830fad22 -name SKILL.md');

    expect(scanHits({ transcript, harnessRoot })).toHaveLength(1);
  });

  it('fires on a relative reach that never names the absolute root', () => {
    const transcript = transcriptWith(`cat ${UP_TO_TMP}/vat-skill-test/my-skill-abc12345/staged/s/SKILL.md`);
    const hits = scanHits({ transcript, harnessRoot: HARNESS_ROOT });

    expect(transcript).not.toContain(HARNESS_ROOT);
    expect(hits).toHaveLength(1);
    // The FULL-root needle, reconstructed — proof the climb was resolved rather
    // than pattern-matched against the two-segment suffix needle, which would have
    // reported a BARE `vat-skill-test/my-skill-abc12345` with no `…/` in front.
    expect(hits[0]?.match).toBe(`${REDACTED}vat-skill-test/my-skill-abc12345`);
  });

  // A relative --out used to become the needle verbatim, so a two-character
  // string matched almost any transcript and every eval reported contaminated.
  it('does not fire on an unrelated transcript when --out was relative', () => {
    const { harnessRoot } = resolveHarnessLocation({ subject: 'demo', out: './out' });

    expect(harnessRoot.startsWith('/') || /^[A-Za-z]:/.test(harnessRoot)).toBe(true);
    expect(
      scanHits({ transcript: transcriptWith('echo "the output is ready" > ./notes.md'), harnessRoot }),
    ).toEqual([]);
  });

  // THE GLOB CLASS. Both the absolute and the two-segment suffix needle require
  // the arm to spell the 8-hex harness key, which it has no way to know and no
  // reason to type — every natural reach enumerates instead. One `*` defeated the
  // entire scheme, so a reach that lands squarely in the staged tree read clean.
  it.each([
    ['a glob', `cat ${UP_TO_TMP}/vat-skill-test/*/staged/s/SKILL.md`],
    ['a recursive glob', `cat ${UP_TO_TMP}/vat-skill-test/**/SKILL.md`],
    ['find', `find ${UP_TO_TMP}/vat-skill-test -name SKILL.md -exec cat {} +`],
    [
      'a shell variable',
      `K=$(ls ${UP_TO_TMP}/vat-skill-test); cat ${UP_TO_TMP}/vat-skill-test/$K/staged/s/SKILL.md`,
    ],
    ['$TMPDIR plus a glob', 'cat $TMPDIR/vat-skill-test/*/staged/s/SKILL.md'],
    ['a recursive listing', `ls -R ${UP_TO_TMP}/vat-skill-test`],
  ])('fires on a reach that never names the harness key: %s', (_label, command) => {
    const hits = scanHits({ transcript: transcriptWith(command), harnessRoot: HARNESS_ROOT });

    expect(hits, `read clean: ${command}`).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });

  // ...while the control arm's OWN cwd lives at vat-skill-test-ws-<token>, which
  // shares that prefix and must never be evidence against it. This is the
  // constraint the needle above is boundary-matched to preserve.
  it('does not fire on the control arm working in its own legitimate workspace', () => {
    const transcript = transcriptWith(
      'ls /private/var/folders/2k/abc/T/vat-skill-test-ws-9f3c1b/7f2a91c4/lookup-1 && cat data.csv',
    );

    expect(scanHits({ transcript, harnessRoot: HARNESS_ROOT })).toEqual([]);
  });

  // Absolutizing --out fixed only the two-character case. A short-but-absolute
  // --out still yielded a needle that matched mid-segment, so `/tmp/out` fired on
  // `/tmp/output.csv` — and the attached instruction is "discard the delta".
  // Every row must have a NON-EMPTY needle set, or it passes because there was
  // nothing to match rather than because the boundary works. Two earlier rows
  // (`/tmp/h`, `/tmp`) were dead for exactly that reason — they stayed green with
  // the boundary check replaced by a bare `indexOf`. Two reviewers found that
  // independently, which is why the assertion below pins the needles first.
  it.each([
    /* eslint-disable sonarjs/publicly-writable-directories -- inert test literals; the detector is a pure string scan */
    ['/tmp/out', 'wc -l /tmp/output.csv'],
    ['/tmp/hold', 'head -5 /tmp/holdings.csv'],
    ['/tmp/vat-run', 'ls /tmp/vat-runner-cache'],
    /* eslint-enable sonarjs/publicly-writable-directories */
  ])('does not fire mid-segment for --out %s', (out, command) => {
    expect(harnessNeedles(out).length, 'row is vacuous: no needle to match').toBeGreaterThan(0);
    expect(scanHits({ transcript: transcriptWith(command), harnessRoot: out })).toEqual([]);
  });

  // The floor that used to live in harnessNeedles silently produced ZERO needles
  // for a short root, disabling the harness-path check while the verdict still read
  // "checked and clean". An absolute reach into the staged tree must still fire.
  it('still detects an absolute reach under a very short --out', () => {
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- inert test literal
    const harnessRoot = '/tmp/x';
    const hits = scanHits({
      transcript: transcriptWith(`cat ${harnessRoot}/staged/my-skill/SKILL.md`),
      harnessRoot,
    });

    expect(harnessNeedles(harnessRoot).length, 'a short root produced no needles at all').toBeGreaterThan(0);
    expect(hits).toHaveLength(1);
  });

  // A URI IS NOT A FILESYSTEM PATH, and without that rule it is resolved as a
  // RELATIVE one — `https://host/…` normalizes to `https:/host/…`, which has no
  // root the resolver recognises, so it gets joined onto the cwd and every segment
  // of the URL becomes a path segment under the arm's own tree. A repository or
  // docs URL carrying vat's directory name then reads as a reach into the harness.
  it('does not fire on a URL whose path happens to carry vat\'s directory name', () => {
    expect(
      scanHits({
        transcript: transcriptWith('curl -sL https://raw.githubusercontent.com/acme/vat-skill-test/main/notes.md'),
        harnessRoot: HARNESS_ROOT,
      }),
    ).toEqual([]);
  });

  // vat tested on a checkout of ITSELF must not self-incriminate: this repo
  // carries the literal `vat-skill-test` in ~10 tracked source and doc files. A
  // BARE WORD IS NOT A PATH — without that rule the grep PATTERN resolves against
  // the cwd and stamps the run contaminated.
  it('does not fire on vat\'s own source text when vat is tested on itself', () => {
    const transcript = transcriptWith(
      "grep -rn vat-skill-test src | head -1 && echo \"harness-location.ts:38: safePath.join(base, 'vat-skill-test', key)\"",
    );

    expect(scanHits({ transcript, harnessRoot: HARNESS_ROOT })).toEqual([]);
  });

  // Round 3 made the case-fold unconditional and did not audit its consumers: the
  // dedupe compared a RAW declared name against a now-always-lowercased excerpt, so
  // any name with a capital double-counted one reach as two. The dedupe is now on
  // the RESOLVED PATH, which cannot drift with the normalizer.
  it('does not double-count a mixed-case executable reached via a harness path', () => {
    const hits = scanHits({
      transcript: transcriptWith(`node ${HARNESS_ROOT}/staged/s/scripts/Summarize.py`),
      harnessRoot: HARNESS_ROOT,
      executableNames: ['Summarize'],
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });

  // macOS ships case-insensitive APFS by default, so this reach SUCCEEDS on the
  // filesystem; the case-fold used to be gated on win32, making it read clean.
  it('fires on a case-shifted path on a case-insensitive filesystem', () => {
    const harnessRoot = '/private/var/folders/2k/abc/T/vat-skill-test/my-skill-830fad22';
    const transcript = transcriptWith(
      'cat /PRIVATE/VAR/FOLDERS/2K/ABC/T/VAT-SKILL-TEST/MY-SKILL-830FAD22/staged/s/SKILL.md',
    );

    expect(scanHits({ transcript, harnessRoot })).toHaveLength(1);
  });
});

/**
 * The arm has tools other than Bash, and a `Read` of an absolute path is the most
 * direct reach there is. Path candidates are taken from every string in a tool's
 * input rather than from a per-tool field list, because the tool surface is the
 * vendor's: a detector that only knows `Read.file_path` goes silently blind the
 * day a tool renames it.
 */
describe('detectBaselineContamination — non-Bash tools', () => {
  it('fires on a Read of a file inside the harness', () => {
    const hits = scanHits({
      transcript: toolTranscript('Read', { file_path: `${HARNESS_ROOT}/staged/s/SKILL.md` }),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });

  it('fires on a Read even under a field name this code has never heard of', () => {
    expect(
      scanHits({
        transcript: toolTranscript('SomeFutureReader', { target_document: `${HARNESS_ROOT}/staged/s/SKILL.md` }),
        harnessRoot: HARNESS_ROOT,
      }),
    ).toHaveLength(1);
  });

  // ⚠️ THE PATTERN IS ROOTED ON PURPOSE. It used to be `**/summary.mjs`, which has
  // no root and so resolves under the arm's OWN cwd — the workspace check rejected
  // it before intent was ever consulted, and the test could not fail however
  // `toolIntent` was mutated. The rooted spelling escapes the workspace and matches
  // the declared name, so the ONLY thing standing between it and a
  // `declared-executable` verdict is that a Glob lists names rather than reading
  // them. Its `Read` twin below is what proves the discrimination runs both ways.
  const ESCAPING_GLOB = '/users/dev/myrepo/dist/skills/s/**/summary.mjs';

  it('does not fire the executable signal on a Glob, which only lists names', () => {
    expect(
      scanHits({
        transcript: toolTranscript('Glob', { pattern: ESCAPING_GLOB, path: '/users/dev/myrepo/dist' }),
        harnessRoot: HARNESS_ROOT,
        executableNames: ['summary'],
      }),
    ).toEqual([]);
  });

  it.each([['Read'], ['read'], ['READ']])('fires the executable signal on a %s of the same path', (tool) => {
    const hits = scanHits({
      transcript: toolTranscript(tool, { file_path: '/users/dev/myrepo/dist/skills/s/summary.mjs' }),
      harnessRoot: HARNESS_ROOT,
      executableNames: ['summary'],
    });

    expect(hits, `a ${tool} of an ambient copy read as a listing`).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_DECLARED_EXECUTABLE);
  });

  // `PathReach.text` for a non-Bash reach is the rendered tool input, and no test
  // asserted it was rendered at all — returning `''` unconditionally was green.
  it('quotes the tool input in a non-Bash excerpt', () => {
    const hits = scanHits({
      transcript: toolTranscript('Read', { file_path: `${HARNESS_ROOT}/staged/s/SKILL.md` }),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits[0]?.excerpt, 'the excerpt was empty, so triage had nothing to go back to').toContain('SKILL.md');
  });

  it('does not fire on the arm reading its own file', () => {
    expect(
      scanHits({
        transcript: toolTranscript('Read', { file_path: `${ARM_CWD}/notes.md` }),
        harnessRoot: HARNESS_ROOT,
      }),
    ).toEqual([]);
  });
});

/**
 * The FIFTH channel's detection half. Round 3 gave each arm its own directory, so
 * they stop overwriting each other; nothing stopped the control arm READING the
 * treatment's live output one directory over, and such a reach contains no harness
 * path at all — which is precisely why the four-channel audit and the harness-path
 * needles both missed it.
 */
describe('detectBaselineContamination — the sibling arm', () => {

  it.each([
    ['relative reach', 'cat ../../1111aaaa2222bbbb/lookup-1/answer.md'],
    ['absolute reach', `cat ${SIBLING_ARM}/lookup-1/answer.md`],
    ['a cd into it', `cd ../../1111aaaa2222bbbb && cat lookup-1/answer.md`],
  ])('fires on a %s into the other arm', (_label, command) => {
    const hits = scanHits({
      transcript: transcriptWith(command),
      harnessRoot: HARNESS_ROOT,
      siblingArmDir: SIBLING_ARM,
    });

    expect(hits, `read clean: ${command}`).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_SIBLING_ARM);
  });

  // `ls ..` prints the sibling's directory name. That is "where am I" — an agent's
  // most common opening move — not "I read the other arm", and stamping it
  // contaminated would train operators to ignore the flag.
  it('does not fire when the arm merely LISTED its parent', () => {
    expect(
      scanHits({
        transcript: bashSession(['ls ..', '1111aaaa2222bbbb\n7f2a91c4\n']),
        harnessRoot: HARNESS_ROOT,
        siblingArmDir: SIBLING_ARM,
      }),
    ).toEqual([]);
  });

  // Its own workspace is where it is supposed to be working.
  it('does not fire on the arm working in its own directory', () => {
    expect(
      scanHits({
        transcript: transcriptWith(`cd ${ARM_CWD} && cat data.csv`),
        harnessRoot: HARNESS_ROOT,
        siblingArmDir: SIBLING_ARM,
      }),
    ).toEqual([]);
  });

  // Absent for the WITH arm (it has no sibling worth naming) — the needle set must
  // then be empty rather than matching everything.
  it('is inert when no sibling is supplied', () => {
    expect(siblingArmNeedles('')).toEqual([]);
    expect(
      scanHits({ transcript: transcriptWith(`cat ${SIBLING_ARM}/lookup-1/answer.md`), harnessRoot: HARNESS_ROOT }),
    ).toEqual([]);
  });
});

/**
 * The FOURTH reachable class: vat's own private tmp dirs. The held eval suite has
 * the `expected_output` ANSWER KEY in it and the grader dir has the run's nonce.
 * Both are siblings of the arm's cwd under the OS temp dir and contain no harness
 * path, so neither the harness needles nor the sibling-arm needles can see them.
 * Reaching a copy of the skill inflates the control arm; reaching the answer key
 * inflates BOTH, so it cannot even show up as a shrunken delta.
 */
describe('detectBaselineContamination — vat private dirs', () => {

  it.each([
    ['the absolute path', `cat ${HOLD_DIR}/evals.json`],
    // The load-bearing case. The token is 16 random hex the arm cannot know, so
    // every reach it can actually TYPE enumerates or globs — and a glob contains
    // neither the full path nor the token, which is what defeats a suffix needle.
    ['a glob over the temp dir', 'cat /tmp/vat-skill-evals-*/evals.json'],
    ['a relative climb', `cat ${UP_TO_TMP}/vat-skill-evals-1111aaaa2222bbbb/evals.json`],
    ['a cd followed by a read', `cd ${UP_TO_TMP}/vat-skill-evals-1111aaaa2222bbbb && cat evals.json`],
  ])('fires on %s into the held answer key', (_label, command) => {
    const hits = scanHits({
      transcript: transcriptWith(command),
      harnessRoot: HARNESS_ROOT,
      vatPrivateDirs: [HOLD_DIR, GRADER_DIR],
    });

    expect(hits, `read clean: ${command}`).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_VAT_PRIVATE_DIR);
  });

  // The prefix needle is only safe for a dir the arm has no business naming. Its
  // OWN workspace root shares the `vat-skill-` stem and its absolute path is in
  // the arm's own prompt, so a needle built from it would fire on every clean run.
  it('does not fire on the arm working in its own workspace', () => {
    expect(
      scanHits({
        transcript: transcriptWith(`cd ${ARM_CWD} && cat data.csv`),
        harnessRoot: HARNESS_ROOT,
        vatPrivateDirs: [HOLD_DIR, GRADER_DIR],
      }),
    ).toEqual([]);
  });

  // Two different capabilities — reading the answer key and reading the nonce —
  // so an operator triaging a contaminated run must see both, not the first.
  it('reports the answer-key dir and the grader dir separately', () => {
    const hits = scanHits({
      transcript: transcriptWith(`cat ${HOLD_DIR}/evals.json && cat ${GRADER_DIR}/nonce`),
      harnessRoot: HARNESS_ROOT,
      vatPrivateDirs: [HOLD_DIR, GRADER_DIR],
    });

    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.kind)).toEqual([KIND_VAT_PRIVATE_DIR, KIND_VAT_PRIVATE_DIR]);
  });

  it('is inert when no private dirs are supplied', () => {
    expect(vatPrivateDirNeedles('')).toEqual([]);
    expect(
      scanHits({ transcript: transcriptWith(`cat ${HOLD_DIR}/evals.json`), harnessRoot: HARNESS_ROOT }),
    ).toEqual([]);
  });

  it('builds full, name and prefix needles, longest first', () => {
    expect(vatPrivateDirNeedles(HOLD_DIR).map((n) => n.needle)).toEqual([
      HOLD_DIR,
      'vat-skill-evals-1111aaaa2222bbbb',
      'vat-skill-evals-',
    ]);
  });

  // Only the FULL path is a truncation of anything; the name and the prefix are
  // whole names, and an `…/` on them would advertise a cut that never happened.
  it('marks only the truncated needle as truncated', () => {
    expect(vatPrivateDirNeedles(HOLD_DIR).map((n) => n.match)).toEqual([
      HOLD_DIR,
      'vat-skill-evals-1111aaaa2222bbbb',
      'vat-skill-evals-',
    ]);
  });
});

describe('detectBaselineContamination — executable-name precision', () => {
  // deriveDeclaredExecutableNames strips the extension, so `scripts/summary.py`
  // yields the needle `summary` — a word in ordinary assistant prose. Firing on
  // it means telling the operator to discard a clean run.
  it('does not fire on a declared name used as an ordinary English word', () => {
    expect(
      scanHits({
        transcript: transcriptWith('echo "I read the CSV and wrote a summary of the totals."'),
        harnessRoot: HARNESS_ROOT,
        executableNames: ['summary', 'totals'],
      }),
    ).toEqual([]);
  });

  // The eight realistic CLEAN pairs a review reproduced against the old pattern,
  // 8/8 firing with "discard the delta" attached. A control arm denied the skill
  // writes its own script and gives it the obvious name — this is the behaviour it
  // is SUPPOSED to exhibit, so a hit here is not a conservative error, it is the
  // measurement being thrown away for doing its job.
  //
  // What unites them: none names a path root outside the arm's own tree. A
  // filename with no directory in front of it says nothing about whose file it is,
  // and a plain relative path resolves inside the arm's own cwd by definition.
  it.each([
    ['a bare invocation of a same-named script', 'python3 analyze.py', 'analyze'],
    ['prose reporting a written file', 'echo "Wrote report.md with the findings."', 'report'],
    ['prose reporting a saved file', 'echo "The output was saved to summary.txt"', 'summary'],
    ['prose reporting a built file', 'echo "built index.json from the rows"', 'index'],
    ['prose reporting a created file', 'echo "created run.sh and made it executable"', 'run'],
    ['a relative path in the arm\'s own cwd', 'node ./scripts/analyze.mjs input.csv', 'analyze'],
    ['a nested relative path in the arm\'s own cwd', 'bash scripts/helpers/run.sh', 'run'],
    ['a URL segment', 'curl https://docs.example.com/report', 'report'],
  ])('does not fire on %s', (_label, command, name) => {
    expect(
      scanHits({ transcript: transcriptWith(command), harnessRoot: HARNESS_ROOT, executableNames: [name] }),
    ).toEqual([]);
  });

  // …and the reaches that ARE evidence, all of which name a path root outside the
  // arm's own tree. This is the whole residual value of a name-based signal: the
  // ambient-copy classes produce no harness path, so nothing else sees them.
  it.each([
    ['an absolute path into the adopter repo', 'node /users/dev/myrepo/dist/skills/s/scripts/summary.mjs'],
    ['a home-rooted path into the plugin cache', 'python3 ~/.claude/plugins/marketplaces/acme/skills/s/summary.py'],
    ['a variable-rooted path', 'sh $TMPDIR/ambient/skills/s/summary'],
    ['a windows drive-rooted path', String.raw`node C:\repo\dist\skills\s\summary.mjs`],
    ['a path that climbs out of the workspace', 'bash ../../../myrepo/bin/summary'],
    ['the executable invoked directly by path', '/users/dev/myrepo/dist/skills/s/summary --in data.csv'],
    // A SPACE IN THE PATH used to kill this signal outright: the flat scan found
    // the token by walking a character class that excludes space, so it truncated
    // at the last segment, the token lost its root, and the reach read CLEAN.
    ['a quoted path containing a space', 'python3 "/Users/dev/My Projects/skill/scripts/summary.py"'],
    ['a backslash-escaped space', String.raw`python3 /Users/dev/My\ Projects/skill/scripts/summary.py`],
    // The standard macOS spelling of the installed-plugin cache — the single most
    // likely ambient copy on the platform this is usually run on.
    [
      'the macOS plugin cache, which has a space in it',
      'node "~/Library/Application Support/claude/plugins/acme/skills/s/summary.mjs"',
    ],
  ])('fires on %s', (_label, command) => {
    const hits = scanHits({
      transcript: transcriptWith(command),
      harnessRoot: HARNESS_ROOT,
      executableNames: ['summary'],
    });

    expect(hits, `expected a hit for: ${command}`).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_DECLARED_EXECUTABLE);
  });

  // The one form that NEEDS armWorkspaceDir threaded in rather than inferred from
  // the path shape: the executor prompt states the arm's working directory
  // absolutely, so the arm echoes and reuses that absolute path constantly. Every
  // such self-reference is absolute and would otherwise read as an escape.
  it('does not fire on the arm\'s own workspace named absolutely', () => {
    expect(
      scanHits({
        transcript: transcriptWith(`node ${ARM_WORKSPACE}/lookup-1/scripts/summary.mjs`),
        harnessRoot: HARNESS_ROOT,
        executableNames: ['summary'],
      }),
    ).toEqual([]);
  });

  // A benign mention almost always comes FIRST — the arm writes its own script
  // before it goes looking for anything. Testing only the first occurrence would
  // let one `./scripts/summary.mjs` hide every real reach behind it.
  it('finds a real reach that appears AFTER a benign mention of the same name', () => {
    const hits = scanHits({
      transcript: bashSession(
        'node ./scripts/summary.mjs draft',
        'python3 ~/.claude/plugins/acme/skills/s/summary.py',
      ),
      harnessRoot: HARNESS_ROOT,
      executableNames: ['summary'],
    });

    expect(hits, 'a benign first mention hid the real reach').toHaveLength(1);
    expect(hits[0]?.excerpt).toContain('.claude/plugins');
  });
});

/**
 * `match` is short, opaque-looking, and the first thing quoted into a bug report.
 * Needles run longest-first, so before this the field carried the ENTIRE absolute
 * harness root — `C:/Users/<username>/AppData/Local/Temp/…` on Windows, and
 * `/Users/<name>/…` on macOS whenever `--out` points into a checkout.
 */
describe('detectBaselineContamination — what `match` is allowed to carry', () => {
  /** A harness root under a home directory, which is the DEFAULT shape on Windows. */
  const HOME_ROOTED = '/users/j.doe/work/out/vat-skill-test/my-skill-abc12345';

  it('drops the leading segments of an absolute needle, username and all', () => {
    const hits = scanHits({
      transcript: transcriptWith(`cat ${HOME_ROOTED}/staged/s/SKILL.md`),
      harnessRoot: HOME_ROOTED,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.match, 'the operator\'s login name reached baseline.json').not.toContain('j.doe');
    expect(hits[0]?.match).toBe(`${REDACTED}vat-skill-test/my-skill-abc12345`);
  });

  // The excerpt is the field that still carries the whole path, and it says so in
  // its own docstring. Pinned here so nobody "fixes" the leak by gutting triage.
  it('keeps the full path in the excerpt, which is the field that warns about it', () => {
    const hits = scanHits({
      transcript: transcriptWith(`cat ${HOME_ROOTED}/staged/s/SKILL.md`),
      harnessRoot: HOME_ROOTED,
    });

    expect(hits[0]?.excerpt).toContain(HOME_ROOTED);
  });

  // Two segments or fewer is the whole needle already: `vat-skill-test`,
  // `vat-skill-evals-` and a short `--out` have no prefix to drop, and an `…/` on
  // them would advertise a truncation that never happened.
  it('leaves a needle of two segments or fewer exactly as it matched', () => {
    const short = '/tmp/h'; // eslint-disable-line sonarjs/publicly-writable-directories -- inert literal
    const hits = scanHits({
      transcript: transcriptWith(`cat ${short}/staged/s/SKILL.md`),
      harnessRoot: short,
    });

    expect(hits[0]?.match).toBe(short);
  });
});

/**
 * `excerpt` exists for ONE job: be carried back to the transcript and searched for.
 *
 * It used to be sliced out of the NORMALIZED haystack — lowercased, backslashes
 * folded, slash runs collapsed — so `SKILL.md` was reported as `skill.md` and a
 * Windows path came back with the wrong separators. Nothing an operator grepped for
 * was in their transcript. The structured scan already quoted raw tool input; these
 * pin the two paths that did not.
 */
describe('detectBaselineContamination — the excerpt quotes RAW transcript', () => {
  it('preserves the arm\'s own casing in a degraded flat scan', () => {
    const scan = detectBaselineContamination({
      transcript: `not stream-json: cat ${HARNESS_ROOT}/staged/S/SKILL.md`,
      harnessRoot: HARNESS_ROOT,
    });

    expect(scan.degraded, 'this must exercise the flat fallback').toBeDefined();
    expect(scan.hits[0]?.excerpt, 'the excerpt came from the lowercased haystack').toContain('SKILL.md');
  });

  it('preserves the arm\'s own casing for a content hit', () => {
    const spoken = 'Rows are assigned to the nearest bucket whose ceiling exceeds the row value.';
    const hits = scanHits({
      transcript: bashSession([OWN_NOTES, `Per the guidance: ${spoken}`]),
      harnessRoot: HARNESS_ROOT,
      skillContentNeedles: [BUCKET_RULE],
    });

    expect(hits[0]?.kind).toBe(KIND_SKILL_CONTENT);
    expect(hits[0]?.excerpt, 'the excerpt was lowercased, so it is not in the transcript').toContain(spoken);
  });

  // The separator fold is not length-preserving on an escaped Windows path, which
  // is exactly why an index into the normalized text cannot address the original.
  it('does not fold a Windows separator out of the excerpt', () => {
    const winRoot = 'C:/repo/vat-skill-test/my-skill-abc12345';
    const scan = detectBaselineContamination({
      transcript: String.raw`not stream-json: type C:\repo\vat-skill-test\my-skill-abc12345\staged\s\SKILL.md`,
      harnessRoot: winRoot,
    });

    expect(scan.hits).toHaveLength(1);
    expect(scan.hits[0]?.excerpt).toContain(String.raw`C:\repo\vat-skill-test`);
  });
});

/**
 * DEFECT: a directory hit SUPPRESSED an independent executable hit.
 *
 * The flat fallback's dedupe asked "does any dir hit's ±60-character EXCERPT
 * contain the executable's name?", and it was armed by `hits.length > 0` across the
 * sibling-arm and private-dir hits too. Proximity is not identity: the two signals
 * answer different questions — a path says the arm found a copy, the executable
 * name says it RAN one — and the second is the one an operator triaging a
 * contaminated run needs. The dedupe now asks whether the executable's own path
 * token runs through a reported directory, which is the "one reach" question.
 */
describe('detectBaselineContamination — one reach is deduped, two reaches are not', () => {
  const AMBIENT_RUN = 'python3 /d/repo/scripts/csvsum.py';

  it('reports a sibling-arm reach and an unrelated executable run as TWO findings', () => {
    const scan = detectBaselineContamination({
      transcript: `not stream-json: ls ${SIBLING_ARM}/e1; ${AMBIENT_RUN}`,
      harnessRoot: HARNESS_ROOT,
      siblingArmDir: SIBLING_ARM,
      armWorkspaceDir: ARM_WORKSPACE,
      executableNames: ['csvsum'],
    });

    expect(scan.degraded, 'this must exercise the flat fallback').toBeDefined();
    expect(scan.hits.map((h) => h.kind)).toEqual([KIND_SIBLING_ARM, KIND_DECLARED_EXECUTABLE]);
  });

  // The verified shape of the original report: a SKILL.md line naming the script it
  // ships is a prime content needle AND the normal case. Content hits are assembled
  // separately from the dir hits now, so they can no longer arm the guard at all —
  // pinned because that separation is what makes the finding moot.
  it('does not let a skill-content hit suppress the executable signal', () => {
    const needle = 'run scripts/csvsum.py against the extract before summarising it.';
    const scan = detectBaselineContamination({
      transcript: `not stream-json: ${needle} then ${AMBIENT_RUN}`,
      harnessRoot: HARNESS_ROOT,
      armWorkspaceDir: ARM_WORKSPACE,
      skillContentNeedles: [needle],
      executableNames: ['csvsum'],
    });

    expect(scan.hits.map((h) => h.kind)).toEqual([KIND_SKILL_CONTENT, KIND_DECLARED_EXECUTABLE]);
  });

  // ...and the case the dedupe was written for still holds: ONE reach, reported at
  // its most specific spelling and not a second time as an executable.
  it('still deduplicates an executable reached THROUGH a reported directory', () => {
    const scan = detectBaselineContamination({
      transcript: `not stream-json: python3 ${HARNESS_ROOT}/staged/s/scripts/csvsum.py`,
      harnessRoot: HARNESS_ROOT,
      armWorkspaceDir: ARM_WORKSPACE,
      executableNames: ['csvsum'],
    });

    expect(scan.hits.map((h) => h.kind)).toEqual([KIND_HARNESS_PATH]);
  });
});

describe('scrubControlArmEnv', () => {
  // The channel the first fix missed: prompt, argv and cwd were closed while the
  // run's single assembled env — CLAUDE_PLUGIN_ROOT included — went to both arms.
  it('drops CLAUDE_PLUGIN_ROOT and any value containing the harness root', () => {
    const { env, droppedForbiddenKey, droppedNamingRoot } = scrubControlArmEnv(
      {
        CLAUDE_PLUGIN_ROOT: `${HARNESS_ROOT}/my-plugin`,
        SNAPSHOT: `${HARNESS_ROOT}/staged/s/data.json`,
        FIXTURES: WS_FIXTURES,
        ANTHROPIC_API_KEY: 'sk-test',
      },
      HARNESS_ROOT,
      [],
    );

    expect(env).not.toHaveProperty('CLAUDE_PLUGIN_ROOT');
    expect(env).not.toHaveProperty('SNAPSHOT');
    // Reported by the rule that caught them, not merged. CLAUDE_PLUGIN_ROOT's value
    // ALSO names the harness root here, so a merged list could not tell an operator
    // which rule fired — and the operator only needs to act on the rule-2 one.
    expect(droppedForbiddenKey).toEqual(['CLAUDE_PLUGIN_ROOT']);
    expect(droppedNamingRoot).toEqual(['SNAPSHOT']);
    // The arms must stay identical in everything except the skill: the control
    // keeps its own fixtures (under the workspaces root) and its auth.
    expect(env['FIXTURES']).toBe(WS_FIXTURES);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-test');
  });

  it('drops a value that names the harness root in the other separator form', () => {
    const { droppedNamingRoot } = scrubControlArmEnv(
      { WIN: String.raw`C:\tmp\vat-skill-test\s\x` },
      'C:/tmp/vat-skill-test/s',
      [],
    );
    expect(droppedNamingRoot).toEqual(['WIN']);
  });

  // The two rules masked each other: in every fixture CLAUDE_PLUGIN_ROOT's value
  // was ALSO under the harness root, so emptying the key list left the suite green
  // (the value scan covered it) and neutering the value scan left it green too
  // (the key list covered it). Neither was independently pinned. These two cases
  // make each rule the ONLY thing that can catch its input.
  it('drops CLAUDE_PLUGIN_ROOT by NAME even when its value is outside the harness root', () => {
    // The installed-plugin-cache case: the key is meaningless to an arm spawned
    // with `pluginDirs: []`, and pointing it anywhere is still handing the control
    // arm a plugin root. Only rule 1 can catch this.
    const { env, droppedForbiddenKey, droppedNamingRoot } = scrubControlArmEnv(
      { CLAUDE_PLUGIN_ROOT: '/Users/dev/.claude/plugins/marketplaces/acme' },
      HARNESS_ROOT,
      [],
    );

    expect(droppedForbiddenKey).toEqual(['CLAUDE_PLUGIN_ROOT']);
    // …and NOT reported as naming the harness root, because it does not. This is the
    // case that makes the merged wording a lie rather than merely imprecise.
    expect(droppedNamingRoot).toEqual([]);
    expect(env).not.toHaveProperty('CLAUDE_PLUGIN_ROOT');
  });

  it('drops an unlisted key by VALUE when it names the harness root', () => {
    // Only rule 2 can catch this — SNAPSHOT is in no key list anywhere.
    const { env, droppedForbiddenKey, droppedNamingRoot } = scrubControlArmEnv(
      { SNAPSHOT: `${HARNESS_ROOT}/staged/s/x.json` },
      HARNESS_ROOT,
      [],
    );

    expect(droppedNamingRoot).toEqual(['SNAPSHOT']);
    expect(droppedForbiddenKey).toEqual([]);
    expect(env).not.toHaveProperty('SNAPSHOT');
  });

  // A scrub that breaks the control arm manufactures the delta the product sells,
  // which is strictly worse than the leak it closes. `--out .` from a repo root
  // under `bun run` puts <repo>/node_modules/.bin on PATH, making PATH itself
  // "contain the harness root".
  // The worst outcome this exemption prevents, and the one nobody would look for.
  // Dropping a model var because its value happens to sit under `--out` runs the
  // control arm ON A DIFFERENT MODEL — a confound that reads as skill lift and
  // appears nowhere in the output.
  it('retains a MODEL var that names the harness root, when the run declares one', () => {
    const { env, droppedNamingRoot, retainedLeaks } = scrubControlArmEnv(
      { ANTHROPIC_MODEL: `${HARNESS_ROOT}/models/pinned` },
      HARNESS_ROOT,
      ['ANTHROPIC_MODEL'],
    );

    expect(env['ANTHROPIC_MODEL'], 'the control arm lost its model pin').toBeDefined();
    expect(droppedNamingRoot).toEqual([]);
    expect(retainedLeaks).toEqual(['ANTHROPIC_MODEL']);
  });

  // The negative control for the case above: same var, same value, but NOT
  // declared as a model var — so it is ordinary env and rule 2 drops it. Without
  // this, the test above would pass on a `protectedEnvNames()` that ignores its
  // argument entirely, which is exactly the bug being fixed.
  it('drops that same var when the run declares no model vars', () => {
    const { droppedNamingRoot } = scrubControlArmEnv(
      { ANTHROPIC_MODEL: `${HARNESS_ROOT}/models/pinned` },
      HARNESS_ROOT,
      [],
    );

    expect(droppedNamingRoot).toEqual(['ANTHROPIC_MODEL']);
  });

  it('retains a process-essential var that names the harness root, and reports it', () => {
    const repoRoot = '/Users/dev/myrepo';
    const { env, droppedNamingRoot, retainedLeaks } = scrubControlArmEnv(
      { PATH: `${repoRoot}/node_modules/.bin:/usr/bin:/bin`, HOME: repoRoot },
      repoRoot,
      [],
    );

    expect(env['PATH'], 'the control arm was spawned with no PATH').toBeDefined();
    expect(droppedNamingRoot).toEqual([]);
    expect([...retainedLeaks].sort((a: string, b: string) => a.localeCompare(b))).toEqual(['HOME', 'PATH']);
  });

  // <tmp>/vat-skill-test is a string PREFIX of <tmp>/vat-skill-test-ws-<token>,
  // where ${fixturesDir} lives — so a bare `includes` stripped the control arm's
  // own declared input files while the treatment kept them. Same fake-lift
  // direction as the PATH case above.
  it('does not strip a value that merely shares a path PREFIX with the harness root', () => {
    /* eslint-disable sonarjs/publicly-writable-directories -- inert test literals; scrubControlArmEnv is a pure string scan */
    const harnessRoot = '/tmp/vat-skill-test';
    const fixtures = '/tmp/vat-skill-test-ws-9f3c/lookup-1/fixtures';
    /* eslint-enable sonarjs/publicly-writable-directories */
    const { env, droppedNamingRoot } = scrubControlArmEnv({ FIXTURES: fixtures }, harnessRoot, []);

    expect(droppedNamingRoot, 'a prefix collision stripped the control arm fixtures').toEqual([]);
    expect(env['FIXTURES']).toBe(fixtures);
  });
});

/**
 * The signal for the case every OTHER signal is blind to: an instruction-only
 * skill, which ships no executable, reached through an ambient copy, which carries
 * no harness path. `grep -rl "<phrase>" .` → `Read` → answer left no trace at all.
 */
/** The body lines of SKILL_MD below that qualify, normalized as the detector sees them. */
const BUCKET_RULE = 'rows are assigned to the nearest bucket whose ceiling exceeds the row value.';
const TIE_RULE = 'when two buckets tie, the one declared first in the config wins outright.';
const QUOTED_RULE = 'a bucket whose label is "unassigned" is reported but never counted.';

describe('skillContentNeedles', () => {
  const SKILL_MD = [
    '---',
    'name: bucket-mapper',
    'description: Maps rows onto buckets using the house convention.',
    '---',
    '',
    '# Bucket mapper',
    '',
    'Rows are assigned to the nearest bucket whose ceiling exceeds the row value.',
    'Short line.',
    '',
    '```bash',
    'node scripts/bucket-map.mjs --input rows.csv --emit buckets.json',
    '```',
    '',
    '| column | meaning | so that a table row is long enough to qualify on length |',
    '',
    '> A block quote that is comfortably longer than the minimum needle length.',
    '',
    'When two buckets tie, the one declared first in the config wins outright.',
  ].join('\n');

  it('lifts distinctive body prose, longest first', () => {
    expect(skillContentNeedles(SKILL_MD)).toEqual([BUCKET_RULE, TIE_RULE]);
  });

  // Each exclusion earns its place, and the reason differs per line.
  it.each([
    ['the frontmatter description', 'maps rows onto buckets'],
    ['a fenced code line', 'bucket-map.mjs'],
    ['a heading', '# bucket mapper'],
    ['a table row', '| column |'],
    ['a block quote', 'a block quote'],
    ['a line under the length floor', 'short line'],
  ])('does not lift %s', (_label, fragment) => {
    expect(skillContentNeedles(SKILL_MD).some((needle) => needle.includes(fragment))).toBe(false);
  });

  // The false positive that would make this signal unusable, in each of the FOUR
  // channels through which vat itself hands the arm text. The arm reading the
  // input vat gave it is not the arm reaching the skill, and firing on it would
  // stamp every run contaminated while telling the operator to go uninstall an
  // ambient copy of the plugin that does not exist.
  //
  // The FIXTURE channel is the one that was missing: `resolveSkillContentNeedles`
  // excluded prompts, expected_output and expectations, but not the contents of
  // the input `files` vat stages into the arm's workspace and instructs it to
  // operate on. All four are joined into `excludedText` by the caller, so this
  // pins the contract; the wiring itself is pinned in run-harness.
  // Deliberately ONE test and not a four-row table over the channels: this
  // function receives the four already joined into one string, so four rows would
  // run identical code under four different labels — the "table that went
  // vacuous" this file has been bitten by three times. The channel that was
  // MISSING (staged fixtures) is a wiring defect in `resolveSkillContentNeedles`,
  // and its wiring is not reachable from here; that function is private to
  // run-harness and has no unit test of its own.
  it('drops a needle the run itself handed the arm', () => {
    expect(skillContentNeedles(SKILL_MD, `some other text\n${BUCKET_RULE}\nand more`)).toEqual([TIE_RULE]);
  });

  // 📌 A rule dropping lines that carry `"` or `\` used to live here, because the
  // haystack was the RAW stream-json where those are escaped. The content signal
  // now reads DECODED text, so such a line matches its own text fine — and
  // dropping it was silently costing quote-heavy skills their only signal.
  it('lifts a line carrying quotes, which the decoded haystack matches verbatim', () => {
    const md = ['# Doc', 'A bucket whose label is "unassigned" is reported but never counted.'].join('\n');

    expect(skillContentNeedles(md)).toEqual([QUOTED_RULE]);
  });

  it('yields nothing for a skill whose body has no distinctive prose', () => {
    expect(skillContentNeedles('---\nname: x\n---\n\n# X\n\nDo the thing.\n')).toEqual([]);
  });
});

describe('detectBaselineContamination — skill content', () => {
  const NEEDLE = BUCKET_RULE;

  it('flags a transcript quoting the skill with no path attached', () => {
    // The invisible reach: a grep hit read and answered from. No harness path, no
    // executable name, nothing else in this module can see it.
    const hits = scanHits({
      transcript: bashSession([OWN_NOTES, `Per the guidance: ${NEEDLE}`]),
      harnessRoot: HARNESS_ROOT,
      skillContentNeedles: [NEEDLE],
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_SKILL_CONTENT);
    expect(hits[0]?.match).toBe(NEEDLE);
  });

  // THE CASE THE PATH REDESIGN MUST NOT BREAK. A `grep` whose search root is the
  // temp dir names nothing private in its INPUT — so no path needle may fire on
  // it, however loudly its OUTPUT quotes the harness. The evidence is that the
  // skill's own words came BACK, and that is a content finding, not a path one.
  it('flags a recursive grep by CONTENT, never by the path its output printed', () => {
    const output =
      `${UP_TO_TMP}/vat-skill-test/my-skill-abc12345/staged/s/SKILL.md:${NEEDLE}\n`;
    const hits = scanHits({
      transcript: bashSession([`grep -r "${NEEDLE}" ${UP_TO_TMP}`, output]),
      harnessRoot: HARNESS_ROOT,
      skillContentNeedles: [NEEDLE],
    });

    expect(hits, 'the grep hit was missed entirely').toHaveLength(1);
    expect(hits[0]?.kind, 'reported as a path reach, which the grep INPUT never made').toBe(KIND_SKILL_CONTENT);
  });

  // A quote-carrying needle is only usable because the haystack is decoded; against
  // the raw stream-json its `"` would be escaped and it could never match.
  it('matches a needle carrying characters stream-json escapes', () => {
    const hits = scanHits({
      transcript: bashSession([OWN_NOTES, `From the doc: ${QUOTED_RULE}`]),
      harnessRoot: HARNESS_ROOT,
      skillContentNeedles: [QUOTED_RULE],
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_SKILL_CONTENT);
  });

  // Writing the skill's prose into a file is seeing it just as surely as reading
  // it back, and that evidence lives in a tool INPUT.
  //
  // ⚠️ THE NEEDLE CARRIES QUOTES ON PURPOSE, and the old fixture's did not. The
  // content haystack falls back to the RAW transcript when the decoded parts join to
  // nothing, and a quote-free needle is present verbatim in the raw stream-json too
  // — so this test passed through the fallback and could not fail however the
  // tool-input part was mutated. Inside stream-json a `"` is escaped, so the needle
  // below exists ONLY in the decoded input.
  it('flags the skill\'s prose appearing in a tool INPUT', () => {
    const transcript = transcriptWith(`echo "${QUOTED_RULE}" > notes.md`);

    expect(transcript, 'the fixture is vacuous: the raw transcript already carries the needle')
      .not.toContain(QUOTED_RULE);
    expect(
      scanHits({ transcript, harnessRoot: HARNESS_ROOT, skillContentNeedles: [QUOTED_RULE] }),
    ).toHaveLength(1);
  });

  // The same guard for the assistant-TEXT part of the haystack, which was droppable
  // green for the same reason.
  it('flags the skill\'s prose appearing in assistant TEXT', () => {
    const transcript = [
      INIT_EVENT,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `Per the doc: ${QUOTED_RULE}` }] } }),
      RESULT_EVENT,
    ].join('\n');

    expect(transcript, 'the fixture is vacuous').not.toContain(QUOTED_RULE);
    expect(
      scanHits({ transcript, harnessRoot: HARNESS_ROOT, skillContentNeedles: [QUOTED_RULE] }),
    ).toHaveLength(1);
  });

  it('reports one hit even when several needles match', () => {
    const hits = scanHits({
      transcript: bashSession([OWN_NOTES, `${NEEDLE} ${TIE_RULE}`]),
      harnessRoot: HARNESS_ROOT,
      skillContentNeedles: [NEEDLE, TIE_RULE],
    });

    expect(hits).toHaveLength(1);
  });

  it('stays silent on a transcript that never quotes the skill', () => {
    expect(
      scanHits({
        transcript: bashSession([OWN_NOTES, 'I grouped the rows by their value and wrote the result.']),
        harnessRoot: HARNESS_ROOT,
        skillContentNeedles: [NEEDLE],
      }),
    ).toEqual([]);
  });

  // Degradation costs every PATH signal its precision; it must cost the content
  // signal nothing, because a verbatim line of prose is evidence wherever it is.
  it('still fires from a transcript that would not parse at all', () => {
    const scan = detectBaselineContamination({
      transcript: `not stream-json — ${NEEDLE}`,
      harnessRoot: HARNESS_ROOT,
      skillContentNeedles: [NEEDLE],
    });

    expect(scan.degraded?.reason).toBe(REASON_UNPARSED);
    expect(scan.hits).toHaveLength(1);
    expect(scan.hits[0]?.kind).toBe(KIND_SKILL_CONTENT);
  });
});

/**
 * The DERIVATION of the signal list, separate from the summary that renders it.
 * Pinning only the render leaves this unwired — dropping a `signals.push` kept
 * all 55 tests green until these existed, which is the "testing a pure helper
 * never pins its wiring" class this suite has been bitten by before.
 *
 * Each case arms exactly ONE optional signal, so a detector that stops
 * contributing shows up as its own failure rather than as a count that still
 * happens to add up.
 */
describe('activeContaminationSignals', () => {

  it('arms only the harness signal for the barest input', () => {
    expect(activeContaminationSignals({ transcript: '', harnessRoot: HARNESS_ROOT })).toEqual([KIND_HARNESS_PATH]);
  });

  it.each([
    [KIND_SIBLING_ARM, { siblingArmDir: SIBLING_ARM }],
    [KIND_VAT_PRIVATE_DIR, { vatPrivateDirs: [HOLD_DIR] }],
    [KIND_SKILL_CONTENT, { skillContentNeedles: ['a sentence long enough to be a real content needle'] }],
    [KIND_DECLARED_EXECUTABLE, { executableNames: [BUNDLE_NAME] }],
  ])('arms %s when, and only when, its input is threaded through', (signal, extra) => {
    expect(
      activeContaminationSignals({ transcript: '', harnessRoot: HARNESS_ROOT, ...extra }),
    ).toEqual([KIND_HARNESS_PATH, signal]);
  });

  // "Armed" must mean "has needles to match with", not "the field was present".
  // An undefined dir in the list produces no needles and must not be counted.
  it('does not arm a signal whose input yields no needles', () => {
    expect(
      activeContaminationSignals({
        transcript: '',
        harnessRoot: HARNESS_ROOT,
        siblingArmDir: '',
        vatPrivateDirs: [undefined],
        // A SKILL.md whose body yields no line distinctive enough to accuse
        // anyone with — the signal is genuinely unarmed, and must say so.
        skillContentNeedles: [],
        // Below MIN_EXECUTABLE_NAME_LENGTH, so the detector skips it entirely.
        executableNames: ['wc'],
      }),
    ).toEqual([KIND_HARNESS_PATH]);
  });

  // The whole point of the field: nothing was looking, so `contaminated` says
  // nothing. An empty harness root is the only way to reach it today, but the
  // block must be able to express it.
  it('arms nothing at all when even the harness root is empty', () => {
    expect(activeContaminationSignals({ transcript: '', harnessRoot: '' })).toEqual([]);
  });
});

/**
 * `--baseline` sells a DELTA, and a delta between two differently-sized
 * denominators is not one. vat computes each arm's `summary` from the fragments it
 * received, so both reports are internally consistent by construction and
 * `reconcileGrading` — the only cross-check that existed — cannot see this.
 */
describe('armExpectationSkew', () => {
  // `passed` is carried by ArmEvalGrade for the delta block's benefit; this check
  // reads only `total`, so the value here is deliberately inert.
  const graded = (evalId: string, total: number): ArmEvalGrade => ({ evalId, passed: 0, total });

  it('is silent when both arms graded the same evals to the same depth', () => {
    const counts = [graded('e1', 3), graded('e2', 2)];
    expect(armExpectationSkew(counts, counts)).toEqual([]);
  });

  // The damaging direction, and the one from the report: a control arm graded
  // against 2 of 3 expectations yields summary {passed:2,total:2} — 100% WITHOUT
  // the skill, i.e. "the skill did nothing".
  it('reports a control arm graded against fewer expectations', () => {
    expect(
      armExpectationSkew([graded('e1', 3)], [graded('e1', 2)]),
    ).toEqual([{ evalId: 'e1', withTotal: 3, withoutTotal: 2 }]);
  });

  it('reports the opposite direction too', () => {
    expect(
      armExpectationSkew([graded('e1', 2)], [graded('e1', 3)]),
    ).toEqual([{ evalId: 'e1', withTotal: 2, withoutTotal: 3 }]);
  });

  // An eval missing from one arm entirely skews the run total exactly as a
  // short-graded one does, and the per-eval loop over the OTHER arm cannot see it.
  it.each([
    ['the control arm never graded it', [graded('e1', 2)], [], [{ evalId: 'e1', withTotal: 2, withoutTotal: 0 }]],
    ['the treatment arm never graded it', [], [graded('e1', 2)], [{ evalId: 'e1', withTotal: 0, withoutTotal: 2 }]],
  ])('reports an eval only one arm graded — %s', (_label, withArm, withoutArm, expected) => {
    expect(armExpectationSkew(withArm, withoutArm)).toEqual(expected);
  });
});

/** The two banner phrases the block's prose is asserted on, in several places each. */
const NOT_COMPARABLE_BANNER = 'ARMS NOT COMPARABLE';
const DEAD_CONTROL_BANNER = 'CONTROL ARM DID NOT RUN';

/**
 * Call `summarizeBaselineIntegrity` with the healthy defaults filled in.
 *
 * The production signature defaults NOTHING — every field is a coverage claim and a
 * default is how a caller overclaims silently (the `degraded` list spent a release
 * defaulted to `[]` and unwired, so every shipped `baseline.json` read as a clean
 * structured scan whether or not one had run). A test helper may default, because a
 * test that meant to exercise a failure and silently got the healthy path fails its
 * own assertions rather than shipping a lie.
 */
function summarize(over: Partial<SummarizeBaselineIntegrityInput> = {}): BaselineIntegrity {
  return summarizeBaselineIntegrity({
    findings: [],
    signals: ALL_SIGNALS,
    skew: [],
    degraded: [],
    controlArmFailures: [],
    // The healthy default: two evals were actually scanned. A run where none was
    // gets its own block below, because the summary must not report an observation
    // that never happened.
    observedEvals: 2,
    ...over,
  });
}

describe('summarizeBaselineIntegrity', () => {
  const SKEW = [{ evalId: 'e1', withTotal: 3, withoutTotal: 2 }];

  it('marks a run with matching arms comparable', () => {
    const integrity = summarize();

    expect(integrity.comparable).toBe(true);
    expect(integrity.skew).toEqual([]);
    expect(integrity.degraded).toEqual([]);
    expect(integrity.summary).not.toContain('NOT COMPARABLE');
  });

  // Clean AND incomparable is a real state, and the two must not be conflated:
  // contamination says the control HAD the treatment, comparability says the two
  // numbers were never measuring the same thing.
  it('marks a CLEAN run incomparable when the arms disagree, and says so', () => {
    const integrity = summarize({ skew: SKEW });

    expect(integrity.contaminated).toBe(false);
    expect(integrity.comparable).toBe(false);
    expect(integrity.skew).toEqual(SKEW);
    expect(integrity.summary).toContain(NOT_COMPARABLE_BANNER);
    expect(integrity.summary).toContain('e1');
    expect(BaselineIntegritySchema.safeParse(integrity).success).toBe(true);
  });

  it('reports both problems when a run is contaminated AND incomparable', () => {
    const findings: BaselineContamination[] = [
      { evalId: 'e1', hits: [{ kind: KIND_HARNESS_PATH, match: HARNESS_ROOT, excerpt: EXCERPT_ELLIPSIS }] },
    ];
    const integrity = summarize({ findings, skew: SKEW });

    expect(integrity.contaminated).toBe(true);
    expect(integrity.comparable).toBe(false);
    expect(integrity.summary).toContain('BASELINE CONTAMINATED');
    expect(integrity.summary).toContain(NOT_COMPARABLE_BANNER);
    expect(BaselineIntegritySchema.safeParse(integrity).success).toBe(true);
  });

  // A degraded scan writes `contaminated: false` with exactly the same bytes as a
  // structured one. `signals` already separates "checked and clean" from "nothing
  // was armed"; this separates it from "checked with the blunt instrument".
  it.each([
    ['a clean run', [] as BaselineContamination[]],
    [
      'a contaminated run',
      [{ evalId: 'e2', hits: [{ kind: KIND_HARNESS_PATH, match: HARNESS_ROOT, excerpt: EXCERPT_ELLIPSIS }] }],
    ],
  ])('says a degraded scan is not a clean scan, on %s', (_label, findings) => {
    const integrity = summarize({
      findings: [...findings],
      degraded: [{ reason: 'cwd-untracked', detail: 'could not evaluate "cd $D"', evalId: 'e1' }],
    });

    expect(integrity.degraded).toHaveLength(1);
    expect(integrity.summary).toContain('DEGRADED SCAN');
    expect(integrity.summary).toContain('e1: cwd-untracked');
    expect(BaselineIntegritySchema.safeParse(integrity).success).toBe(true);
  });
});

/**
 * A control arm that never produced a grade at all. Distinct from skew — which is
 * two arms that both graded and disagreed about how deep — because the remedies are
 * different: skew points at the grader, a dead arm points at a timeout or a spawn.
 * Reporting the second as the first sends triage to the wrong place, and hides the
 * one fact the operator most needs: the treatment half is intact.
 */
describe('summarizeBaselineIntegrity — a control arm that never ran', () => {
  const FAILURE = {
    evalId: 'e1',
    detail: '[control arm (skill withheld)] Executor timed out for eval "e1" (limit 300000ms).',
  };
  /** What the harness derives alongside it: the eval is now graded on ONE arm. */
  const INDUCED_SKEW = [{ evalId: 'e1', withTotal: 2, withoutTotal: 0 }];

  it.each([
    ['records the failure verbatim, for the artifact', (i: BaselineIntegrity) => {
      expect(i.controlArmFailures).toEqual([FAILURE]);
    }],
    ['names the arm in the prose', (i: BaselineIntegrity) => {
      expect(i.summary).toContain(DEAD_CONTROL_BANNER);
    }],
    ['carries the underlying cause into the prose', (i: BaselineIntegrity) => {
      expect(i.summary).toContain('Executor timed out');
    }],
    ['says the treatment arm still stands', (i: BaselineIntegrity) => {
      expect(i.summary).toContain('treatment arm was graded');
    }],
    ['stays inside the block contract', (i: BaselineIntegrity) => {
      expect(BaselineIntegritySchema.safeParse(i).success).toBe(true);
    }],
  ])('%s', (_label, assertOn) => {
    assertOn(summarize({ controlArmFailures: [FAILURE], skew: INDUCED_SKEW }));
  });

  // The prose order is load-bearing: the skew note is a CONSEQUENCE of the dead arm,
  // and an operator who reads the consequence first goes and audits the grader.
  it('states the dead arm BEFORE the skew it causes', () => {
    const { summary } = summarize({ controlArmFailures: [FAILURE], skew: INDUCED_SKEW });
    const deadAt = summary.indexOf(DEAD_CONTROL_BANNER);

    // Presence first: `-1 < n` is true, so an ordering assertion alone passes
    // vacuously the moment the banner stops being emitted at all.
    expect(deadAt).toBeGreaterThanOrEqual(0);
    expect(deadAt).toBeLessThan(summary.indexOf(NOT_COMPARABLE_BANNER));
  });

  // `comparable` reads `skew` alone, on purpose — one authority, shared with
  // `computeBaselineDelta`. This pins the consequence: passing a failure WITHOUT the
  // skew it always induces leaves the run comparable, which is why the harness-level
  // test that both are derived together exists.
  it('leaves `comparable` to skew alone rather than acquiring a second rule', () => {
    expect(summarize({ controlArmFailures: [FAILURE], skew: INDUCED_SKEW }).comparable).toBe(false);
    expect(summarize({ controlArmFailures: [FAILURE] }).comparable).toBe(true);
  });

  // Unconditional, like every other field on the block: an absent list and an empty
  // one must not be the same bytes, or "both arms ran" stops being a claim.
  it('reports an empty list on a healthy run rather than omitting the field', () => {
    const integrity = summarize();

    expect(integrity.controlArmFailures).toEqual([]);
    expect(integrity.summary).not.toContain(DEAD_CONTROL_BANNER);
  });

  // Contamination and a dead control arm are independent failures; a run can have
  // both, and the block must not drop either.
  it('reports a contaminated run whose control arm ALSO died, without losing either', () => {
    const integrity = summarize({
      findings: [{ evalId: 'e2', hits: [{ kind: KIND_HARNESS_PATH, match: HARNESS_ROOT, excerpt: EXCERPT_ELLIPSIS }] }],
      controlArmFailures: [FAILURE],
      skew: INDUCED_SKEW,
    });

    expect(integrity.contaminated).toBe(true);
    expect(integrity.summary).toContain('BASELINE CONTAMINATED');
    expect(integrity.summary).toContain(DEAD_CONTROL_BANNER);
  });
});

describe('summarizeBaselineIntegrity — contamination verdict', () => {
  // The block is emitted even when clean, so a reader can tell "checked and
  // clean" from "written before this check existed".
  it('reports a clean run as not contaminated, with an explicit caveat', () => {
    const integrity = summarize();

    expect(integrity.contaminated).toBe(false);
    expect(integrity.findings).toEqual([]);
    expect(integrity.summary).toContain('not a capability control');
    expect(BaselineIntegritySchema.safeParse(integrity).success).toBe(true);
  });

  // Without this, `contaminated: false` reads the same whether four detectors
  // were armed or one — and the executable signal, the only one that sees an
  // ambient copy in the adopter's own repo, does not exist for a skill that
  // ships no executables (the common case).
  it('records which detectors were armed, and names them in the clean summary', () => {
    const integrity = summarize({ signals: [KIND_HARNESS_PATH, KIND_SIBLING_ARM] });

    expect(integrity.signals).toEqual(['harness-path', 'sibling-arm']);
    expect(integrity.summary).toContain('checked by: harness-path, sibling-arm');
  });

  // The loudest case: a clean verdict from a run where nothing was looking must
  // not read like a clean verdict from a run where everything was.
  it('says outright that a verdict with no armed detector is not evidence', () => {
    const integrity = summarize({ signals: [] });

    expect(integrity.signals).toEqual([]);
    expect(integrity.summary).toContain('NO detector was armed');
    expect(BaselineIntegritySchema.safeParse(integrity).success).toBe(true);
  });

  it('names every contaminated eval and says the delta is not skill lift', () => {
    const findings: BaselineContamination[] = [
      { evalId: 'lookup-1', hits: [{ kind: KIND_HARNESS_PATH, match: HARNESS_ROOT, excerpt: EXCERPT_ELLIPSIS }] },
      { evalId: 'lookup-2', hits: [{ kind: 'declared-executable', match: BUNDLE_NAME, excerpt: EXCERPT_ELLIPSIS }] },
    ];
    const integrity = summarize({ findings });

    expect(integrity.contaminated).toBe(true);
    expect(integrity.summary).toContain('lookup-1, lookup-2');
    expect(integrity.summary).toContain('NOT a measure of skill lift');
    expect(BaselineIntegritySchema.safeParse(integrity).success).toBe(true);
  });
});

/** An ambient copy of the skill's script in the adopter's own build output. */
const AMBIENT_SCRIPT = '/users/dev/myrepo/dist/skills/s/scripts/summary.mjs';
/** The same script, but in vat's staged tree. */
const STAGED_SCRIPT = `${HARNESS_ROOT}/staged/s/scripts/summary.py`;

/** One scan, keeping the degradation — for the cases whose POINT is degrading. */
function scanOf(
  transcript: string,
  over: Partial<DetectBaselineContaminationInput> = {},
): BaselineContaminationScan {
  return detectBaselineContamination({
    transcript,
    harnessRoot: HARNESS_ROOT,
    armWorkspaceDir: ARM_WORKSPACE,
    armCwd: ARM_CWD,
    ...over,
  });
}

/**
 * OPERAND VERSUS PROSE — the line the redesign said was "input versus output".
 *
 * Every row below is tool INPUT naming vat's own harness root, and none of them
 * opens anything: the path is a thing being printed, searched FOR, substituted in,
 * commented about, or stored in a note. All of them stamped `contaminated: true`,
 * and the instruction attached to that verdict is "discard the delta" — so a check
 * that routinely destroys good runs is not the conservative direction, it is a
 * different way to lose the measurement.
 */
describe('detectBaselineContamination — a path in PROSE is not a reach', () => {
  it.each([
    ['a path echoed into a note', `echo "checked ${HARNESS_DIR}, empty" >> notes.md`],
    ['a path used as a grep PATTERN', `grep -rn "${HARNESS_DIR}" .`],
    ['a path in a trailing comment', `ls -la  # nothing under ${HARNESS_DIR}`],
    ['a path inside a sed substitution script', `sed -i "s|foo|${HARNESS_ROOT}/x|" ./notes.md`],
    ['a path given to find -name, which is a pattern', `find . -name "${HARNESS_ROOT}/x"`],
  ])(STAYS_CLEAN, (_label, command) => {
    expect(scanHits({ transcript: transcriptWith(command), harnessRoot: HARNESS_ROOT })).toEqual([]);
  });

  it.each([
    ['a Write whose CONTENT mentions the path', 'Write', {
      file_path: 'notes.md',
      content: `I searched ${HARNESS_DIR} and found nothing of interest there.`,
    }],
    ['a TodoWrite item mentioning the path', 'TodoWrite', {
      todos: [{ content: `Check ${HARNESS_DIR} later`, status: 'pending', activeForm: 'Checking' }],
    }],
    ['a Task prompt mentioning the path', 'Task', {
      description: 'look around',
      prompt: `See whether ${HARNESS_DIR} holds anything.`,
      subagent_type: 'general-purpose',
    }],
    ['a Grep whose PATTERN is the path', 'Grep', { pattern: HARNESS_DIR, path: '.' }],
  ])(STAYS_CLEAN, (_label, tool, input) => {
    expect(scanHits({ transcript: toolTranscript(tool, input), harnessRoot: HARNESS_ROOT })).toEqual([]);
  });

  // ...and the operand half, so the rows above are not passing because nothing can
  // fire any more. Each of these is the SAME path in a field that really is opened.
  // The third row is the forward-compatibility promise: an unknown tool under an
  // unknown field name must still be able to convict, or the per-tool field map
  // would have closed the over-report by reopening the under-report.
  it.each([
    ['a Grep whose search ROOT is the harness', 'Grep', { pattern: 'bucket', path: `${HARNESS_ROOT}/staged` }],
    ['a Write INTO the harness', 'Write', { file_path: `${HARNESS_ROOT}/staged/s/x.md`, content: 'hello' }],
    ['an unknown tool under an unknown field name', 'SomeFutureReader', {
      target_document: `${HARNESS_ROOT}/staged/s/SKILL.md`,
    }],
  ])('still fires: %s', (_label, tool, input) => {
    const hits = scanHits({ transcript: toolTranscript(tool, input), harnessRoot: HARNESS_ROOT });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });
});

/**
 * A WRITE DESTINATION IS NOT EVIDENCE THAT ANYTHING RAN.
 *
 * Declared executable names are basenames minus extension, so `summary`, `report`,
 * `index` and `run` are the norm — and a control arm denied the skill writes its own
 * output file and gives it exactly one of those names. Every row here reported
 * `declared-executable`: the arm accused of RUNNING the skill's tool on the strength
 * of having redirected `sort` into a file.
 */
describe('detectBaselineContamination — a write DESTINATION is not a run', () => {
  it.each([
    ['a redirect target', 'sort data.csv > /tmp/summary.txt'],
    ['an append target', 'wc -l data.csv >> /tmp/summary.txt'],
    ['a cp destination', 'cp notes.md /tmp/summary.md'],
    ['an mv destination', 'mv draft.md /tmp/report.md'],
    ['a glob concatenation target', 'cat parts/*.json > /tmp/index.json'],
  ])(STAYS_CLEAN, (_label, command) => {
    expect(
      scanHits({
        transcript: transcriptWith(command),
        harnessRoot: HARNESS_ROOT,
        executableNames: ['summary', 'report', 'index'],
      }),
    ).toEqual([]);
  });

  // The controls that were ALREADY clean and must stay so, since a fix that simply
  // stopped resolving destinations would pass the rows above for the wrong reason.
  it.each([
    ['a relative destination', 'cp notes.md ./summary.md'],
    ['a destination inside the arm workspace', `cp notes.md ${ARM_WORKSPACE}/e1/summary.md`],
    ['an echo into a destination', 'echo x > /tmp/summary.md'],
  ])(STAYS_CLEAN, (_label, command) => {
    expect(
      scanHits({ transcript: transcriptWith(command), harnessRoot: HARNESS_ROOT, executableNames: ['summary'] }),
    ).toEqual([]);
  });

  // A destination is still a REACH — writing into vat's staged tree is not
  // orientation — so only the executable signal is withheld, not the path one.
  it('still reports a write INTO the harness as a path reach', () => {
    const hits = scanHits({
      transcript: transcriptWith(`cp notes.md ${HARNESS_ROOT}/staged/s/notes.md`),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });
});

/**
 * THE `cd` FORMS THE WALK GOT SILENTLY WRONG.
 *
 * A wrong resolution is worse than a recorded degradation, because degradation is
 * visible and wrongness is not. Every form below either resolves CORRECTLY now or
 * degrades; none of them is allowed to carry a cwd it cannot justify.
 *
 * The `…/` on the expected match is what says the FULL-root needle matched — no
 * single command in these transcripts spells the root, so only a correct multi-step
 * walk can reconstruct it.
 */
describe('detectBaselineContamination — cd forms that were silently wrong', () => {
  const REACH = REACH_FROM_HARNESS_DIR;
  const FULL_ROOT_MATCH = `${REDACTED}vat-skill-test/my-skill-abc12345`;

  // Each of these puts the arm INSIDE `<tmp>/vat-skill-test` by a route the head
  // resolver could not see, so the reach that follows resolves under the real root.
  it.each([
    ['a cd behind a shell keyword', 'if [ -d vat-skill-test ]; then cd vat-skill-test; fi'],
    ['a cd inside a brace group, whose cwd DOES persist past the }', '{ cd vat-skill-test; }'],
    ['a cd after the end-of-options marker', 'cd -- vat-skill-test'],
    ['a cd behind a flag', 'cd -P vat-skill-test'],
  ])('tracks %s', (_label, step) => {
    const hits = scanHits({ transcript: bashSession(`cd ${UP_TO_TMP}`, step, REACH), harnessRoot: HARNESS_ROOT });

    expect(hits[0]?.match, 'the cwd move was invisible, so the reach resolved somewhere harmless').toBe(
      FULL_ROOT_MATCH,
    );
  });

  /**
   * ...and the one grouping form whose cwd must NOT survive.
   *
   * Probed against the shipped code before this was written: NEITHER `( … )` nor
   * `{ …; }` was tracked, because `(` and `{` both became the segment HEAD and the
   * `cd` behind them was a mere argument. The subshell answer was accidentally right
   * and the brace-group answer was wrong, and no test could tell them apart — which
   * is exactly how two reviewers came to disagree about which one the code did.
   */
  it('does NOT let a subshell cd escape its own parentheses', () => {
    const hits = scanHits({
      transcript: bashSession(`cd ${UP_TO_TMP}`, '( cd vat-skill-test && ls )', REACH),
      harnessRoot: HARNESS_ROOT,
    });

    // The `cd` itself is still a reach — navigating in is not orientation — but it
    // is reported by the bare-NAME needle, which is the spelling that says the cwd
    // never carried the key. A leaked subshell cwd would report the full root.
    expect(hits.map((h) => h.match)).toEqual([VAT_HARNESS_DIR_NAME]);
  });

  it.each([
    ['a mutually exclusive || branch', ['cd .. || cd ..']],
    ['a tilde, which cannot be expanded', ['cd ~']],
    ['a tilde followed by a climb, which used to yield an EMPTY cwd', ['cd ~', 'cd ..']],
    ['a bare end-of-options marker, which goes home exactly like a bare cd', ['cd --']],
    ['the two-operand substitution form', ['cd olddir newdir']],
    ['pushd, whose move persists across Bash calls with nothing to say so', ['pushd ..']],
    ['popd', ['pushd ..', 'popd']],
    ['git -C', ['git -C ../.. status']],
    ['env -C', ['env -C ../.. ls']],
    ['make -C', ['make -C ../.. build']],
    ['tar -C', ['tar -C ../.. -xf a.tar']],
    ['find -execdir', ['find . -execdir cat {} ;']],
    ['a nested shell script we do not parse', ['bash -c "cd ../../.. && ls"']],
  ])('degrades rather than guessing on %s', (_label, steps) => {
    const scan = scanOf(bashSession(...steps, REACH_FROM_HARNESS_ROOT));

    expect(scan.degraded?.reason, 'the walk carried a cwd it could not justify').toBe(REASON_CWD_UNTRACKED);
  });

  // The idiom that must NOT degrade: the left side of a `||` always runs, so only
  // the right side is unknowable. Degrading here would cost the common case.
  it('still tracks the LEFT side of a ||', () => {
    const hits = scanHits({
      transcript: bashSession(`cd ${UP_TO_TMP}/vat-skill-test || exit 1`, REACH),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits[0]?.match).toBe(FULL_ROOT_MATCH);
  });

  // The confirmed false positive: `cd .. || cd ..` walked as if BOTH ran resolved to
  // `<cwd>/../..`, and the sibling arm is exactly two levels up — so the strongest
  // verdict this tool issues fired on a run whose cwd never moved twice.
  it('does not manufacture a sibling-arm reach out of a || chain', () => {
    const scan = scanOf(bashSession('cd .. || cd ..', 'ls 1111aaaa2222bbbb/notes.md'), {
      siblingArmDir: SIBLING_ARM,
    });

    expect(scan.hits, 'a short-circuited cd was walked as if both branches ran').toEqual([]);
  });

  // A heredoc body is DATA. Parsed as command lines it both convicted on its own
  // text AND poisoned the cwd for the whole rest of the transcript.
  it('does not parse a heredoc body as commands', () => {
    const scan = scanOf(bashSession(`cat <<EOF\ncd ${HARNESS_ROOT}\nEOF`, REACH_FROM_HARNESS_ROOT));

    expect(scan.hits).toEqual([]);
    expect(scan.degraded).toBeUndefined();
  });

  // A continuation made the path the segment HEAD, which `commandIntent` reads as
  // "executing a file by path" — so listing a file was reported as running it.
  it('joins a line continuation instead of promoting the next line to the command', () => {
    expect(
      scanHits({
        transcript: transcriptWith(`ls -la \\\n${AMBIENT_SCRIPT}`),
        harnessRoot: HARNESS_ROOT,
        executableNames: ['summary'],
      }),
    ).toEqual([]);
  });

  // `cd ~ && cd ..` produced the cwd `""`, which resolved every later relative token
  // against `/` — and reported the arm's own script as an ambient copy.
  it('does not accuse the arm of running an ambient copy of its own script after cd ~', () => {
    const scan = scanOf(bashSession('cd ~ && cd ..', 'python3 scripts/bucket-map.mjs data.csv'), {
      executableNames: [BUNDLE_NAME],
    });

    expect(scan.hits).toEqual([]);
  });
});

/**
 * ONE UNEVALUABLE `cd` USED TO DEMOLISH THE WHOLE EVAL'S STRUCTURED SCAN.
 *
 * `untracked` fired and the caller then threw away EVERY structured reach —
 * including the ones resolved before the bad `cd` — and reran the flat scanner over
 * the transcript. That is wrong in both directions at once, which is what makes it
 * worth its own block: the reaches already resolved are still validly resolved, and
 * the flat scanner it fell back to is the over-reporting instrument this whole
 * redesign replaced.
 */
describe('detectBaselineContamination — degradation runs forward, not backward', () => {
  // The reach is spelled RELATIVELY, across four calls, so no single command in the
  // transcript carries a needle: the flat fallback finds nothing here, and only a
  // structured walk that keeps what it resolved before the bad `cd` can report it.
  it('keeps a reach resolved BEFORE the cd it could not evaluate', () => {
    const scan = scanOf(bashSession(
      `cd ${UP_TO_TMP}`,
      'cd vat-skill-test',
      'cd my-skill-abc12345',
      REACH_FROM_HARNESS_ROOT,
      'cd $HOME',
    ));

    expect(scan.degraded?.reason).toBe(REASON_CWD_UNTRACKED);
    expect(scan.hits[0]?.match, 'the earlier reaches were discarded along with the later cwd').toBe(
      `${REDACTED}vat-skill-test/my-skill-abc12345`,
    );
  });

  // After the uncertainty the cwd is gone, but an ABSOLUTE path never needed one.
  it('still resolves an absolute reach AFTER the cd it could not evaluate', () => {
    const scan = scanOf(bashSession('cd $HOME', `cat ${HARNESS_ROOT}/staged/s/SKILL.md`));

    expect(scan.degraded?.reason).toBe(REASON_CWD_UNTRACKED);
    expect(scan.hits.map((h) => h.kind)).toEqual([KIND_HARNESS_PATH]);
  });

  // ...and the flat scanner's over-reporting must not come back with it. A `find`
  // that merely LISTS the temp dir names every private dir in its OUTPUT; through
  // the flat fallback that produced `vat-private-dir`, the verdict reserved for
  // "reached the held answer key", on an arm that opened nothing.
  it('does not convict a listing just because a cd earlier in the run was unevaluable', () => {
    const listing = `${HARNESS_DIR}\n${HOLD_DIR}\n${GRADER_DIR}\n`;
    const scan = scanOf(bashSession('cd $HOME', [`find ${UP_TO_TMP} -maxdepth 1 -type d`, listing]), {
      vatPrivateDirs: [HOLD_DIR, GRADER_DIR],
      siblingArmDir: SIBLING_ARM,
    });

    expect(scan.degraded?.reason).toBe(REASON_CWD_UNTRACKED);
    expect(scan.hits, 'the flat scanner came back and convicted an orientation listing').toEqual([]);
  });
});

/**
 * A Task SUBAGENT HAS ITS OWN WORKING DIRECTORY.
 *
 * `parentToolUseId` has been on every tool use since the parser was written and
 * nothing read it, so the walk mixed a subagent's `cd` into the main agent's cwd.
 * Both directions were silent: a subagent's `cd /elsewhere` re-anchored the main
 * agent's later relative paths, and a subagent's `cd $VAR` blinded the main scan.
 */
describe('detectBaselineContamination — a subagent cd does not move the main agent', () => {
  it('does not re-anchor the main agent from a subagent cd', () => {
    const scan = scanOf(agentSession(
      ['toolu_sub', `cd ${UP_TO_TMP}/vat-skill-test`],
      [null, REACH_FROM_HARNESS_DIR],
    ));

    // The subagent's own `cd` is still a reach, reported by the bare-NAME needle.
    // If the main agent had inherited that cwd its relative read would resolve under
    // the real root and be reported by the FULL-root needle instead, so the spelling
    // of the match is what discriminates.
    expect(scan.hits.map((h) => h.match), 'the main agent inherited the subagent cwd').toEqual([
      VAT_HARNESS_DIR_NAME,
    ]);
  });

  it('keeps the main agent tracked when a SUBAGENT cd is the unevaluable one', () => {
    const scan = scanOf(agentSession(
      ['toolu_sub', 'cd $SOMEWHERE'],
      [null, `cd ${UP_TO_TMP}/vat-skill-test`],
      [null, REACH_FROM_HARNESS_DIR],
    ));

    expect(scan.degraded?.reason, 'the subagent degradation must still be reported').toBe(REASON_CWD_UNTRACKED);
    expect(scan.hits[0]?.match, 'a subagent cd blinded the main agent walk').toBe(
      `${REDACTED}vat-skill-test/my-skill-abc12345`,
    );
  });
});

/**
 * `file://` IS A FILESYSTEM PATH.
 *
 * `resolvePathToken` returned `undefined` for every `scheme://`, so a `file://`
 * reach was not misfiled — it was INVISIBLE, to every signal at once, with no
 * degradation. `hits: []` from that is byte-identical to `hits: []` from a clean
 * run. The justification ("a URI is not a filesystem path") is true of `https:` and
 * false of `file:`, which is why the two rows below have to disagree.
 */
describe('detectBaselineContamination — file:// URIs', () => {
  // eslint-disable-next-line local/no-file-url-string-concat -- an inert transcript literal, not a URL anything resolves: the detector reads this string, and the point of the test is the exact spelling an arm would type
  const FILE_URL = `file://${HARNESS_ROOT}/staged/s/SKILL.md`;

  it.each([
    ['curl', `curl ${FILE_URL}`],
    ['wget', `wget ${FILE_URL}`],
  ])('fires on a %s of a file:// URL into the harness', (_label, command) => {
    const hits = scanHits({ transcript: transcriptWith(command), harnessRoot: HARNESS_ROOT });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });

  it('fires on a WebFetch of a file:// URL into the harness', () => {
    const hits = scanHits({
      transcript: toolTranscript('WebFetch', { url: FILE_URL, prompt: 'what does this say' }),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });

  // The half that must stay `undefined`: an http URL whose path happens to spell
  // vat's directory name reaches nothing on this machine.
  it('stays silent on an https URL carrying the same segments', () => {
    expect(
      scanHits({
        transcript: transcriptWith(`curl https://example.com${HARNESS_ROOT}/staged/s/SKILL.md`),
        harnessRoot: HARNESS_ROOT,
      }),
    ).toEqual([]);
  });
});

/**
 * LAUNCHER PREFIXES. Each of these resolves the head to the launcher rather than to
 * the interpreter, so the reach could never carry `retrieval` intent and the
 * executable signal — the only one that sees an ambient copy in the adopter's own
 * build output — was structurally blind to every modern way of running a script.
 */
describe('detectBaselineContamination — launcher prefixes', () => {
  it.each([
    ['uv run', `uv run ${AMBIENT_SCRIPT}`],
    ['timeout, which takes a duration first', `timeout 30 python3 ${AMBIENT_SCRIPT}`],
    ['env with an assignment', `env FOO=1 python3 ${AMBIENT_SCRIPT}`],
    ['sudo', `sudo python3 ${AMBIENT_SCRIPT}`],
    ['npx', `npx tsx ${AMBIENT_SCRIPT}`],
    ['nice with a flag and a number', `nice -n 5 node ${AMBIENT_SCRIPT}`],
    ['stdbuf', `stdbuf -oL python3 ${AMBIENT_SCRIPT}`],
  ])('sees the executable run through %s', (_label, command) => {
    const hits = scanHits({
      transcript: transcriptWith(command),
      harnessRoot: HARNESS_ROOT,
      executableNames: ['summary'],
    });

    expect(hits, `exec-blind through: ${command}`).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_DECLARED_EXECUTABLE);
  });
});

/**
 * ONE BENIGN REACH MUST NOT CLAIM THE NAME FOR THE WHOLE TRANSCRIPT.
 *
 * `structuredExecutableHits` took the FIRST escaping name-matching reach and then
 * dropped it if it had already been reported as a directory hit — never looking at
 * the ones behind it. So reading the staged copy and then RUNNING an ambient one
 * reported the read alone, while the same two commands in the opposite order
 * reported both. That is the READ-versus-RAN distinction lost to statement order,
 * and the comment three lines above the `find` said the opposite was happening.
 */
describe('detectBaselineContamination — a claimed reach does not hide the ones behind it', () => {
  it.each([
    ['read first, then ran', [`cat ${STAGED_SCRIPT}`, `python3 ${AMBIENT_SCRIPT} data.csv`]],
    ['ran first, then read', [`python3 ${AMBIENT_SCRIPT} data.csv`, `cat ${STAGED_SCRIPT}`]],
  ])('reports both the staged read and the ambient run: %s', (_label, steps) => {
    const hits = scanHits({
      transcript: bashSession(...steps),
      harnessRoot: HARNESS_ROOT,
      executableNames: ['summary'],
    });

    expect(hits.map((h) => h.kind)).toEqual([KIND_HARNESS_PATH, KIND_DECLARED_EXECUTABLE]);
  });
});

/**
 * `excerpt` IS A BOUNDED FIELD, and it was not.
 *
 * `structuredToolReaches` computed its length as "the whole tool input, if I could
 * not find the token in it" — and the token is looked for in `JSON.stringify(input)`,
 * where any value carrying a newline, a `"` or a `\` exists only in escaped form and
 * is therefore never found. One `Write` with 8 KB of content produced an
 * 8,097-character excerpt carrying a planted `AWS_SECRET_ACCESS_KEY=…` into
 * `baseline.json`, which is a file adopters attach to bug reports.
 */
describe('detectBaselineContamination — the excerpt bound is real', () => {
  const SECRET = 'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE';

  it('does not quote the whole tool input when the token cannot be located in it', () => {
    // The `"` is what defeats `indexOf` against the stringified input.
    const quotedPath = `${HARNESS_ROOT}/staged/s/SKI"LL.md`;
    // The secret sits just past where a correctly-measured token's window ends and
    // well inside where an input-sized one's does, so this row discriminates the
    // LENGTH computation and not only the clamp behind it.
    const hits = scanHits({
      transcript: toolTranscript('Read', {
        file_path: quotedPath,
        cache_key: `${'x'.repeat(60)}${SECRET}${'y'.repeat(8000)}`,
      }),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.excerpt, 'a secret from an unrelated field reached baseline.json').not.toContain(SECRET);
    expect(hits[0]?.excerpt.length ?? 0).toBeLessThan(400);
  });

  // ...and the clamp behind it, so no future caller can reopen the hole by passing a
  // length it did not measure: even a genuinely enormous TOKEN is truncated.
  it('clamps an enormous matched token rather than quoting all of it', () => {
    const hits = scanHits({
      transcript: transcriptWith(`cat ${HARNESS_ROOT}/${'d'.repeat(4000)}/SKILL.md`),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits[0]?.excerpt.length ?? 0).toBeLessThan(400);
  });

  // The excerpt's own contract, stated as a promise in `BaselineContaminationHitSchema`
  // and pinned nowhere: one line, trimmed, with `…` marking each truncated end.
  it('collapses whitespace to one line and marks both truncated ends', () => {
    const scan = scanOf(`not stream-json:\n\n   ${'p'.repeat(200)}\n  cat ${HARNESS_ROOT}/x  \n${'q'.repeat(200)}`);
    const excerpt = scan.hits[0]?.excerpt ?? '';

    expect(excerpt).not.toContain('\n');
    expect(excerpt.startsWith(EXCERPT_ELLIPSIS), `no leading marker: ${excerpt}`).toBe(true);
    expect(excerpt.endsWith(EXCERPT_ELLIPSIS), `no trailing marker: ${excerpt}`).toBe(true);
    expect(excerpt, 'the slice was not trimmed').not.toContain('  ');
  });

  // The degraded path takes its excerpt through the raw source map, and only its
  // RAWNESS was pinned — quoting the entire haystack instead was green.
  it('windows the excerpt in a degraded flat scan rather than quoting the transcript', () => {
    const scan = scanOf(`not stream-json: ${'x'.repeat(50_000)} cat ${HARNESS_ROOT}/y ${'z'.repeat(50_000)}`);

    expect(scan.degraded?.reason).toBe(REASON_UNPARSED);
    expect(scan.hits[0]?.excerpt.length ?? 0).toBeLessThan(400);
  });
});

/**
 * `match` MUST NAME NOBODY, and the two-segment rule alone did not achieve that.
 *
 * "The last two segments name nobody" is true of the default root
 * `<tmp>/vat-skill-test/<key>` and false of the ordinary `--out ~/something` shape,
 * whose last two segments ARE the login name and the output directory.
 */
describe('detectBaselineContamination — `match` names nobody', () => {
  it.each([
    ['a macOS home-rooted --out', '/Users/jeffdutton/vat-out'],
    ['a Windows home-rooted --out', 'C:/Users/jeffdutton/out'],
    ['a Linux home-rooted --out', '/home/jeffdutton/vat-out'],
  ])('masks the login name in %s', (_label, root) => {
    const hits = scanHits({
      transcript: transcriptWith(`cat ${root}/staged/s/SKILL.md`),
      harnessRoot: root,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.match, 'the operator\'s login name reached baseline.json').not.toContain('jeffdutton');
    expect(hits[0]?.match).toContain('<user>');
  });

  // The other half: a truncation with no marker reads as a whole path. The
  // two-segment SUFFIX needle is a cut of the root by construction, and it was
  // emitted bare because by the time a hit was built it looked like a complete
  // two-segment path.
  it('marks the two-segment suffix needle as truncated', () => {
    const hits = scanHits({
      transcript: transcriptWith('cat /elsewhere/vat-skill-test/my-skill-abc12345/staged/s/SKILL.md'),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits[0]?.match, 'a truncated needle was reported as if it were the whole path').toBe(
      `${REDACTED}vat-skill-test/my-skill-abc12345`,
    );
  });
});

/**
 * THE DEGRADATION DETAIL IS ATTACKER-INFLUENCED TEXT.
 *
 * `untrackedCd` builds its detail out of a raw shell token lifted from the CONTROL
 * ARM's transcript, and the harness interpolates that detail straight into
 * `process.stderr.write`. A `cd "$D<ESC>[2K<CR><ESC>[32m…"` therefore erased the
 * "contamination scan DEGRADED" line vat had just written and re-rendered it in
 * green as vat's own voice — terminal forgery on the exact warning that says the
 * scan went blind. Sanitizing at the STDERR write would not close it: vat attaches
 * `degraded` to the eval fragment after `parseEvalFragment` has already sanitized
 * it, so the raw bytes would still land in `baseline.json`.
 */
describe('detectBaselineContamination — a degradation detail cannot forge a terminal line', () => {
  // Built with `String.fromCharCode`: a `\u`-style escape typed into a source file
  // in this module family is normalized into a literal control byte on the way in,
  // which defeats grep and breaks exact-match editing.
  const ESC = String.fromCharCode(27);
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const FORGERY = `$D${ESC}[2K${CR}${ESC}[32mvat: control arm verified clean${ESC}[0m${LF}second line`;

  it('strips escape, carriage-return and newline from a transcript-derived detail', () => {
    const scan = scanOf(bashSession(`cd "${FORGERY}"`, READ_SKILL_MD));
    const detail = scan.degraded?.detail ?? '';

    expect(scan.degraded?.reason).toBe(REASON_CWD_UNTRACKED);
    expect(detail, 'an ESC survived into the degradation detail').not.toContain(ESC);
    expect(detail, 'a CR survived into the degradation detail').not.toContain(CR);
    expect(detail, 'a newline survived into the degradation detail').not.toContain(LF);
  });
});

/**
 * A DROPPED TRANSCRIPT LINE IS A HOLE IN THE SCAN, and nothing said so.
 *
 * `parseStreamJsonTranscript` skips an unparseable line silently, the surviving
 * lines still decode, and `transcriptDecoded` — an any-of test satisfied by the
 * terminal `result` line alone — still returns true. So one corrupted tool call
 * DELETED a contamination hit and the verdict read `contaminated: false` from a scan
 * that never saw the evidence.
 */
describe('detectBaselineContamination — a transcript with holes in it', () => {
  it('degrades when a transcript line failed to parse', () => {
    const lines = bashSession(`cat ${HARNESS_ROOT}/staged/s/SKILL.md`).split('\n');
    lines.splice(1, 0, '{"type":"assistant","message":{"content":[{"type":"tool_use"');
    const scan = scanOf(lines.join('\n'));

    expect(scan.degraded?.reason, 'a dropped line produced a confident clean scan').toBe('transcript-malformed');
    expect(scan.hits.map((h) => h.kind), 'the surviving evidence was thrown away too').toEqual([KIND_HARNESS_PATH]);
  });

  it('does not degrade a transcript whose every line parsed', () => {
    expect(scanOf(bashSession('ls -la')).degraded).toBeUndefined();
  });
});

/**
 * THE CONSTRUCTS THE SUITE WAS NOT STANDING ON.
 *
 * Each of these was a surviving mutant: deleting or inverting the thing under test
 * left the whole suite green, so nothing distinguished "this rule is load-bearing"
 * from "this rule is decoration". Every row below is the one fixture that tells them
 * apart; the constructs that turned out to be genuinely dead were deleted instead,
 * with the measurement recorded at the deletion site.
 */
describe('detectBaselineContamination — constructs nothing was standing on', () => {
  // siblingArmNeedles ships TWO needles and the suite only ever proved "at least one
  // matched" — dropping either, or swapping their order, was green.
  it('finds a sibling reach that names only the per-arm token', () => {
    const scan = scanOf('not stream-json: cat ../../1111aaaa2222bbbb/lookup-1/answer.md', {
      siblingArmDir: SIBLING_ARM,
    });

    expect(scan.hits.map((h) => h.kind)).toEqual([KIND_SIBLING_ARM]);
    expect(scan.hits[0]?.match, 'the bare-token needle is what a relative reach needs').toBe('1111aaaa2222bbbb');
  });

  it('reports an absolute sibling reach at its most specific spelling', () => {
    const scan = scanOf(`not stream-json: cat ${SIBLING_ARM}/lookup-1/answer.md`, { siblingArmDir: SIBLING_ARM });

    expect(scan.hits[0]?.match, 'needles ran shortest-first, so the reach lost its specific spelling').toBe(
      `${REDACTED}vat-skill-test-ws-abc/1111aaaa2222bbbb`,
    );
  });

  // ENUMERATION_COMMANDS' only consumer is that it is tested BEFORE the
  // head-is-a-path branch. An interpreter-shaped path as the head is what separates
  // them, and no fixture used one.
  it.each([
    ['listing a file through an absolute ls', `/bin/ls -l ${AMBIENT_SCRIPT}`, 0],
    ['reading one through an absolute cat', `/bin/cat ${AMBIENT_SCRIPT}`, 1],
  ])('tells enumeration from retrieval when the head is a path: %s', (_label, command, expected) => {
    expect(
      scanHits({ transcript: transcriptWith(command), harnessRoot: HARNESS_ROOT, executableNames: ['summary'] }),
    ).toHaveLength(expected);
  });

  // An unknown tool under a field name that says nothing about paths: the value has
  // to earn candidacy by being a LONE TOKEN, since every confirmed false positive in
  // this class was a path embedded in a sentence.
  it.each([
    ['a lone path token under an unrecognised field name', `${HARNESS_ROOT}/staged/s/SKILL.md`, 1],
    ['the same path inside a sentence', `I looked under ${HARNESS_ROOT} and found nothing`, 0],
  ])('judges an unknown field by its value shape: %s', (_label, blob, expected) => {
    expect(
      scanHits({ transcript: toolTranscript('SomeFutureThing', { blob }), harnessRoot: HARNESS_ROOT }),
    ).toHaveLength(expected);
  });

  // A `grep -e <pattern>` carries the pattern on the FLAG, so the first operand is
  // the file after all and must not be skipped as prose.
  it('does not skip the first operand when a flag carried the pattern', () => {
    const hits = scanHits({
      transcript: transcriptWith(`grep -e "bucket" ${HARNESS_ROOT}/staged/s/SKILL.md`),
      harnessRoot: HARNESS_ROOT,
    });

    expect(hits.map((h) => h.kind)).toEqual([KIND_HARNESS_PATH]);
  });

  // A command substitution's expansion is unknowable, so the TOKEN is left
  // `$`-rooted — but the commands inside it really ran, and swallowing the whole
  // thing hid them.
  it('walks the commands inside a substitution', () => {
    const hits = scanHits({
      transcript: transcriptWith(`echo done $(cat ${AMBIENT_SCRIPT})`),
      harnessRoot: HARNESS_ROOT,
      executableNames: ['summary'],
    });

    expect(hits.map((h) => h.kind)).toEqual([KIND_DECLARED_EXECUTABLE]);
    expect(hits[0]?.excerpt, 'the excerpt was rebased onto the wrong text').toContain('$(cat');
  });

  // ...while a `cd` inside one cannot move the caller, which is what subshell means.
  it('does not let a cd inside a substitution move the caller', () => {
    const scan = scanOf(bashSession(`echo $(cd ${UP_TO_TMP}/vat-skill-test && pwd)`, READ_SKILL_MD));

    expect(scan.degraded).toBeUndefined();
    expect(scan.hits.map((h) => h.match), 'the substitution leaked its cwd').toEqual([VAT_HARNESS_DIR_NAME]);
  });

  // `< file` feeds a file's content to whatever runs. The branch had no fixture.
  it('reads intent from an input redirect when the command is unknown', () => {
    const hits = scanHits({
      transcript: transcriptWith(`somecmd --flag < ${AMBIENT_SCRIPT}`),
      harnessRoot: HARNESS_ROOT,
      executableNames: ['summary'],
    });

    expect(hits.map((h) => h.kind)).toEqual([KIND_DECLARED_EXECUTABLE]);
  });

  // Workspace containment is a path-BOUNDARY test, not a prefix test.
  it('does not treat a sibling sharing the workspace name prefix as the arm\'s own tree', () => {
    const hits = scanHits({
      transcript: transcriptWith(`node ${ARM_WORKSPACE}-other/scripts/summary.mjs`),
      harnessRoot: HARNESS_ROOT,
      executableNames: ['summary'],
    });

    expect(hits.map((h) => h.kind)).toEqual([KIND_DECLARED_EXECUTABLE]);
  });

  it('does not fire on a path that IS the arm workspace root', () => {
    const workspace = `${WS_ROOT}/summary`;

    expect(
      detectBaselineContamination({
        transcript: transcriptWith(`cat ${workspace}`),
        harnessRoot: HARNESS_ROOT,
        armWorkspaceDir: workspace,
        armCwd: `${workspace}/e1`,
        executableNames: ['summary'],
      }).hits,
    ).toEqual([]);
  });

  // The `..`-beyond-root clamp, which is what a real filesystem does and what keeps
  // an over-climb from producing a path no needle can see.
  // ⚠️ ASSERTED THROUGH THE WORKSPACE PREDICATE, which is the only PREFIX test in
  // the module and therefore the only thing that can see where a climb landed.
  // Every needle is a path SUFFIX, and a relative reach reproduces the same suffix
  // under any cwd — so `cat <root-relative path>` after an over-climb reports
  // identically whether the climb worked or was a no-op. Containment does not: a
  // relative script run from `/` is outside the arm's tree, and one from the arm's
  // own cwd is not.
  it('clamps a climb past the filesystem root instead of staying put', () => {
    const hits = scanHits({
      transcript: bashSession('cd ../../../../../../../..', 'python3 s/summary.mjs data.csv'),
      harnessRoot: HARNESS_ROOT,
      executableNames: ['summary'],
    });

    expect(hits.map((h) => h.kind), 'the climb never moved, so the reach read as the arm\'s own file').toEqual([
      KIND_DECLARED_EXECUTABLE,
    ]);
  });

  // The `//` run-collapse, in both the function that builds needles and the one that
  // builds haystacks. A JSON-escaped Windows path is where the doubling comes from,
  // and the existing Windows fixture used single backslashes, which never doubles.
  it('folds a doubled separator out of a needle', () => {
    expect(harnessNeedles(String.raw`C:\\repo\\vat-skill-test\\key`).map((n) => n.needle)[0])
      .toBe('c:/repo/vat-skill-test/key');
  });

  // ⚠️ ASSERTED ON THE `match` SPELLING, not on the kind. The bare-NAME needle
  // (`vat-skill-test`) still matches `c://repo//vat-skill-test//staged` without the
  // collapse — its boundaries are slashes either way — so a kind-only assertion
  // passes for the wrong reason. Only the two-segment and full-root needles need the
  // doubled separators folded away.
  it('matches a JSON-escaped Windows path in the flat fallback', () => {
    const scan = scanOf(
      String.raw`not stream-json: {"command":"type C:\\repo\\vat-skill-test\\my-skill-abc12345\\staged\\SKILL.md"}`,
      { harnessRoot: 'C:/repo/vat-skill-test/my-skill-abc12345' },
    );

    expect(scan.hits[0]?.match).toBe(`${REDACTED}vat-skill-test/my-skill-abc12345`);
  });

  // `toLowerCase` changes LENGTH for U+0130, which desynchronizes the raw source
  // map. The map is dropped rather than skewed — a skewed one points at the wrong
  // bytes while looking precise. 400 of them puts the skew past the whole excerpt
  // window, so a skewed map cannot accidentally still land on the match; at 200 it
  // did, and the test passed for the wrong reason.
  it('drops the raw source map rather than skewing it when case folding changes length', () => {
    const scan = scanOf(`not stream-json: ${'\u0130'.repeat(400)} cat ${HARNESS_ROOT}/staged/S/SKILL.md`);

    expect(scan.hits).toHaveLength(1);
    expect(scan.hits[0]?.excerpt, 'the excerpt addressed the wrong bytes').toContain('vat-skill-test');
  });

  // The boundary rescan: the FIRST occurrence of a needle can fail the trailing
  // boundary while a later one passes, and no fixture had both. Asserted on the
  // `match` spelling for the same reason as the collapse row above — the bare-NAME
  // needle matches inside the rejected occurrence too, so a kind-only assertion
  // cannot see whether the scan gave up on the specific needles.
  it('keeps scanning past an occurrence that failed the path boundary', () => {
    const scan = scanOf(
      `not stream-json: ${HARNESS_ROOT}x is a different directory, but ${HARNESS_ROOT}/staged/s/SKILL.md is not`,
    );

    expect(scan.hits[0]?.match).toBe(`${REDACTED}vat-skill-test/my-skill-abc12345`);
  });
});

describe('scrubControlArmEnv — the exemption rules nothing was standing on', () => {
  // `!forbiddenKey` looked unreachable because CLAUDE_PLUGIN_ROOT is not in
  // `protectedEnvNames` — but `modelVars` is CALLER-SUPPLIED and lands in that set
  // verbatim, so a run declaring it as a model var would hand the control arm the
  // staged plugin root. Rule 1 wins outright.
  it('drops CLAUDE_PLUGIN_ROOT even when the run declares it as a model var', () => {
    const result = scrubControlArmEnv(
      { CLAUDE_PLUGIN_ROOT: `${HARNESS_ROOT}/staged/s` },
      HARNESS_ROOT,
      ['CLAUDE_PLUGIN_ROOT'],
    );

    expect(result.env.CLAUDE_PLUGIN_ROOT).toBeUndefined();
    expect(result.droppedForbiddenKey).toEqual(['CLAUDE_PLUGIN_ROOT']);
  });

  // `isProtectedName` rather than `protectedNames.has` — the win32 case-insensitive
  // lookup the comment cites, which was unexercised on every platform CI runs.
  it.each([
    ['win32, where env names are case-insensitive', 'win32', ['Home'], []],
    ['linux, where they are not', 'linux', [], ['Home']],
  ])('resolves a differently-cased protected name per platform: %s', (_label, platform, retained, dropped) => {
    const result = scrubControlArmEnv({ Home: `${HARNESS_ROOT}/home` }, HARNESS_ROOT, [], platform);

    expect(result.retainedLeaks).toEqual(retained);
    expect(result.droppedNamingRoot).toEqual(dropped);
  });
});

/**
 * A RUN WHERE NOTHING WAS SCANNED MUST NOT OPEN WITH A CLEAN BILL OF HEALTH.
 *
 * Confirmed on a real run where both control arms died on an executor timeout, so
 * zero transcripts reached the detector. `baseline.json` still led with "No
 * skill-absent eval was observed reaching the skill. The A/B delta is interpretable
 * as instruction lift" and put `CONTROL ARM DID NOT RUN` third — the reader met the
 * reassurance before the retraction. `contaminated: false` from a run that looked at
 * nothing is written with exactly the same bytes as one that looked properly, which
 * is the failure mode this whole module exists to prevent, reproduced at the summary
 * layer.
 */
describe('summarizeBaselineIntegrity — a run where no control arm was scanned', () => {
  const DEAD_ARMS = [
    { evalId: 'lookup-1', detail: 'control executor timed out after 600s' },
    { evalId: 'lookup-2', detail: 'control executor timed out after 600s' },
  ];

  // `signals: []` is what the harness now passes when no control transcript was
  // produced; the two halves of the fix have to read as ONE sentence.
  const blind = (): BaselineIntegrity =>
    summarize({ observedEvals: 0, signals: [], controlArmFailures: DEAD_ARMS });

  it('leads with the absence instead of with a positive observation', () => {
    const { summary } = blind();

    expect(summary.startsWith('NOT CHECKED'), summary).toBe(true);
    expect(summary, 'a claim about an observation that never happened').not.toContain('was observed reaching');
    expect(summary, 'there is no delta to interpret when no control arm ran')
      .not.toContain('interpretable as instruction lift');
  });

  it('states the dead control arm before the skew it causes', () => {
    // A dead control arm also shows up as skew, so both notes are present and their
    // ORDER is the thing: the skew sentence sends triage at the grader prompt for a
    // run whose grader never got to speak.
    const { summary } = summarize({
      observedEvals: 0,
      signals: [],
      controlArmFailures: DEAD_ARMS,
      skew: [{ evalId: 'lookup-1', withTotal: 3, withoutTotal: 0 }],
    });

    expect(summary.indexOf('CONTROL ARM DID NOT RUN')).toBeLessThan(summary.indexOf('ARMS NOT COMPARABLE'));
    expect(summary, 'the two halves of the fix must compose into one sentence, not two corrections')
      .toContain('NO detector was armed for this run');
  });

  // The converse, so the block is a discriminator rather than a constant: a run that
  // DID scan keeps the sentence it has always had.
  it('keeps the observed-and-clean wording when evals really were scanned', () => {
    const { summary } = summarize();

    expect(summary.startsWith('No skill-absent eval was observed reaching the skill'), summary).toBe(true);
    expect(summary).not.toContain('NOT CHECKED');
  });

  it('is still schema-valid and still reports contaminated: false', () => {
    const integrity = blind();

    expect(integrity.contaminated).toBe(false);
    expect(BaselineIntegritySchema.safeParse(integrity).success).toBe(true);
  });
});
