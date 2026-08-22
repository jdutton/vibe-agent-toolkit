import { describe, expect, it } from 'vitest';

import {
  BaselineIntegritySchema,
  detectBaselineContamination,
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
    );

    expect(env).not.toHaveProperty('CLAUDE_PLUGIN_ROOT');
    expect(env).not.toHaveProperty('SNAPSHOT');
    expect([...dropped].toSorted((a, b) => a.localeCompare(b))).toEqual(['CLAUDE_PLUGIN_ROOT', 'SNAPSHOT']);
    // The arms must stay identical in everything except the skill: the control
    // keeps its own fixtures (under the workspaces root) and its auth.
    expect(env['FIXTURES']).toBe(WS_FIXTURES);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-test');
  });

  it('drops a value that names the harness root in the other separator form', () => {
    const { dropped } = scrubControlArmEnv(
      { WIN: String.raw`C:\tmp\vat-skill-test\s\x` },
      'C:/tmp/vat-skill-test/s',
    );
    expect(dropped).toEqual(['WIN']);
  });
});

describe('summarizeBaselineIntegrity', () => {
  // The block is emitted even when clean, so a reader can tell "checked and
  // clean" from "written before this check existed".
  it('reports a clean run as not contaminated, with an explicit caveat', () => {
    const integrity = summarizeBaselineIntegrity([]);

    expect(integrity.contaminated).toBe(false);
    expect(integrity.findings).toEqual([]);
    expect(integrity.summary).toContain('not a capability control');
    expect(BaselineIntegritySchema.safeParse(integrity).success).toBe(true);
  });

  it('names every contaminated eval and says the delta is not skill lift', () => {
    const findings: BaselineContamination[] = [
      { evalId: 'lookup-1', hits: [{ kind: KIND_HARNESS_PATH, match: HARNESS_ROOT, excerpt: EXCERPT_ELLIPSIS }] },
      { evalId: 'lookup-2', hits: [{ kind: 'declared-executable', match: BUNDLE_NAME, excerpt: EXCERPT_ELLIPSIS }] },
    ];
    const integrity = summarizeBaselineIntegrity(findings);

    expect(integrity.contaminated).toBe(true);
    expect(integrity.summary).toContain('lookup-1, lookup-2');
    expect(integrity.summary).toContain('NOT a measure of skill lift');
    expect(BaselineIntegritySchema.safeParse(integrity).success).toBe(true);
  });
});
