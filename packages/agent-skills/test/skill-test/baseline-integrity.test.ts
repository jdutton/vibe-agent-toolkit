import { describe, expect, it } from 'vitest';

import {
  activeContaminationSignals,
  BaselineIntegritySchema,
  detectBaselineContamination,
  harnessNeedles,
  siblingArmNeedles,
  vatPrivateDirNeedles,
  type ContaminationSignal,
  scrubControlArmEnv,
  summarizeBaselineIntegrity,
  type BaselineContamination,
} from '../../src/skill-test/baseline-integrity.js';
import { resolveHarnessRoot } from '../../src/skill-test/harness-location.js';
import { resolveHarnessLocation } from '../../src/skill-test/run-harness.js';

// A synthetic path used only as a string needle for the detector — nothing is
// read or written here, so the publicly-writable-directory concern does not apply.
// eslint-disable-next-line sonarjs/publicly-writable-directories -- inert test literal; the detector is a pure string scan
const HARNESS_ROOT = '/tmp/vat-skill-test/my-skill-abc12345';
const BUNDLE_NAME = 'bucket-map';
const EXCERPT_ELLIPSIS = '…';
const KIND_HARNESS_PATH = 'harness-path' as const;
const KIND_DECLARED_EXECUTABLE = 'declared-executable' as const;
const KIND_SIBLING_ARM = 'sibling-arm' as const;
const KIND_VAT_PRIVATE_DIR = 'vat-private-dir' as const;
const ALL_SIGNALS: ContaminationSignal[] = [KIND_HARNESS_PATH, KIND_SIBLING_ARM, KIND_VAT_PRIVATE_DIR, KIND_DECLARED_EXECUTABLE];
// A workspaces-root path: under the tmp root like the real one, but deliberately
// NOT under HARNESS_ROOT — the control arm must keep its own fixtures.
// eslint-disable-next-line sonarjs/publicly-writable-directories -- inert test literal; nothing is read or written
const WS_FIXTURES = '/tmp/vat-skill-test-ws-abc/eval-1/fixtures';

/** A stream-json-ish transcript line carrying `text` as tool input. */
function transcriptWith(text: string): string {
  return [
    '{"type":"system","subtype":"init"}',
    `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":${JSON.stringify(text)}}}]}}`,
    '{"type":"result","subtype":"success"}',
  ].join('\n');
}

