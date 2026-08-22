import { describe, expect, it } from 'vitest';

import {
  BaselineIntegritySchema,
  detectBaselineContamination,
  summarizeBaselineIntegrity,
  type BaselineContamination,
} from '../../src/skill-test/baseline-integrity.js';

// A synthetic path used only as a string needle for the detector — nothing is
// read or written here, so the publicly-writable-directory concern does not apply.
// eslint-disable-next-line sonarjs/publicly-writable-directories -- inert test literal; the detector is a pure string scan
const HARNESS_ROOT = '/tmp/vat-skill-test/my-skill-abc12345';
const BUNDLE_NAME = 'bucket-map';
const EXCERPT_ELLIPSIS = '…';
const KIND_HARNESS_PATH = 'harness-path' as const;

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
    expect(hits[0]?.kind).toBe('declared-executable');
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
