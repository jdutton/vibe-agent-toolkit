/**
 * I0 over the skill-text records: `vat validate` over a corpus of skills gives the same
 * findings, serialized byte for byte and in order, and the same exit code store-off,
 * cold, warm, warm with half the blob tier evicted, and warm with half the skill-text
 * records deleted.
 *
 * The corpus is the skill-text golden (`packages/agent-skills/test/fixtures/skill-text-golden`),
 * which holds a skill per detector family and per name source: an H1-only name that
 * decides a `files:` lookup, a name that disagrees with its directory, a whitespace-only
 * H1, the line, file-count and total-line thresholds on each side, a SKILL.md with a BOM,
 * one with CRLF line endings and one in UTF-16LE, linked documents with a BOM and in
 * UTF-16LE, bundled documents a SKILL.md (UTF-8 and UTF-16LE) mentions but never links,
 * two skills with identical bytes, a skill that links another skill's SKILL.md, every
 * frontmatter refusal (none, unclosed, empty, invalid YAML, not a mapping), second-person
 * openers in and out of fences and quotes, and an opener whose 80-code-unit sample ends
 * on an emoji's high surrogate. The
 * BOM and UTF-16LE files are served warm like any other: `vat validate`'s skills lane
 * scans decoded text, as it always has (only `validateSkill`'s linked-file lane scans a
 * file's raw reading, which the golden test holds). To it this file adds one skill bundling a
 * document over the parse input cap: the one file the store cannot serve the skills
 * lane, so every store-on run scans it.
 *
 * A SKILL.md bundled by another skill cannot occur: a link to one is the
 * `LINK_TO_SKILL_DEFINITION` error (`rule-engine.ts`), never a bundled file, and a
 * `files:` entry copies a directory without scanning it. `links-skill-md` holds that
 * case: the reference must report the code, and its one target that is no skill of its
 * own (`links-skill-md/nested/SKILL.md`) is never scanned, which the store-off and cold
 * scan counts hold exactly.
 *
 * Warm `vat validate` serves every SKILL.md and bundled document from its stored
 * skill-text record, so a record the store carries wrongly is a warm finding that
 * differs from the cold one. Deleting a key's skill-text rows by raw SQL, with its blob
 * facts kept, leaves the store accounting for the key with no record for it: the skills
 * lane then scans each file of that key, once per file, and answers as it does cold.
 *
 * Not asserted: a tampered served match row. The store checks a record's integrity by
 * its counts only (`matchCount` against its match rows), so a match row rewritten in
 * place with the same count is served as stored; that is accepted, not a defect.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { DEFAULT_PARSE_LIMITS } from '@vibe-agent-toolkit/resources';
import { safePath, toForwardSlash, type WorkCounterDump } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  evictHalfTheSkillText,
  fidelitySuite,
  seedTitle,
  storedContentKeys,
  treeSeedSuite,
  type FixtureTree,
  type I0Seed,
} from '../helpers/cache-differential.js';
import { skillLaneScannedFiles, SKILL_TEXT_GOLDEN_DIR, writeSkillTextGolden } from '../helpers/skill-text-golden.js';

/** One byte over the default parse input cap: no parse keys this bundled document. */
const OVER_CAP_BYTES = DEFAULT_PARSE_LIMITS.inputBytes + 1;

/** The skill this file adds to the golden corpus, and the document over the cap it bundles. */
const OVER_CAP_SKILL = 'over-cap-bundle';
const OVER_CAP_DOCUMENT = `${OVER_CAP_SKILL}/references/huge.md`;

/** The files every store-on run's skills lane scans because the store cannot serve them. */
const DECLARED_FALLBACK = [OVER_CAP_DOCUMENT] as const;

/** The corpus's context chain: a markdown file no skill reads. */
const CONTEXT_FILE = 'CLAUDE.md';

/** Every markdown file of the corpus: the resources view. */
const isMarkdown = (path: string): boolean => toForwardSlash(path).endsWith('.md');