describe('detectBaselineContamination', () => {
  it('returns no hits for a clean skill-absent transcript', () => {
    const transcript = transcriptWith('ls -la && cat README.md');
    expect(detectBaselineContamination({ transcript, harnessRoot: HARNESS_ROOT })).toEqual([]);
  });

  // The signal that matters: the control arm reached into vat's own staged trees.
  // Nothing points it there any more, so a mention means it went looking.
  it('flags a transcript that names a path under the harness root', () => {
    const transcript = transcriptWith(`node ${HARNESS_ROOT}/staged/my-skill/scripts/bundle.mjs lookup`);
    const hits = detectBaselineContamination({ transcript, harnessRoot: HARNESS_ROOT });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
    expect(hits[0]?.match).toBe(HARNESS_ROOT);
    expect(hits[0]?.excerpt).toContain('bundle.mjs');
  });

  // The case vat cannot prevent: an ambient copy in the adopter's own repo or
  // plugin cache. No harness path appears, but the declared executable does.
  it('flags a declared executable run from a path vat does not own', () => {
    const transcript = transcriptWith('node ./dist/skills/my-skill/scripts/bucket-map.mjs "source"');
    const hits = detectBaselineContamination({
      transcript,
      harnessRoot: HARNESS_ROOT,
      executableNames: [BUNDLE_NAME],
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_DECLARED_EXECUTABLE);
    expect(hits[0]?.match).toBe(BUNDLE_NAME);
  });

  it('does not double-count one reach as both a harness path and an executable', () => {
    const transcript = transcriptWith(`node ${HARNESS_ROOT}/staged/s/scripts/bucket-map.mjs x`);
    const hits = detectBaselineContamination({
      transcript,
      harnessRoot: HARNESS_ROOT,
      executableNames: [BUNDLE_NAME],
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });

  // A 1-2 char name occurs constantly in ordinary JSON and prose; matching it
  // would fire on every run and train the operator to ignore the warning.
  it('skips executable names too short to be a real signal', () => {
    const transcript = transcriptWith('echo "a b c" | wc -l');
    expect(
      detectBaselineContamination({ transcript, harnessRoot: HARNESS_ROOT, executableNames: ['wc', 'a'] }),
    ).toEqual([]);
  });

  it('bounds the excerpt so a huge tool result cannot bloat baseline.json', () => {
    const transcript = transcriptWith(`${'x'.repeat(50_000)} ${HARNESS_ROOT} ${'y'.repeat(50_000)}`);
    const hits = detectBaselineContamination({ transcript, harnessRoot: HARNESS_ROOT });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.excerpt.length ?? 0).toBeLessThan(HARNESS_ROOT.length + 200);
    expect(hits[0]?.excerpt.length ?? 0).toBeGreaterThan(0);
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
    const transcript = transcriptWith(`cat ${real}/staged/my-skill/SKILL.md`);

    expect(detectBaselineContamination({ transcript, harnessRoot: real })).toHaveLength(1);
  });

  // Windows: safePath.join forward-slashes every path VAT derives, while the
  // child's output is backslashed — and stream-json ESCAPES those, so the raw
  // transcript holds doubled backslashes. A literal indexOf can never match.
  it('fires on a Windows-shaped, JSON-escaped backslash path', () => {
    const harnessRoot = 'C:/Users/dev/AppData/Local/Temp/vat-skill-test/my-skill-1a2b3c4d';
    const native = String.raw`C:\Users\dev\AppData\Local\Temp\vat-skill-test\my-skill-1a2b3c4d\staged\s\SKILL.md`;
    // JSON.stringify doubles each backslash, exactly as the real transcript carries it.
    const escaped = JSON.stringify(`type ${native}`);
    const transcript = `{"type":"assistant","text":${escaped}}`;

    expect(transcript).toContain(String.raw`\\`); // the escaping is really present
    expect(detectBaselineContamination({ transcript, harnessRoot })).toHaveLength(1);
  });

  // macOS: VAT derives /private/var/... (realpath) but $TMPDIR — which IS on the
  // child env allowlist — hands the arm /var/..., so the arm reports the one
  // spelling the needle does not contain.
  it('fires when the arm reports the non-realpath $TMPDIR spelling', () => {
    const harnessRoot = '/private/var/folders/2k/abc/T/vat-skill-test/my-skill-830fad22';
    const transcript = transcriptWith('find /var/folders/2k/abc/T/vat-skill-test/my-skill-830fad22 -name SKILL.md');

    expect(detectBaselineContamination({ transcript, harnessRoot })).toHaveLength(1);
  });

  it('fires on a relative reach that never names the absolute root', () => {
    const harnessRoot = HARNESS_ROOT;
    const transcript = transcriptWith('cat ../vat-skill-test/my-skill-abc12345/staged/s/SKILL.md');

    expect(transcript).not.toContain(harnessRoot);
    expect(detectBaselineContamination({ transcript, harnessRoot })).toHaveLength(1);
  });

  // A relative --out used to become the needle verbatim, so a two-character
  // string matched almost any transcript and every eval reported contaminated.
  it('does not fire on an unrelated transcript when --out was relative', () => {
    const { harnessRoot } = resolveHarnessLocation({ subject: 'demo', out: './out' });
    const transcript = transcriptWith('echo "the output is ready" > ./notes.md');

    expect(harnessRoot.startsWith('/') || /^[A-Za-z]:/.test(harnessRoot)).toBe(true);
    expect(detectBaselineContamination({ transcript, harnessRoot })).toEqual([]);
  });

  // THE GLOB CLASS. Both the absolute and the two-segment suffix needle require
  // the arm to spell the 8-hex harness key, which it has no way to know and no
  // reason to type — every natural reach enumerates instead. One `*` defeated the
  // entire scheme, so a reach that lands squarely in the staged tree read clean.
  it.each([
    ['a glob', 'cat ../../vat-skill-test/*/staged/s/SKILL.md'],
    ['a recursive glob', 'cat ../../vat-skill-test/**/SKILL.md'],
    ['find', 'find ../../vat-skill-test -name SKILL.md -exec cat {} +'],
    ['a shell variable', 'K=$(ls ../../vat-skill-test); cat ../../vat-skill-test/$K/staged/s/SKILL.md'],
    ['$TMPDIR plus a glob', 'cat $TMPDIR/vat-skill-test/*/staged/s/SKILL.md'],
    ['a recursive listing', 'ls -R ../../vat-skill-test'],
  ])('fires on a reach that never names the harness key: %s', (_label, command) => {
    const harnessRoot = HARNESS_ROOT;
    const hits = detectBaselineContamination({ transcript: transcriptWith(command), harnessRoot });

    expect(hits, `read clean: ${command}`).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_HARNESS_PATH);
  });

  // ...while the control arm's OWN cwd lives at vat-skill-test-ws-<token>, which
  // shares that prefix and must never be evidence against it. This is the
  // constraint the needle above is boundary-matched to preserve.
  it('does not fire on the control arm working in its own legitimate workspace', () => {
    const transcript = transcriptWith(
      'ls /private/var/folders/2k/abc/T/vat-skill-test-ws-9f3c1b/without/lookup-1 && cat data.csv',
    );

    expect(detectBaselineContamination({ transcript, harnessRoot: HARNESS_ROOT })).toEqual([]);
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
    /* eslint-disable sonarjs/publicly-writable-directories -- inert test literals; the detector is a pure string scan, nothing is read or written */
    ['/tmp/out', 'wc -l /tmp/output.csv'],
    ['/tmp/hold', 'reading /tmp/holdings.csv now'],
    ['/tmp/vat-run', 'ls /tmp/vat-runner-cache'],
    /* eslint-enable sonarjs/publicly-writable-directories */
  ])('does not fire mid-segment for --out %s', (out, command) => {
    expect(harnessNeedles(out).length, 'row is vacuous: no needle to match').toBeGreaterThan(0);
    expect(detectBaselineContamination({ transcript: transcriptWith(command), harnessRoot: out })).toEqual([]);
  });

  // The floor that used to live in harnessNeedles silently produced ZERO needles
  // for a short root, disabling the harness-path check while the verdict still read
  // "checked and clean". An absolute reach into the staged tree must still fire.
  it('still detects an absolute reach under a very short --out', () => {
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- inert test literal
    const harnessRoot = '/tmp/x';
    const hits = detectBaselineContamination({
      transcript: transcriptWith(`cat ${harnessRoot}/staged/my-skill/SKILL.md`),
      harnessRoot,
    });

    expect(harnessNeedles(harnessRoot).length, 'a short root produced no needles at all').toBeGreaterThan(0);
    expect(hits).toHaveLength(1);
  });

  // THE `ls` FALSE POSITIVE. The arm's cwd is <tmp>/vat-skill-test-ws-<token>/…, so
  // looking around prints `vat-skill-test` as a bare basename on its own line. A
  // newline is not a segment-continuation char, so the TRAILING boundary accepts it;
  // only requiring a LEADING `/` on a bare-name needle rejects it. The arm saw a
  // directory name — it did not read the skill.
  it.each([
    ['ls three levels up', 'ls ../../..'],
    ['ls $TMPDIR filtered', 'ls -1 $TMPDIR | grep vat'],
    ['a long listing', 'ls -la $TMPDIR'],
  ])('does not fire when the arm merely LISTS a directory containing the harness: %s', (_label, command) => {
    const transcript = `{"type":"user","message":{"content":[{"type":"tool_result","content":${JSON.stringify(
      `${command}\nvat-skill-evals-9f3c\nvat-skill-grade-9f3c\nvat-skill-test\nvat-skill-test-ws-9f3c\n`,
    )}}]}}`;

    expect(detectBaselineContamination({ transcript, harnessRoot: HARNESS_ROOT })).toEqual([]);
  });

  // ...and vat tested on a checkout of ITSELF must not self-incriminate: this repo
  // carries the literal `vat-skill-test` in ~10 tracked source and doc files.
  it('does not fire on vat\'s own source text when vat is tested on itself', () => {
    const transcript = transcriptWith(
      "grep -rn vat-skill-test src | head -1 && echo \"harness-location.ts:38: safePath.join(base, 'vat-skill-test', key)\"",
    );

    expect(detectBaselineContamination({ transcript, harnessRoot: HARNESS_ROOT })).toEqual([]);
  });

  // Round 3 made the case-fold unconditional and did not audit its consumers: the
  // dedupe compared a RAW declared name against a now-always-lowercased excerpt, so
  // any name with a capital double-counted one reach as two hits.
  it('does not double-count a mixed-case executable reached via a harness path', () => {
    const hits = detectBaselineContamination({
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

    expect(detectBaselineContamination({ transcript, harnessRoot })).toHaveLength(1);
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
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- inert test literal; the detector is a pure string scan
  const WS_ROOT = '/tmp/vat-skill-test-ws-abc';
  const SIBLING = `${WS_ROOT}/1111aaaa2222bbbb`;

  it.each([
    ['relative reach', 'cat ../1111aaaa2222bbbb/e1/answer.md'],
    ['absolute reach', `cat ${SIBLING}/e1/answer.md`],
    ['a find that printed it', 'find .. -name "*.md" -> ../1111aaaa2222bbbb/e1/out.md'],
  ])('fires on a %s into the other arm', (_label, command) => {
    const hits = detectBaselineContamination({
      transcript: transcriptWith(command),
      harnessRoot: HARNESS_ROOT,
      siblingArmDir: SIBLING,
    });
    expect(hits, `read clean: ${command}`).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_SIBLING_ARM);
  });

  // `ls ..` prints the sibling's directory name as a bare basename on its own
  // line. That is "where am I" — an agent's most common opening move — not "I read
  // the other arm", and stamping it contaminated would train operators to ignore
  // the flag. The leading-`/` rule is what separates the two.
  it('does not fire when the arm merely LISTED its parent', () => {
    const transcript = transcriptWith('ls ..\n1111aaaa2222bbbb\n3333cccc4444dddd\n');

    expect(
      detectBaselineContamination({ transcript, harnessRoot: HARNESS_ROOT, siblingArmDir: SIBLING }),
    ).toEqual([]);
  });

  // Its own workspace is where it is supposed to be working.
  it('does not fire on the arm working in its own directory', () => {
    const transcript = transcriptWith(`cd ${WS_ROOT}/3333cccc4444dddd/e1 && cat data.csv`);

    expect(
      detectBaselineContamination({ transcript, harnessRoot: HARNESS_ROOT, siblingArmDir: SIBLING }),
    ).toEqual([]);
  });

  // Absent for the WITH arm (it has no sibling worth naming) — the needle set must
  // then be empty rather than matching everything.
  it('is inert when no sibling is supplied', () => {
    expect(siblingArmNeedles('')).toEqual([]);
    expect(
      detectBaselineContamination({
        transcript: transcriptWith(`cat ${SIBLING}/e1/answer.md`),
        harnessRoot: HARNESS_ROOT,
      }),
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
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- inert test literal; the detector is a pure string scan
  const HOLD_DIR = '/tmp/vat-skill-evals-1111aaaa2222bbbb';
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- inert test literal; the detector is a pure string scan
  const GRADER_DIR = '/tmp/vat-skill-grade-3333cccc4444dddd';

  it.each([
    ['the absolute path', `cat ${HOLD_DIR}/evals.json`],
    // The load-bearing case. The token is 16 random hex the arm cannot know, so
    // every reach it can actually TYPE enumerates or globs — and a glob contains
    // neither the full path nor the token, which is what defeats a suffix needle.
    ['a glob over the temp dir', 'cat /tmp/vat-skill-evals-*/evals.json'],
    ['a relative climb', 'cat ../../vat-skill-evals-1111aaaa2222bbbb/evals.json'],
    ['a find that printed it', 'find /tmp -name evals.json -> /tmp/vat-skill-evals-1111aaaa2222bbbb/evals.json'],
  ])('fires on %s into the held answer key', (_label, command) => {
    const hits = detectBaselineContamination({
      transcript: transcriptWith(command),
      harnessRoot: HARNESS_ROOT,
      vatPrivateDirs: [HOLD_DIR, GRADER_DIR],
    });
    expect(hits, `read clean: ${command}`).toHaveLength(1);
    expect(hits[0]?.kind).toBe(KIND_VAT_PRIVATE_DIR);
  });

  // Same rule that keeps the bare `vat-skill-test` needle honest: a directory
  // LISTING prints the name with nothing before it. "Where am I" is not "I read
  // the answer key", and flagging it would train operators to ignore the flag.
  it('does not fire when the arm merely LISTED the temp dir', () => {
    const transcript = transcriptWith('ls /tmp\nvat-skill-evals-1111aaaa2222bbbb\nvat-skill-grade-3333cccc4444dddd\n');

    expect(
      detectBaselineContamination({ transcript, harnessRoot: HARNESS_ROOT, vatPrivateDirs: [HOLD_DIR, GRADER_DIR] }),
    ).toEqual([]);
  });

  // The prefix needle is only safe for a dir the arm has no business naming. Its
  // OWN workspace root shares the `vat-skill-` stem and its absolute path is in
  // the arm's own prompt, so a needle built from it would fire on every clean run.
  it('does not fire on the arm working in its own workspace', () => {
    const transcript = transcriptWith('cd /tmp/vat-skill-test-ws-abc/3333cccc4444dddd/e1 && cat data.csv');

    expect(
      detectBaselineContamination({ transcript, harnessRoot: HARNESS_ROOT, vatPrivateDirs: [HOLD_DIR, GRADER_DIR] }),
    ).toEqual([]);
  });

  // Two different capabilities — reading the answer key and reading the nonce —
  // so an operator triaging a contaminated run must see both, not the first.
  it('reports the answer-key dir and the grader dir separately', () => {
    const hits = detectBaselineContamination({
      transcript: transcriptWith(`cat ${HOLD_DIR}/evals.json && ls ${GRADER_DIR}`),
      harnessRoot: HARNESS_ROOT,
      vatPrivateDirs: [HOLD_DIR, GRADER_DIR],
    });

    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.kind)).toEqual([KIND_VAT_PRIVATE_DIR, KIND_VAT_PRIVATE_DIR]);
  });

  it('is inert when no private dirs are supplied', () => {
    expect(vatPrivateDirNeedles('')).toEqual([]);
    expect(
      detectBaselineContamination({
        transcript: transcriptWith(`cat ${HOLD_DIR}/evals.json`),
        harnessRoot: HARNESS_ROOT,
      }),
    ).toEqual([]);
  });

  it('builds full, name and prefix needles, longest first', () => {
    expect(vatPrivateDirNeedles(HOLD_DIR)).toEqual([
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
    const transcript = transcriptWith('I read the CSV and wrote a summary of the totals.');

    expect(
      detectBaselineContamination({ transcript, harnessRoot: HARNESS_ROOT, executableNames: ['summary', 'totals'] }),
    ).toEqual([]);
  });

  it('fires when the name is invoked as a path or carries an extension', () => {
    for (const command of ['node ./scripts/summary.mjs x', 'python3 summary.py', 'bash ../bin/summary']) {
      const hits = detectBaselineContamination({
        transcript: transcriptWith(command),
        harnessRoot: HARNESS_ROOT,
        executableNames: ['summary'],
      });
      expect(hits, `expected a hit for: ${command}`).toHaveLength(1);
      expect(hits[0]?.kind).toBe(KIND_DECLARED_EXECUTABLE);
    }
  });
});

describe('scrubControlArmEnv', () => {
  // The channel the first fix missed: prompt, argv and cwd were closed while the
  // run's single assembled env — CLAUDE_PLUGIN_ROOT included — went to both arms.
  it('drops CLAUDE_PLUGIN_ROOT and any value containing the harness root', () => {
    const { env, dropped } = scrubControlArmEnv(
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
    expect([...dropped].sort((a: string, b: string) => a.localeCompare(b))).toEqual(['CLAUDE_PLUGIN_ROOT', 'SNAPSHOT']);
    // The arms must stay identical in everything except the skill: the control
    // keeps its own fixtures (under the workspaces root) and its auth.
    expect(env['FIXTURES']).toBe(WS_FIXTURES);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-test');
  });

  it('drops a value that names the harness root in the other separator form', () => {
    const { dropped } = scrubControlArmEnv(
      { WIN: String.raw`C:\tmp\vat-skill-test\s\x` },
      'C:/tmp/vat-skill-test/s',
      [],
    );
    expect(dropped).toEqual(['WIN']);
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
    const { env, dropped } = scrubControlArmEnv(
      { CLAUDE_PLUGIN_ROOT: '/Users/dev/.claude/plugins/marketplaces/acme' },
      HARNESS_ROOT,
      [],
    );

    expect(dropped).toEqual(['CLAUDE_PLUGIN_ROOT']);
    expect(env).not.toHaveProperty('CLAUDE_PLUGIN_ROOT');
  });

  it('drops an unlisted key by VALUE when it names the harness root', () => {
    // Only rule 2 can catch this — SNAPSHOT is in no key list anywhere.
    const { env, dropped } = scrubControlArmEnv({ SNAPSHOT: `${HARNESS_ROOT}/staged/s/x.json` }, HARNESS_ROOT, []);

    expect(dropped).toEqual(['SNAPSHOT']);
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
    const { env, dropped, retainedLeaks } = scrubControlArmEnv(
      { ANTHROPIC_MODEL: `${HARNESS_ROOT}/models/pinned` },
      HARNESS_ROOT,
      ['ANTHROPIC_MODEL'],
    );

    expect(env['ANTHROPIC_MODEL'], 'the control arm lost its model pin').toBeDefined();
    expect(dropped).toEqual([]);
    expect(retainedLeaks).toEqual(['ANTHROPIC_MODEL']);
  });

  // The negative control for the case above: same var, same value, but NOT
  // declared as a model var — so it is ordinary env and rule 2 drops it. Without
  // this, the test above would pass on a `protectedEnvNames()` that ignores its
  // argument entirely, which is exactly the bug being fixed.
  it('drops that same var when the run declares no model vars', () => {
    const { dropped } = scrubControlArmEnv(
      { ANTHROPIC_MODEL: `${HARNESS_ROOT}/models/pinned` },
      HARNESS_ROOT,
      [],
    );

    expect(dropped).toEqual(['ANTHROPIC_MODEL']);
  });

  it('retains a process-essential var that names the harness root, and reports it', () => {
    const repoRoot = '/Users/dev/myrepo';
    const { env, dropped, retainedLeaks } = scrubControlArmEnv(
      { PATH: `${repoRoot}/node_modules/.bin:/usr/bin:/bin`, HOME: repoRoot },
      repoRoot,
      [],
    );

    expect(env['PATH'], 'the control arm was spawned with no PATH').toBeDefined();
    expect(dropped).toEqual([]);
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
    const { env, dropped } = scrubControlArmEnv({ FIXTURES: fixtures }, harnessRoot, []);

    expect(dropped, 'a prefix collision stripped the control arm fixtures').toEqual([]);
    expect(env['FIXTURES']).toBe(fixtures);
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
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- inert test literal; these are string needles
  const PRIVATE_DIR = '/tmp/vat-skill-evals-1111aaaa2222bbbb';
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- inert test literal; these are string needles
  const SIBLING_DIR = '/tmp/vat-skill-test-ws-abc/1111aaaa2222bbbb';

  it('arms only the harness signal for the barest input', () => {
    expect(activeContaminationSignals({ transcript: '', harnessRoot: HARNESS_ROOT })).toEqual([KIND_HARNESS_PATH]);
  });

  it.each([
    [KIND_SIBLING_ARM, { siblingArmDir: SIBLING_DIR }],
    [KIND_VAT_PRIVATE_DIR, { vatPrivateDirs: [PRIVATE_DIR] }],
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

describe('summarizeBaselineIntegrity', () => {
  // The block is emitted even when clean, so a reader can tell "checked and
  // clean" from "written before this check existed".
  it('reports a clean run as not contaminated, with an explicit caveat', () => {
    const integrity = summarizeBaselineIntegrity([], ALL_SIGNALS);

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
    const integrity = summarizeBaselineIntegrity([], [KIND_HARNESS_PATH, KIND_SIBLING_ARM]);

    expect(integrity.signals).toEqual(['harness-path', 'sibling-arm']);
    expect(integrity.summary).toContain('checked by: harness-path, sibling-arm');
  });

  // The loudest case: a clean verdict from a run where nothing was looking must
  // not read like a clean verdict from a run where everything was.
  it('says outright that a verdict with no armed detector is not evidence', () => {
    const integrity = summarizeBaselineIntegrity([], []);

    expect(integrity.signals).toEqual([]);
    expect(integrity.summary).toContain('NO detector was armed');
    expect(BaselineIntegritySchema.safeParse(integrity).success).toBe(true);
  });

  it('names every contaminated eval and says the delta is not skill lift', () => {
    const findings: BaselineContamination[] = [
      { evalId: 'lookup-1', hits: [{ kind: KIND_HARNESS_PATH, match: HARNESS_ROOT, excerpt: EXCERPT_ELLIPSIS }] },
      { evalId: 'lookup-2', hits: [{ kind: 'declared-executable', match: BUNDLE_NAME, excerpt: EXCERPT_ELLIPSIS }] },
    ];
    const integrity = summarizeBaselineIntegrity(findings, ALL_SIGNALS);

    expect(integrity.contaminated).toBe(true);
    expect(integrity.summary).toContain('lookup-1, lookup-2');
    expect(integrity.summary).toContain('NOT a measure of skill lift');
    expect(BaselineIntegritySchema.safeParse(integrity).success).toBe(true);
  });
});
