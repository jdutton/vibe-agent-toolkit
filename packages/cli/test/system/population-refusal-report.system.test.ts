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

import { corpus, PNG_BYTES, published, REFUSED_CODE, refusedCorpus, refusedIn } from './population-refusal-fixtures.js';
import { createIsolatedScratch, executeCli, getBinPath, isolatedScratchEnv } from './test-common.js';

const binPath = getBinPath(import.meta.url);

let scratch: string;

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

describe('the population refusal report, on every lane that populates (system test)', () => {
  beforeAll(() => {
    scratch = createIsolatedScratch('vat-refusal-report-');
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('vat claude context names a binary its @-import chain reached, and not the image', async () => {
    const root = corpus(scratch, 'context', {
      'CLAUDE.md': '# Project\n\n@notes.md\n',
      'notes.md': Buffer.concat([PNG_BYTES, Buffer.from('# not really notes\n')]),
    });

    const run = await stderrOf(root, ['claude', 'context', '.', '--format', 'json']);

    expect(run.stderr, `exit ${String(run.status)}`).toContain('claude-context population: blob derivation declined');
    expect(run.stderr).toContain('(1 not text)');
  });

  it('vat inventory names a binary the plugin\'s skill ships, and not the image', async () => {
    // A plugin directory: the one subject shape whose skills share a population.
    const root = corpus(scratch, 'inventory', {
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
    const root = corpus(scratch, 'depth', {
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
    warned = refusedCorpus(scratch, 'warned', ['  validation:', '    severity:', `      ${REFUSED_CODE}: warning`]);
    strict = refusedCorpus(scratch, 'strict', []);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each([
    ['resources validate', ['resources', 'validate']],
    ['resources scan', ['resources', 'scan']],
  ])('%s reports it at the configured severity and counts it in examined', async (_verb, args) => {
    const { status, report, stderr } = await published(scratch, warned, args);

    expect(refusedIn(report), stderr).toStrictEqual([expect.objectContaining({ severity: 'warning', location: 'docs/deep.md' })]);
    expect(report.examined).toBe(3);
    expect(status).toBe(0);
  });

  it.each([
    ['resources validate', ['resources', 'validate', '--collection']],
    ['resources scan', ['resources', 'scan', '--collection']],
  ])('%s --collection counts it only in the collection whose patterns match it', async (_verb, args) => {
    // Two runs that share nothing but the corpus they read: run side by side.
    const [docs, notes] = await Promise.all([
      published(scratch, warned, [...args, 'docs']),
      published(scratch, warned, [...args, 'notes']),
    ]);

    expect(docs.report.examined, docs.stderr).toBe(2);
    expect(docs.report.findings.map((finding) => finding.code)).toContain(REFUSED_CODE);
    expect(notes.report.examined, notes.stderr).toBe(1);
    expect(notes.report.findings.map((finding) => finding.code)).not.toContain(REFUSED_CODE);
  });

  // No check can see a refused file's rows, so a clean verdict over it would be
  // a claim about a corpus the checks never read.
  it('resources check fails closed with a finding at it', async () => {
    const { status, report, stderr } = await published(scratch, strict, ['resources', 'check']);

    expect(refusedIn(report), stderr).toStrictEqual([expect.objectContaining({ severity: 'error', location: 'docs/deep.md' })]);
    expect(status).toBe(1);
  });

  it('resources check holds it to the configured severity, as every other finding is', async () => {
    const { status, report, stderr } = await published(scratch, warned, ['resources', 'check']);

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
    allowed = refusedCorpus(scratch, 'allowed', [
      '  validation:',
      '    allow:',
      `      ${REFUSED_CODE}:`,
      '        - paths: ["docs/deep.md"]',
      '          reason: seeded refusal, excused at its one path',
    ]);
    strict = refusedCorpus(scratch, 'strict', []);
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
    // Two corpora and two databases: the runs share nothing, so they run side by side.
    const [excused, failed] = await Promise.all([
      published(scratch, allowed, args(`allowed-${verb.replaceAll(' ', '-')}-db`)),
      published(scratch, strict, args(`strict-${verb.replaceAll(' ', '-')}-db`)),
    ]);

    expect(refusedIn(excused.report), excused.stderr).toStrictEqual([]);
    expect(excused.status, excused.stderr).toBe(0);
    expect(refusedIn(failed.report), failed.stderr).toStrictEqual([expect.objectContaining({ severity: 'error', location: 'docs/deep.md' })]);
    expect(failed.status, failed.stderr).toBe(1);
  });

  // `resources check` is not the run of the project's allow list: it resolves
  // through `resolveFindings`, which drains no ledger. An expired entry still
  // excuses the file, and neither it nor an entry matching nothing is reported.
  it('resources check: an expired entry still excuses it, and no allow-ledger code is reported', async () => {
    const lapsed = refusedCorpus(scratch, 'lapsed', [
      '  validation:',
      '    allow:',
      `      ${REFUSED_CODE}:`,
      '        - paths: ["docs/deep.md"]',
      '          reason: seeded refusal, excused long ago',
      '          expires: "2000-01-01"',
      '        - paths: ["never/**"]',
      '          reason: seeded entry matching nothing',
    ]);

    const { status, report, stderr } = await published(scratch, lapsed, ['resources', 'check']);

    expect(report.findings.map((finding) => finding.code), stderr).toStrictEqual([]);
    expect(status, stderr).toBe(0);
  });
});
