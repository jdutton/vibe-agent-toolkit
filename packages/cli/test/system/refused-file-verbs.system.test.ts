/**
 * A file whose parse was refused, or that could not be read, has one contract in every verb that
 * crawls (`not-admitted.ts` in `resources`): the same code, the same sentence, at its own path —
 * whether the cache was warm or cold, whether a skill reaches it or bundles it, and whether a link
 * anchor points into it. The population side of the same contract, and the allow entry that
 * excuses it, is `population-refusal-report.system.test.ts`.
 *
 * Isolation: `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and the temp directory (`TMPDIR`,
 * `TEMP`, `TMP`) all point into scratch, and no projection store is selected, so every run
 * derives.
 */

import { chmodSync, rmSync, truncateSync } from 'node:fs';

import { ParseLimitError, parseRefusal } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { MAX_DECODABLE_BYTES } from '@vibe-agent-toolkit/utils/fs';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeCorpus } from '../test-helpers.js';

import { corpus, published, publishedEach, refusedIn, REFUSED_CODE } from './population-refusal-fixtures.js';
import { createIsolatedScratch } from './test-common.js';

let scratch: string;

/** A mode that denies every read, and the one that restores it so the scratch can be removed. */
const UNREADABLE_MODE = 0o000;
const READABLE_MODE = 0o644;

