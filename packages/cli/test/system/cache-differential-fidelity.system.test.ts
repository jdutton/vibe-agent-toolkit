/**
 * I0 over the store-fidelity cases: `vat validate` gives byte-identical findings, in
 * order, and the same exit code store-off, cold, warm and warm with half the blob tier
 * evicted. Warm `vat validate` admits each resource from its STORED blob facts (the one
 * reader, `blobFactsReader`), so a fact the store carries wrongly is a warm finding that
 * differs from the cold one; partial eviction mixes the two in one registry.
 *
 * The fixture mirrors the cases of projection-sqlite's `blob-facts-round-trip`, each
 * written so a wrong stored fact moves a finding: a frontmatter schema sees F1's values
 * and F2's missing mapping, links into F3's inline anchor and F6's suffixed slugs break
 * when those facts are lost, F5's links are reported in the parser's order, F7's
 * repeated conditions are each a finding, and F8, F10 and F14 hold a link that only a
 * wrong fact would report. {@link EXPECTED_FINDINGS} holds the store-off answer exactly,
 * so a fixture that stops producing its case reds here rather than passing blind.
 *
 * Not observable in findings: F4 (a positionless link; its only target is an external
 * URL, which `vat validate` does not check), F1's `-0` (a schema error prints it as
 * `0`), and a parser throw (`BLOB_PARSE_FAILED`: no bytes reach it from a CLI run, so the
 * reader's not-admitted branch is held by the resources and projection-sqlite tests).
 */

import { truncateSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fidelitySuite, indexFlagSeeds, seedTitle, treeSeedSuite, type FixtureTree } from '../helpers/cache-differential.js';

import { writeFileTree } from './test-common.js';

/** The fixture's text files, one or more per fidelity case, named for it. */
const TEXT: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': [
    'resources:',
    // Every file under docs, the JSON one included: the default include admits only what a parser reads.
    '  include: ["docs/**"]',
    '  collections:',
    '    typed:',
    '      include: ["docs/f1-*.md", "docs/f2-*.md", "docs/f9-*.md"]',
    '      validation:',
    '        frontmatterSchema: "typed-schema.json"',
    '        mode: strict',
    '',
  ].join('\n'),
  // Each property's error names the decoded value's type, so a value the store decodes differently moves it.
  'typed-schema.json': JSON.stringify({
    type: 'object',
    required: ['title'],
    properties: {
      inf: { type: 'number', maximum: 10 },
      negzero: { type: 'string' },
      when: { type: 'string' },
      tags: { type: 'array' },
    },
  }),
  // F3 and F6 resolve only while their anchors and slugs are carried; F5's `#usage` too.
  'docs/baseline.md': '---\ntitle: Baseline\n---\n# Baseline\n\nSee [anchor](./f3-anchors.md#custom-anchor), [slug](./f6-slugs.md#a-1-1) and [usage](./f5-parser-order.md#usage).\n',
  // F1: values JSON cannot carry: Infinity, a timestamp, a set.
  'docs/f1-frontmatter-codec.md': '---\ntitle: F1\ninf: .inf\nnegzero: -0\nwhen: !!timestamp 2024-01-02T03:04:05Z\ntags: !!set { a, b }\n---\n# F1\n',
  // F2: valid YAML that is not a mapping: no frontmatter at all.
  'docs/f2-not-a-mapping.md': '---\n- a\n- b\n---\n# F2\n',
  'docs/f3-anchors.md': '# F3\n\n<a id="custom-anchor"></a>\n\nText.\n',
  'docs/f4-positionless-link.md': '# F4\n\nSee domain:www.anthropic.com for more.\n',
  // F5: links, then references, then definitions, in the parser's order; source order differs.
  'docs/f5-parser-order.md': '[def]: ./missing-def.md\n\n## Usage\n\nA [link](./missing-link.md) and a [ref][def].\n',
  'docs/f6-slugs.md': '# A\n\n## A\n\n## A 1\n',
  'docs/f7-conditions.md': '# F7\n\nSee [one][missing] and [two][missing].\n',
  'docs/f7-page.html': '<!DOCTYPE html><p id="a" id="b" class="c" class="d"><a href="./missing-html.md">Base</a></p>\n',
  // F8: an `@`-prefixed form is never a link, so its missing target is never a finding.
  'docs/f8-forms.md': '# F8\n\nImport @docs/missing-at.md here and [a link](./baseline.md).\n',
  'docs/f9-frontmatter-error.md': '---\npaths:\n  - **/x/*.ts\n---\n# F9\n',
  // F10: no parser reads JSON, so the link-shaped text is no link.
  'docs/f10-no-parser.json': '{ "see": "[a link](./missing-json.md)" }\n',
  // Identical bytes at two paths: one content key, two resources, each with its own finding.
  'docs/twin-a.md': '# Twin\n\nSee [nowhere](./missing-twin.md).\n',
  'docs/twin-b.md': '# Twin\n\nSee [nowhere](./missing-twin.md).\n',
  // Two paths one resource id (`/` and `-` both slug to `-`): first-wins over hydrated admissions.
  'docs/dup-hyphen/note.md': '# Note under dup-hyphen\n',
  'docs/dup/hyphen-note.md': '# Note under dup\n',
  // As the gate fixture holds them. Without them the prime's dump reports `lensPopulation: store` on a cold
  // store (its lens served by what its own population just wrote), which the cold tell refuses.
  'CLAUDE.md': '# Corpus\n\n@docs/baseline.md\n',
  '.claude/rules/docs.md': '---\npaths: ["docs/**"]\n---\n# Docs rule\n\nKeep [the baseline](../../docs/baseline.md) current.\n',
};