/** The golden corpus at the corpus root, its capture config as the project config, plus the over-cap skill. */
const SKILL_TEXT_TREE: FixtureTree = {
  committed: (corpus) => {
    writeSkillTextGolden(corpus);
    // The capture config, with a resources view of the markdown alone: a view of the whole tree would be the
    // lens's own lane, which the prime's lens would then be served from what its resources phase just wrote.
    const capture = readFileSync(safePath.join(SKILL_TEXT_GOLDEN_DIR, 'capture.config.yaml'), 'utf8');
    writeFileSync(safePath.join(corpus, 'vibe-agent-toolkit.config.yaml'), `resources:\n  include: ["**/*.md"]\n${capture}`);
    // A context chain, so the dump's claude-context lens has a lane of its own to populate.
    writeFileSync(safePath.join(corpus, CONTEXT_FILE), '# Corpus\n\n@clean-skill/SKILL.md\n');
    mkdirSyncReal(safePath.join(corpus, OVER_CAP_SKILL, 'references'), { recursive: true });
    writeFileSync(
      safePath.join(corpus, OVER_CAP_SKILL, 'SKILL.md'),
      `---\nname: ${OVER_CAP_SKILL}\ndescription: Bundles one document over the parse input cap. It exists only for tests.\n---\n# Over cap\n\nRead [the reference](references/huge.md).\n`,
    );
    const header = '# Huge\n\n';
    writeFileSync(safePath.join(corpus, OVER_CAP_DOCUMENT), header + 'x'.repeat(OVER_CAP_BYTES - header.length));
  },
  untracked: () => undefined,
};

/**
 * A code from every detector family and name source the corpus seeds that `vat validate`
 * runs, each of which the reference must report. Not `SKILL_BODY_NOT_IMPERATIVE`: only
 * the config-free lane (`validateSkill`, which `vat audit` runs) detects second-person
 * openers, so `vat validate` never reports one; the golden integration test holds that family.
 */
const EXPECTED_CODES: ReadonlySet<string> = new Set([
  'CAPABILITY_LOCAL_SHELL',
  'CAPABILITY_BROWSER_AUTH',
  'CAPABILITY_EXTERNAL_CLI',
  'COMPAT_TARGET_UNDECLARED',
  'SKILL_CROSS_SKILL_AUTH_UNDECLARED',
  'SKILL_TIME_SENSITIVE_CONTENT',
  'NON_PORTABLE_COMMAND',
  'NON_PORTABLE_ASSET_REFERENCE',
  'MCP_TOOL_NAME_UNQUALIFIED',
  'LINK_TO_SKILL_DEFINITION',
  'SKILL_NAME_MISMATCHES_DIR',
  'SKILL_MISSING_NAME',
  'SKILL_MISSING_FRONTMATTER',
  'SKILL_NAME_INVALID',
  'REFERENCE_TOO_DEEP',
  'SKILL_TOO_MANY_FILES',
  'SKILL_LENGTH_EXCEEDS_RECOMMENDED',
  'NO_PROGRESSIVE_DISCLOSURE',
  'SKILL_TOTAL_SIZE_LARGE',
  'RESOURCE_PARSE_LIMIT_EXCEEDED',
]);

/** The skills lane's scans in one run: `skillText.storeMiss` over every CLI process's dump. */
function storeMisses(work: readonly WorkCounterDump[]): number {
  return work.reduce((sum, dump) => sum + dump.counters['skillText.storeMiss'], 0);
}