// I0: the verdict never depends on cache warmth. A SKILL.md nesting thousands
// of blockquotes overflowed the in-process parse `skills validate` once ran;
// the crawl of `resources validate` parses it in a worker and files the facts,
// so a later `skills validate` was served them from the cache and admitted what
// the cold run refused (measured at 9,500: cold exit 1, warm exit 0). Every
// lane now parses in the bounded worker, so every run gives the worker's answer.
// The assertion holds whichever way a host's worker limits fall: `skills
// validate` agrees with the crawl, cold and warm.
describe('skills validate, cold and then warm, over a document the in-process parse overflows (system test)', () => {
  beforeAll(() => {
    scratch = createIsolatedScratch('vat-cold-warm-');
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each([9500, 10_000])('at %i nested blockquotes, exits with the crawl\'s code before and after the crawl warms the cache', async (depth) => {
    const deep = corpus(scratch, `cold-warm-${String(depth)}`, {
      'vibe-agent-toolkit.config.yaml': 'resources:\n  include: ["skills/**/*.md"]\nskills:\n  include:\n    - "skills/deep/SKILL.md"\n',
      'skills/deep/SKILL.md': '---\nname: deep\ndescription: deep - a skill whose body nests thousands of blockquotes, for the warmth test\n---\n\n'
        + `${'>'.repeat(depth)} deep\n`,
    });

    const cold = await published(scratch, deep, ['skills', 'validate']);
    const crawl = await published(scratch, deep, ['resources', 'validate']);
    const warm = await published(scratch, deep, ['skills', 'validate']);

    expect(cold.status, `cold: ${cold.stderr}\ncrawl: ${crawl.stderr}`).toBe(crawl.status);
    expect(warm.status, `warm: ${warm.stderr}`).toBe(cold.status);
    expect(refusedIn(warm.report).map((finding) => finding.location)).toStrictEqual(refusedIn(cold.report).map((finding) => finding.location));
  });
});

// A skill BUNDLING a document nested 10,000 blockquotes deep goes through every
// skill verb on the bounded route (ADR I11): the worker parses it, so `skills
// validate`, `skills build` and `skills package` give the verdict `resources
// validate` gives the same file. A lane that parsed it on its own thread would
// overflow the stack and refuse it (or crash), disagreeing with the crawl.
//
// Under the default limits the worker ADMITS it — its live heap is about 420 MiB,
// under the 1,024 MiB `heapMb`, and the garbage a loaded host leaves uncollected is
// never a breach (limits record, "Garbage is not a breach") — so every verb exits 0
// with no refusal. Each child runs
// with `NODE_OPTIONS` cleared: CI's `--max-old-space-size=512` lowers V8's ceiling,
// the pool then applies half of it (256 MiB), and the document is refused on every
// lane alike — the same verdict, but not the default one this pins
// (`docs/architecture/fact-extractors-limits.md`, heap under a small flag).
describe('a skill bundling a 10,000-level blockquote document (system test)', () => {
  const defaults = { NODE_OPTIONS: '' };
  let deep: string;
  // The crawl each skill verb is held to: one run, read by every case. No verb writes a document
  // `resources.include` matches, so a crawl after any of them would read the same corpus.
  let crawl: Awaited<ReturnType<typeof published>>;

  beforeAll(async () => {
    scratch = createIsolatedScratch('vat-deep-bundle-');
    deep = corpus(scratch, 'deep-bundle', {
      'vibe-agent-toolkit.config.yaml': 'resources:\n  include: ["skills/**/*.md"]\nskills:\n  include:\n    - "skills/deep/SKILL.md"\n',
      'skills/deep/SKILL.md': '---\nname: deep\ndescription: deep - a skill bundling a document that nests ten thousand blockquotes\n---\n\nSee [the deep document](./deep.md).\n',
      'skills/deep/deep.md': `${'>'.repeat(10_000)} deep\n`,
    });
    crawl = await published(scratch, deep, ['resources', 'validate'], defaults);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each([
    ['skills validate', ['skills', 'validate']],
    ['skills build', ['skills', 'build']],
    ['skills package', ['skills', 'package', 'skills/deep/SKILL.md', '-o', 'packaged']],
  ])('%s admits it, as resources validate does', async (_verb, args) => {
    const run = await published(scratch, deep, args, defaults);

    expect(crawl.status, crawl.stderr).toBe(0);
    expect(refusedIn(crawl.report), crawl.stderr).toStrictEqual([]);
    expect(run.status, `${run.stderr}\ncrawl: ${crawl.stderr}`).toBe(crawl.status);
    expect(refusedIn(run.report).map((finding) => finding.location), run.stderr)
      .toStrictEqual(refusedIn(crawl.report).map((finding) => finding.location));
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
    linked = corpus(scratch, 'linked', {
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
    const { status, report, stderr } = await published(scratch, linked, ['resources', 'validate']);
    const unverified = report.findings.filter((finding) => finding.code === 'LINK_TARGET_UNREADABLE');

    expect(unverified, stderr).toStrictEqual([expect.objectContaining({ severity: 'error', location: 'docs/a.md' })]);
    expect(unverified[0]?.message).toMatch(/its parse was stopped at its outputDepth limit \([^)]*\), so its anchors are unverified/);
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
    twins = corpus(scratch, 'twins', {
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
    for (const { report, stderr } of await publishedEach(scratch, twins, [['resources', 'validate'], ['resources', 'scan'], ['resources', 'check']])) {
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

// An unreadable file is not admitted in any verb: `validate` and `scan` meet it
// in the registry's crawl, `check` as an unreadable realization of the
// population. One contract (`notAdmittedFindings`): the same code, the same
// reason clause, at its own path, failing the run by default.
//
// Outside git, deliberately: in a repository the git snapshot reads every file
// git does not ignore, so an unreadable one refuses the whole run before any
// lane meets it — or does not, when git's stat cache spares the re-read.
// `chmod 000` denies nothing to uid 0 and means nothing on Windows.
describe.skipIf(CANNOT_DENY_READS)('an unreadable file, in every verb that crawls (system test)', () => {
  let locked: string;
  let lockedFile: string;

  beforeAll(() => {
    scratch = createIsolatedScratch('vat-not-admitted-unreadable-');
    locked = writeCorpus(safePath.join(scratch, 'locked'), {
      'vibe-agent-toolkit.config.yaml': 'resources:\n  include: ["docs/**/*.md"]\n',
      'docs/a.md': '# A\n',
      'docs/locked.md': '# Locked\n',
    });
    lockedFile = safePath.join(locked, 'docs/locked.md');
    chmodSync(lockedFile, UNREADABLE_MODE);
  });

  afterAll(() => {
    chmodSync(lockedFile, READABLE_MODE);
    rmSync(scratch, { recursive: true, force: true });
  });

  it('fails validate, scan and check with RESOURCE_UNREADABLE at its path, in one reason clause', async () => {
    const reasons = new Set<string>();
    for (const { args, status, report, stderr } of await publishedEach(scratch, locked, [['resources', 'validate'], ['resources', 'scan'], ['resources', 'check']])) {
      const unreadable = report.findings.filter((finding) => finding.code === 'RESOURCE_UNREADABLE');
      const verb = `${args.join(' ')}: ${stderr}`;

      expect(unreadable, verb).toStrictEqual([expect.objectContaining({ severity: 'error', location: 'docs/locked.md' })]);
      expect(status, verb).toBe(1);
      const lead = "'docs/locked.md' was enumerated but ";
      expect(unreadable[0]?.message.startsWith(lead), unreadable[0]?.message).toBe(true);
      reasons.add(unreadable[0]?.message.slice(lead.length).split(', so ')[0] ?? '');
    }
    // The registry's crawl names the errno; the population records the state
    // `unreadable` and no errno, so `check` says the same clause without it.
    expect([...reasons].sort((a, b) => a.localeCompare(b))).toStrictEqual(['could not be read', 'could not be read (EACCES)']);
  });
});

// A document past the parse input cap is refused by its size, before it is read, on every lane:
// `validate` meets it in the registry's read, `check` as a realization of the population. Sparse,
// and past what any string can hold, so a lane that read it first could not refuse it as the cap.
// No repository, so no snapshot reads it either.
describe('a document past the parse input cap, in every verb that crawls (system test)', () => {
  let oversize: string;

  beforeAll(() => {
    scratch = createIsolatedScratch('vat-not-admitted-oversize-');
    oversize = writeCorpus(safePath.join(scratch, 'oversize'), {
      'vibe-agent-toolkit.config.yaml': 'resources:\n  include: ["docs/**/*.md"]\n',
      'docs/a.md': '# A\n',
      'docs/huge.md': '',
    });
    truncateSync(safePath.join(oversize, 'docs/huge.md'), MAX_DECODABLE_BYTES + 1);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('fails validate and check alike, with RESOURCE_PARSE_LIMIT_EXCEEDED at its path, in one identical sentence', async () => {
    // The default cap, in the sentence every lane gives a parse refused at a limit, naming the cap
    // alone: a realization records no size, so no lane says one.
    const reason = parseRefusal(new ParseLimitError('inputBytes', 8 * 1024 * 1024)).reason;
    for (const { args, status, report, stderr } of await publishedEach(scratch, oversize, [['resources', 'validate'], ['resources', 'check']])) {
      const verb = `${args.join(' ')}: ${stderr}`;
      const found = report.findings.filter((finding) => finding.location === 'docs/huge.md');

      expect(found, verb).toStrictEqual([expect.objectContaining({ code: REFUSED_CODE, severity: 'error' })]);
      // The whole reason clause, bounded on both sides, so a lane that spells the cap its own way fails.
      expect(found[0]?.message, verb).toContain(`'docs/huge.md' was enumerated but ${reason}, so `);
      expect(status, verb).toBe(1);
    }
  });
});