/** F14: bytes that are not text, under a name the markdown parser is routed to; as text they would hold a broken link. */
const NOT_TEXT = Buffer.from([0x23, 0x20, 0x00, 0x01, 0x02, 0x5b, 0x78, 0x5d, 0x28, 0x79, 0x29, 0x0a]);

/** One byte past the default input cap: refused by size before a byte is read. Untracked, and sparse where the host allows. */
const OVERSIZE_BYTES = 8 * 1024 * 1024 + 1;

const FIDELITY_TREE: FixtureTree = {
  committed: (corpus) => {
    writeFileTree(corpus, TEXT);
    writeFileSync(safePath.join(corpus, 'docs/f14-not-text.md'), NOT_TEXT);
  },
  untracked: (corpus) => {
    const oversize = safePath.join(corpus, 'docs/oversize.md');
    writeFileSync(oversize, '');
    truncateSync(oversize, OVERSIZE_BYTES);
  },
};

/** A finding as {@link EXPECTED_FINDINGS} holds it: the schema path in a message is the cell's, so it is cut. */
function comparable(finding: Record<string, unknown>): Record<string, unknown> {
  const message = String(finding['message']).replace(/ \(schema: .*\)$/su, '');
  return { code: finding['code'], location: finding['location'], line: finding['line'], link: finding['link'], message };
}

const SCHEMA_FAILED = 'Frontmatter validation failed for';
const PARSE_LIMIT_SKIPPED = "'docs/oversize.md' was enumerated but it was refused at its inputBytes limit (8388608 input bytes), so it was skipped: nothing in it was checked. Nothing was stored for it: the next run parses it again.";
const PARSE_LIMIT_UNCHECKED = "'docs/oversize.md' was enumerated but it was refused at its inputBytes limit (8388608 input bytes), so no check saw its rows and this run's verdict does not cover it. Nothing was stored for it: the next run parses it again.";
const DUPLICATE_ID = "Two files resolve to the same resource id 'docs-dup-hyphen-note-md': 'docs/dup-hyphen/note.md' and 'docs/dup/hyphen-note.md'. Rename one of the files so they produce distinct resource ids.";

/**
 * Store-off's findings, exactly and in order: each fidelity case surfaces here, and a
 * case whose finding is an absence (F3, F6, F8, F10, F14) is held by the list being exact.
 */