describe('vat validate answers every skill-text case alike whether or not the projection store is engaged', () => {
  const fidelity = fidelitySuite(SKILL_TEXT_TREE, isMarkdown, import.meta.url);

  it('reports every family\'s findings in the store-off reference', () => {
    const reference = fidelity.result().measured.storeOff.vatValidate;
    const findings = (reference?.document['findings'] ?? []) as Array<Record<string, unknown>>;
    const codes = new Set(findings.map((finding) => finding['code']));
    expect([...EXPECTED_CODES].filter((code) => !codes.has(code)), 'families the reference does not report').toEqual([]);
    // Refused once by each phase that reaches it, each in its own words: the resources view, the checks, the skills lane.
    expect(findings.filter((finding) => finding['location'] === OVER_CAP_DOCUMENT).map((finding) => finding['code']), 'the over-cap document')
      .toEqual(['RESOURCE_PARSE_LIMIT_EXCEEDED', 'RESOURCE_PARSE_LIMIT_EXCEEDED', 'RESOURCE_PARSE_LIMIT_EXCEEDED']);
  });

  it('answers in every arm with the reference\'s findings, serialized byte for byte, and its exit code', fidelity.expectAgreement);

  it('scans every skill file with no store and cold, and only the declared fallback warm', () => {
    const { measured } = fidelity.result();
    const run = (arm: 'storeOff' | 'cold' | 'warmSameHistory'): NonNullable<typeof measured.storeOff.vatValidate> => {
      const recorded = measured[arm].vatValidate;
      if (recorded === undefined) throw new Error(`no ${arm} run of vatValidate`);
      return recorded;
    };
    // The skills lane's files, as the golden test counts them: the context chain is in no skill directory.
    const skillFiles = skillLaneScannedFiles(run('cold').cell.corpus);
    expect(skillFiles, 'the declared fallback is a skill file').toEqual(expect.arrayContaining([...DECLARED_FALLBACK]));
    expect({ storeOff: storeMisses(run('storeOff').work), cold: storeMisses(run('cold').work), warm: storeMisses(run('warmSameHistory').work) })
      .toEqual({ storeOff: skillFiles.length, cold: skillFiles.length, warm: DECLARED_FALLBACK.length });
  });
});

/** The golden corpus's two skills with identical bytes: one content key, two files. */
const IDENTICAL_BYTES = ['dup-a/SKILL.md', 'dup-b/SKILL.md'] as const;

/** The keys each skill-text eviction deleted, by cell. */
const evictedByCell = new Map<string, readonly string[]>();

/**
 * Half the skill-text records deleted after the warm prime, the blob tier kept: the
 * findings are store-off's, and the skills lane scans exactly the declared fallback plus
 * every skill file whose key lost its record (once per file, so two files of one key are
 * two scans).
 */
const SKILL_TEXT_EVICTION: I0Seed = {
  name: 'half the skill-text records deleted after the prime',
  needs: null,
  arms: ['storeOff', 'warmSameHistory'],
  verbs: ['vatValidate'],
  toB: (arm, dirs) => {
    if (arm !== 'warmSameHistory') return Promise.resolve();
    // The identical-bytes skills share one key: evicted whatever its place in the order, so two files of one
    // key are two scans.
    const keys = storedContentKeys(dirs);
    const twin = keys.get(IDENTICAL_BYTES[0]);
    if (twin === undefined) throw new Error(`${IDENTICAL_BYTES[0]}: no stored content key`);
    expect(IDENTICAL_BYTES.map((path) => keys.get(path)), 'the identical-bytes skills share one content key').toEqual([twin, twin]);
    evictedByCell.set(dirs.root, evictHalfTheSkillText(dirs, [twin]));
    return Promise.resolve();
  },
  expect: { agrees: { because: 'the skills lane scans a file whose key has no skill-text record, as it does cold', storeDeclines: null } },
  consumed: {
    runs: ['warmSameHistory:measured'],
    check: (runs) => {
      const run = runs['warmSameHistory:measured']?.vatValidate;
      if (run === undefined) throw new Error('no warm measured run of vatValidate');
      const evicted = new Set(evictedByCell.get(run.cell.dirs.root) ?? []);
      const skillFiles = new Set(skillLaneScannedFiles(run.cell.corpus));
      const scanned = [...storedContentKeys(run.cell.dirs)].filter(([path, key]) => skillFiles.has(path) && evicted.has(key)).map(([path]) => path);
      expect(scanned, 'both identical-bytes files are scanned').toEqual(expect.arrayContaining([...IDENTICAL_BYTES]));
      expect(storeMisses(run.work), 'scans: the declared fallback, then each file whose record was deleted').toBe(DECLARED_FALLBACK.length + scanned.length);
    },
  },
};

describe('vat validate answers alike when part of the skill-text records is gone', () => {
  const suite = treeSeedSuite(SKILL_TEXT_TREE, import.meta.url);
  beforeAll(suite.setup);
  afterAll(suite.cleanup);

  it(seedTitle(SKILL_TEXT_EVICTION), async () => {
    expect(await suite.run(SKILL_TEXT_EVICTION)).toEqual(['storeOff', 'warmSameHistory']);
  });
});
