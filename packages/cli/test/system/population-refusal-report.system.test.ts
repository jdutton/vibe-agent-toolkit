/**
 * Every CLI lane that populates a tree from its rows reports what that
 * population declined — `vat claude context` and `vat inventory` as well as the
 * query verbs — because the report lives inside the one population entry
 * (`populateAndReport`) rather than in a call each lane places by hand.
 *
 * Each corpus holds the same binary bytes twice: at `logo.png`, a committed
 * image and the ordinary shape of a repository, which is NOT reported, and at a
 * path typed as text, which is. So `(1 not text)` pins the line both ways.
 *
 * A file whose parse was REFUSED has one contract in every verb that crawls
 * (`not-admitted.ts` in `resources`): the same code, the same severity under the
 * project's `resources.validation`, and the same place in `examined` — counted,
 * and scoped to a `--collection` by the collection's own patterns. `vat
 * resources check`, which answers from a population, holds the refusal against
 * its verdict the same way. That corpus nests one file's frontmatter 1,001
 * levels deep as JSON, past `outputDepth`: a real refusal, quick to produce.
 *
 * Isolation: `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and the temp directory (`TMPDIR`,
 * `TEMP`, `TMP`) all point into scratch, and no projection store is selected, so every run
 * derives.
 */

import { rmSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { writeCommittedCorpus } from '../test-helpers.js';

import { createIsolatedScratch, executeCli, getBinPath, isolatedScratchEnv } from './test-common.js';

const binPath = getBinPath(import.meta.url);

/** PNG signature bytes: a NUL inside the sniff window, so the blob stage declines them as not text. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

let scratch: string;

/**
 * A committed corpus: `files` as given, plus the image the report stays silent about.
 *
 * @param name - The corpus directory's name under scratch
 * @param files - Root-relative path → content
 * @returns The corpus root
 */
function corpus(name: string, files: Readonly<Record<string, string | Buffer>>): string {
  return writeCommittedCorpus(safePath.join(scratch, name), { ...files, 'assets/logo.png': PNG_BYTES });
}

/**
 * Run one verb in a corpus, isolated.
 *
 * @param root - The corpus root, used as the working directory
 * @param args - The verb and its arguments
 * @returns The run's stderr, with its exit status for the failure message
 */
async function stderrOf(root: string, args: string[]): Promise<{ status: number | null; stderr: string }> {
  const result = await executeCli(binPath, args, {
    cwd: root,
    env: isolatedScratchEnv(scratch),
  });
  return { status: result.status, stderr: result.stderr };
}

const REFUSED_CODE = 'RESOURCE_PARSE_LIMIT_EXCEEDED';

/** What the verbs publish that the refused-file cases read. */
interface Published {
  examined: number;
  findings: Array<{ code: string; severity: string; location?: string; message: string }>;
}

/**
 * A corpus holding one refused file in two collections' worth of documents,
 * under `validation` (YAML lines nested under `resources:`, or none).
 *
 * @param name - The corpus directory's name under scratch
 * @param validation - The `resources.validation` block's lines
 * @returns The corpus root
 */
function refusedCorpus(name: string, validation: readonly string[]): string {
  return corpus(name, {
    'vibe-agent-toolkit.config.yaml': [
      'resources:',
      '  include: ["docs/**/*.md", "notes/**/*.md"]',
      '  collections:',
      '    docs:',
      '      include: ["docs/**/*.md"]',
      '    notes:',
      '      include: ["notes/**/*.md"]',
      ...validation,
      '',
    ].join('\n'),
    'docs/a.md': '# A\n',
    'docs/deep.md': `---\na: ${'['.repeat(1000)}${']'.repeat(1000)}\n---\n# Deep\n`,
    'notes/n.md': '# N\n',
  });
}

/**
 * Run one verb in a corpus and read its published document.
 *
 * @param root - The corpus root
 * @param args - The verb and its arguments
 * @returns The exit status, the document, and stderr for failure messages
 */
async function published(root: string, args: string[]): Promise<{ status: number | null; report: Published; stderr: string }> {
  const result = await executeCli(binPath, args, { cwd: root, env: isolatedScratchEnv(scratch) });
  return { status: result.status, report: yaml.parse(result.stdout) as Published, stderr: result.stderr };
}

/** The refusal findings of a report. */
function refusedIn(report: Published): Published['findings'] {
  return report.findings.filter((finding) => finding.code === REFUSED_CODE);
}

describe('the population refusal report, on every lane that populates (system test)', () => {
  beforeAll(() => {
    scratch = createIsolatedScratch('vat-refusal-report-');
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('vat claude context names a binary its @-import chain reached, and not the image', async () => {
    const root = corpus('context', {
      'CLAUDE.md': '# Project\n\n@notes.md\n',
      'notes.md': Buffer.concat([PNG_BYTES, Buffer.from('# not really notes\n')]),
    });

    const run = await stderrOf(root, ['claude', 'context', '.', '--format', 'json']);

    expect(run.stderr, `exit ${String(run.status)}`).toContain('claude-context population: blob derivation declined');
    expect(run.stderr).toContain('(1 not text)');
  });

  it('vat inventory names a binary the plugin\'s skill ships, and not the image', async () => {
    // A plugin directory: the one subject shape whose skills share a population.
    const root = corpus('inventory', {
      '.claude-plugin/plugin.json': '{ "name": "demo-plugin", "version": "0.0.1" }\n',
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: A demo skill for the refusal report.\n---\n\n# Demo\n\nSee [the data](./data.json).\n',
      'skills/demo/data.json': Buffer.concat([PNG_BYTES, Buffer.from('{}')]),
    });

    const run = await stderrOf(root, ['inventory', '.']);

    expect(run.stderr, `exit ${String(run.status)}`).toContain('inventory population: blob derivation declined');
    expect(run.stderr).toContain('(1 not text)');
  });

  it('vat resources query refuses frontmatter deeper than SQLite reads, and json_extract still answers the rest', async () => {
    // 2,000 nested lists are 2,001 levels of JSON, past the 1,000 SQLite's JSON
    // functions read; a cyclic anchor nests without end. Stored, either makes
    // EVERY statement reading `blobs.frontmatter` throw "malformed JSON" — or,
    // for the cycle, crashes the encoder — so the one ordinary row below is the
    // witness that the refusal kept the query answerable.
    const root = corpus('depth', {
      'docs/a.md': '---\ntitle: ok\n---\n# A\n',
      'docs/cyclic.md': '---\na: &x [*x]\ntitle: cyclic\n---\n# B\n',
      'docs/deep.md': `---\ntitle: deep\na: ${'['.repeat(2000)}${']'.repeat(2000)}\n---\n# C\n`,
    });

    const result = await executeCli(
      binPath,
      [
        'resources', 'query',
        "select r.path, json_extract(b.frontmatter, '$.title') as title, c.message as refusal"
          + ' from resource_realizations r left join blobs b on b.contentKey = r.contentKey'
          + ' left join blob_conditions c on c.blob = r.contentKey'
          + " where r.path like 'docs/%' order by r.path",
      ],
      { cwd: root, env: isolatedScratchEnv(scratch) },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('(2 over a parse limit)');
    const rows = (yaml.parse(result.stdout) as { data: { rows: Array<{ path: string; title: string | null; refusal: string | null }> } }).data.rows;
    expect(rows.map((row) => [row.path, row.title])).toStrictEqual([
      ['docs/a.md', 'ok'],
      ['docs/cyclic.md', null],
      ['docs/deep.md', null],
    ]);
    expect(rows[1]?.refusal).toContain('outputDepth limit');
    expect(rows[1]?.refusal).toContain('without end');
    expect(rows[2]?.refusal).toContain('this document nests 2001');
  });
});

describe('a file the crawl refused, in every verb that crawls (system test)', () => {
  let warned: string;
  let strict: string;

  beforeAll(() => {
    scratch = createIsolatedScratch('vat-not-admitted-');
    warned = refusedCorpus('warned', ['  validation:', '    severity:', `      ${REFUSED_CODE}: warning`]);
    strict = refusedCorpus('strict', []);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each([
    ['resources validate', ['resources', 'validate']],
    ['resources scan', ['resources', 'scan']],
  ])('%s reports it at the configured severity and counts it in examined', async (_verb, args) => {
    const { status, report, stderr } = await published(warned, args);

    expect(refusedIn(report), stderr).toStrictEqual([expect.objectContaining({ severity: 'warning', location: 'docs/deep.md' })]);
    expect(report.examined).toBe(3);
    expect(status).toBe(0);
  });

  it.each([
    ['resources validate', ['resources', 'validate', '--collection']],
    ['resources scan', ['resources', 'scan', '--collection']],
  ])('%s --collection counts it only in the collection whose patterns match it', async (_verb, args) => {
    const docs = await published(warned, [...args, 'docs']);
    const notes = await published(warned, [...args, 'notes']);

    expect(docs.report.examined, docs.stderr).toBe(2);
    expect(docs.report.findings.map((finding) => finding.code)).toContain(REFUSED_CODE);
    expect(notes.report.examined, notes.stderr).toBe(1);
    expect(notes.report.findings.map((finding) => finding.code)).not.toContain(REFUSED_CODE);
  });

  // No check can see a refused file's rows, so a clean verdict over it would be
  // a claim about a corpus the checks never read.
  it('resources check fails closed with a finding at it', async () => {
    const { status, report, stderr } = await published(strict, ['resources', 'check']);

    expect(refusedIn(report), stderr).toStrictEqual([expect.objectContaining({ severity: 'error', location: 'docs/deep.md' })]);
    expect(status).toBe(1);
  });

  it('resources check holds it to the configured severity, as every other finding is', async () => {
    const { status, report, stderr } = await published(warned, ['resources', 'check']);

    expect(refusedIn(report), stderr).toStrictEqual([expect.objectContaining({ severity: 'warning', location: 'docs/deep.md' })]);
    expect(status).toBe(0);
  });
});

// One resolver: an allow entry for the refusal code at its path excuses it in
// every verb that reports it, the allow list read before severity — and the
// same corpus without the entry fails in every one of them.
describe('one allow entry for a refused file, in every verb that reports it (system test)', () => {
  let allowed: string;
  let strict: string;

  beforeAll(() => {
    scratch = createIsolatedScratch('vat-not-admitted-allow-');
    allowed = refusedCorpus('allowed', [
      '  validation:',
      '    allow:',
      `      ${REFUSED_CODE}:`,
      '        - paths: ["docs/deep.md"]',
      '          reason: seeded refusal, excused at its one path',
    ]);
    strict = refusedCorpus('strict', []);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const verbs: ReadonlyArray<readonly [string, (dbName: string) => string[]]> = [
    ['resources validate', () => ['resources', 'validate']],
    ['resources scan', () => ['resources', 'scan']],
    ['rag index', (dbName) => ['rag', 'index', '.', '--db', safePath.join(scratch, dbName)]],
    ['resources check', () => ['resources', 'check']],
  ];

  it.each(verbs)('%s exits 0 with the entry and 1 without it', async (verb, args) => {
    const excused = await published(allowed, args(`allowed-${verb.replaceAll(' ', '-')}-db`));
    const failed = await published(strict, args(`strict-${verb.replaceAll(' ', '-')}-db`));

    expect(refusedIn(excused.report), excused.stderr).toStrictEqual([]);
    expect(excused.status, excused.stderr).toBe(0);
    expect(refusedIn(failed.report), failed.stderr).toStrictEqual([expect.objectContaining({ severity: 'error', location: 'docs/deep.md' })]);
    expect(failed.status, failed.stderr).toBe(1);
  });
});

// I0: the verdict never depends on cache warmth. A SKILL.md nesting thousands
// of blockquotes overflows the in-process parse of `skills validate`; the crawl
// of `resources validate` parses it in a worker and files the facts, so a
// later `skills validate` was served them from the cache and admitted what the
// cold run refused. The in-process overflow now falls back to one bounded parse
// through the pool, so every run gives the worker's answer.
//
// Two depths, because the worker's answer differs between them: measured on
// Node 26 (darwin arm64), 9,500 overflows the main thread's stack and the
// worker admits it (red before the fix: cold exit 1, warm exit 0), while
// 10,000 also passes the worker's 1,024 MiB `heapMb`, so the worker refuses it
// and both runs refuse. The assertion holds whichever way a host's stack and
// heap fall: `skills validate` agrees with the crawl, cold and warm.
describe('skills validate, cold and then warm, over a document the in-process parse overflows (system test)', () => {
  beforeAll(() => {
    scratch = createIsolatedScratch('vat-cold-warm-');
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each([9500, 10_000])('at %i nested blockquotes, exits with the crawl\'s code before and after the crawl warms the cache', async (depth) => {
    const deep = corpus(`cold-warm-${String(depth)}`, {
      'vibe-agent-toolkit.config.yaml': 'resources:\n  include: ["skills/**/*.md"]\nskills:\n  include:\n    - "skills/deep/SKILL.md"\n',
      'skills/deep/SKILL.md': '---\nname: deep\ndescription: deep - a skill whose body nests thousands of blockquotes, for the warmth test\n---\n\n'
        + `${'>'.repeat(depth)} deep\n`,
    });

    const cold = await published(deep, ['skills', 'validate']);
    const crawl = await published(deep, ['resources', 'validate']);
    const warm = await published(deep, ['skills', 'validate']);

    expect(cold.status, `cold: ${cold.stderr}\ncrawl: ${crawl.stderr}`).toBe(crawl.status);
    expect(warm.status, `warm: ${warm.stderr}`).toBe(cold.status);
    expect(refusedIn(warm.report).map((finding) => finding.location)).toStrictEqual(refusedIn(cold.report).map((finding) => finding.location));
  });
});

// A link anchor into a refused file is unverified: the file never entered the
// fragment index, so the anchor check answered `skip` and the link read clean.
// With the refusal itself downgraded to a warning, the run exited 0 over an
// anchor nothing looked up.
describe('a link anchor into a refused file (system test)', () => {
  let linked: string;

  beforeAll(() => {
    scratch = createIsolatedScratch('vat-refused-anchor-');
    linked = corpus('linked', {
      'vibe-agent-toolkit.config.yaml': [
        'resources:',
        '  include: ["docs/**/*.md"]',
        '  validation:',
        '    severity:',
        `      ${REFUSED_CODE}: warning`,
        '',
      ].join('\n'),
      'docs/a.md': '# A\n\nSee [the missing part](./big.md#missing).\n',
      'docs/big.md': `---\na: ${'['.repeat(1000)}${']'.repeat(1000)}\n---\n# Big\n`,
    });
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('is a LINK_TARGET_UNREADABLE finding naming the refusal, and fails the run', async () => {
    const { status, report, stderr } = await published(linked, ['resources', 'validate']);
    const unverified = report.findings.filter((finding) => finding.code === 'LINK_TARGET_UNREADABLE');

    expect(unverified, stderr).toStrictEqual([expect.objectContaining({ severity: 'error', location: 'docs/a.md' })]);
    expect(unverified[0]?.message).toContain('its parse was refused (its parse was stopped at its outputDepth limit');
    expect(unverified[0]?.message).toContain('its anchors are unverified');
    expect(status).toBe(1);
  });
});

// One refusal sentence: every verb says a refused file in `parseRefusedMessage`,
// each at its own project-relative path — two files holding the same bytes are
// one blob, and the projection lane (`resources check`) named the first path
// for both.
describe('two refused files with identical bytes, in every verb that reports them (system test)', () => {
  let twins: string;

  beforeAll(() => {
    scratch = createIsolatedScratch('vat-not-admitted-twins-');
    const deep = `---\na: ${'['.repeat(1000)}${']'.repeat(1000)}\n---\n# Deep\n`;
    twins = corpus('twins', {
      'vibe-agent-toolkit.config.yaml': 'resources:\n  include: ["docs/**/*.md"]\n',
      'docs/a.md': '# A\n',
      'docs/deep.md': deep,
      'docs/twin.md': deep,
    });
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('names each at its own path, in the same sentence in validate, scan and check', async () => {
    const reasons = new Set<string>();
    for (const args of [['resources', 'validate'], ['resources', 'scan'], ['resources', 'check']]) {
      const { report, stderr } = await published(twins, args);
      const refused = refusedIn(report);

      expect(refused.map((finding) => finding.location), stderr).toStrictEqual(['docs/deep.md', 'docs/twin.md']);
      for (const finding of refused) {
        const lead = `'${finding.location ?? ''}' was enumerated but `;
        expect(finding.message.startsWith(lead), finding.message).toBe(true);
        reasons.add(finding.message.slice(lead.length).split(', so ')[0] ?? '');
      }
    }
    expect([...reasons]).toHaveLength(1);
    expect([...reasons][0]).toMatch(/^its parse was stopped at its outputDepth limit/);
  });
});