const EXPECTED_FINDINGS = [
  // F9: the parser's error, verbatim.
  { code: 'FRONTMATTER_INVALID_YAML', location: 'docs/f9-frontmatter-error.md', line: 1, message: 'Invalid YAML syntax in frontmatter: Unresolved alias (the anchor must be set before the alias): */x/*.ts' },
  // F7: two identical HTML parse errors on one line, two findings.
  { code: 'MALFORMED_HTML', location: 'docs/f7-page.html', line: 1, message: 'Malformed HTML: duplicate-attribute' },
  { code: 'MALFORMED_HTML', location: 'docs/f7-page.html', line: 1, message: 'Malformed HTML: duplicate-attribute' },
  // F7: two dangling references with one label on one line, two findings.
  ...Array.from({ length: 2 }, () => ({
    code: 'LINK_UNRESOLVED_REFERENCE',
    location: 'docs/f7-conditions.md',
    line: 3,
    message: 'Reference-style link "[missing]" has no matching definition. Add "[missing]: <url>" or rewrite as an inline link.',
  })),
  { code: 'DUPLICATE_RESOURCE_ID', message: DUPLICATE_ID },
  // Oversize: the hydrated not-admitted entry, as the cold refusal words it.
  { code: 'RESOURCE_PARSE_LIMIT_EXCEEDED', location: 'docs/oversize.md', message: PARSE_LIMIT_SKIPPED },
  // F5: the parser's order (link, reference, definition), not source order.
  { code: 'LINK_BROKEN_FILE', location: 'docs/f5-parser-order.md', line: 5, link: './missing-link.md', message: 'File not found: docs/missing-link.md' },
  { code: 'LINK_BROKEN_FILE', location: 'docs/f5-parser-order.md', line: 5, link: './missing-def.md', message: 'File not found: docs/missing-def.md' },
  { code: 'LINK_BROKEN_FILE', location: 'docs/f5-parser-order.md', line: 1, link: './missing-def.md', message: 'File not found: docs/missing-def.md' },
  { code: 'LINK_BROKEN_FILE', location: 'docs/f7-page.html', line: 1, link: './missing-html.md', message: 'File not found: docs/missing-html.md' },
  { code: 'LINK_BROKEN_FILE', location: 'docs/twin-a.md', line: 3, link: './missing-twin.md', message: 'File not found: docs/missing-twin.md' },
  { code: 'LINK_BROKEN_FILE', location: 'docs/twin-b.md', line: 3, link: './missing-twin.md', message: 'File not found: docs/missing-twin.md' },
  // F1: Infinity is a number (printed `null`), the timestamp a Date, the set no array.
  { code: 'FRONTMATTER_SCHEMA_ERROR', location: 'docs/f1-frontmatter-codec.md', line: 1, message: `${SCHEMA_FAILED} 'inf' (got: null). must be <= 10` },
  { code: 'FRONTMATTER_SCHEMA_ERROR', location: 'docs/f1-frontmatter-codec.md', line: 1, message: `${SCHEMA_FAILED} 'negzero' (got: 0). Expected type: "string"` },
  { code: 'FRONTMATTER_SCHEMA_ERROR', location: 'docs/f1-frontmatter-codec.md', line: 1, message: `${SCHEMA_FAILED} 'when' (got: "2024-01-02T03:04:05.000Z"). Expected type: "string"` },
  { code: 'FRONTMATTER_SCHEMA_ERROR', location: 'docs/f1-frontmatter-codec.md', line: 1, message: `${SCHEMA_FAILED} 'tags' (got: {}). Expected type: "array"` },
  // F2: a sequence is no frontmatter, and no frontmatter error.
  { code: 'FRONTMATTER_MISSING', location: 'docs/f2-not-a-mapping.md', line: 1, message: 'No frontmatter found in file. Schema requires: title' },
  // The checks phase's own refusal of the same file.
  { code: 'RESOURCE_PARSE_LIMIT_EXCEEDED', location: 'docs/oversize.md', message: PARSE_LIMIT_UNCHECKED },
].map((finding) => comparable(finding));

describe('vat validate answers every store-fidelity case alike whether or not the projection store is engaged', () => {
  const fidelity = fidelitySuite(FIDELITY_TREE, import.meta.url);

  it('surfaces every observable case in the store-off reference', () => {
    const reference = fidelity.result().measured.storeOff.vatValidate;
    expect(reference?.status).toBe(1);
    const findings = (reference?.document['findings'] ?? []) as Record<string, unknown>[];
    expect(findings.map((finding) => comparable(finding))).toEqual(EXPECTED_FINDINGS);
  });

  it('answers in every arm, warm and partly evicted included, with the reference\'s findings in order and its exit code', fidelity.expectAgreement);
});

/** The fixture's file each index-flag seed edits: tracked, and linking nowhere broken until it is edited. */
const FLAGGED = 'docs/f3-anchors.md';

/**
 * The forward index-flag seeds (`indexFlagSeeds`) over this fixture: a flagged file edited after
 * the warm prime. The tree key declines while a file is flagged, so cold and warm answer as
 * store-off does, with every fidelity case riding along. The reverse direction and the `check`
 * verb run over the gate fixture (`cache-differential-index-flags`).
 */
const flagSeeds = (['assume-unchanged', 'skip-worktree'] as const).map((flag) => indexFlagSeeds(flag, {
  path: FLAGGED,
  edited: '# F3\n\n<a id="custom-anchor"></a>\n\nNow [gone](./gone.md).\n',
  arms: ['storeOff', 'cold', 'warmSameHistory'],
  verbs: ['vatValidate'],
})[0]);

describe('vat validate answers alike after a file git is told not to look at is edited', () => {
  const suite = treeSeedSuite(FIDELITY_TREE, import.meta.url);
  beforeAll(suite.setup);
  afterAll(suite.cleanup);

  for (const seed of flagSeeds) {
    it(seedTitle(seed), async () => {
      expect(await suite.run(seed)).toEqual(seed.arms);
    });
  }
});
