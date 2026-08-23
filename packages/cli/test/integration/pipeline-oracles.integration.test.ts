/**
 * The enumeration and parse-fact gates.
 *
 * VAT's existing correctness evidence is whole-command stdout diffs. Those
 * proved determinism superbly and answer exactly one question — *did the output
 * change?* — which is the wrong question for a change that touches enumeration,
 * parsing, projection and judgement at once. A red 1.81 MB diff cannot say
 * which of the four moved, and the thing a pipeline restructure most needs held
 * still is each lane's **population**, which no command output exposes.
 *
 * These goldens fill that gap. They are reviewed expected output, not a claim
 * that the output is correct: a drift failure is a prompt to read the diff.
 * When the change is intended, regenerate and review:
 *
 *     UPDATE_DRIFT_GOLDEN=1 bun run test:integration
 *
 * ⛔ The ordered golden is captured on the `git ls-files` route ONLY.
 * `crawlDirectory`'s other route is a recursive `readdirSync` walk, and readdir
 * order is a property of the filesystem — ext4's hashed directories, APFS and
 * NTFS all differ — so an ordered golden captured on one host would fail on
 * another for reasons that are not defects. The walk route gets a set-and-
 * attributes golden plus a within-host order-stability assertion instead.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- every path is derived
   from this file's own URL or from a mkdtemp root created here. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LANES,
  captureEnumerationSnapshot,
  captureParseFactSnapshot,
  diffParseFactRows,
  laneById,
  materializeTrapCorpus,
  renderEnumerationSnapshot,
  renderEnumerationSnapshotUnordered,
  renderParseFactSnapshot,
  type EnumerationSnapshot,
  type ParseFactSnapshot,
} from '../../src/pipeline-oracles/index.js';

const PACKAGE_ROOT = toForwardSlash(fileURLToPath(new URL('../../', import.meta.url)));
const GOLDEN_DIR = safePath.join(PACKAGE_ROOT, 'test', 'golden', 'pipeline-oracles');
const UPDATING = process.env.UPDATE_DRIFT_GOLDEN === '1';

/** Corpus labels — they are printed into the goldens, so they must not drift. */
const GIT_CORPUS = 'trap/git';
const NON_GIT_CORPUS = 'trap/non-git';

/** The corpus file listed in its own `.gitignore` — a member on one route only. */
const GITIGNORED_FILE = 'ignored/secret.md';

/**
 * Read a captured snapshot, failing the test rather than returning undefined.
 *
 * @param snapshots - The captured map
 * @param laneId - Lane to fetch
 * @returns The snapshot
 */
function required(snapshots: Map<string, EnumerationSnapshot>, laneId: string): EnumerationSnapshot {
  const snapshot = snapshots.get(laneId);
  if (snapshot === undefined) {
    throw new Error(`no snapshot captured for lane ${laneId}`);
  }
  return snapshot;
}

/**
 * Compare against a committed golden, or rewrite it when regenerating.
 *
 * @param name - Golden filename
 * @param actual - Rendered snapshot
 */
function expectGolden(name: string, actual: string): void {
  const goldenPath = safePath.join(GOLDEN_DIR, name);
  if (UPDATING) {
    mkdirSyncReal(GOLDEN_DIR, { recursive: true });
    writeFileSync(goldenPath, actual, 'utf-8');
    return;
  }
  expect(existsSync(goldenPath), `missing golden ${name} — regenerate with UPDATE_DRIFT_GOLDEN=1`).toBe(true);
  expect(readFileSync(goldenPath, 'utf-8'), `golden drift in ${name}`).toBe(actual);
}

/** A disposable corpus root, outside any repository until asked otherwise. */
function makeCorpusRoot(label: string): string {
  return mkdtempSync(safePath.join(normalizedTmpdir(), `vat-oracle-${label}-`));
}

/**
 * Parse everything the resources lane enumerates over a corpus.
 *
 * @param root - Corpus root
 * @returns The parse-fact snapshot
 */
async function captureCorpusFacts(root: string): Promise<ParseFactSnapshot> {
  const lane = laneById('resources');
  const snapshot = await captureEnumerationSnapshot(lane, { corpusRoot: root, corpus: NON_GIT_CORPUS });
  const absolute = snapshot.enumerated.map((row) => safePath.join(root, row.path));
  return captureParseFactSnapshot(absolute, { corpusRoot: root, corpus: NON_GIT_CORPUS });
}

describe('enumeration snapshot — git route (ordered golden)', () => {
  let root: string;
  const snapshots = new Map<string, EnumerationSnapshot>();

  beforeAll(async () => {
    root = makeCorpusRoot('git');
    // Symlinks are deliberately excluded from the golden corpora: creating them
    // needs a privilege Windows CI agents usually lack, so a corpus containing
    // them would have two legitimate shapes and no single golden. They get
    // their own test below, which says out loud when it cannot run.
    const built = materializeTrapCorpus(root, { initGit: true, skipSymlinks: true });
    expect(built.gitInitialized, 'git init failed — is git on PATH?').toBe(true);
    for (const lane of LANES) {
      snapshots.set(lane.id, await captureEnumerationSnapshot(lane, { corpusRoot: root, corpus: GIT_CORPUS }));
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each(LANES.map((lane) => lane.id))('%s matches its golden', (laneId) => {
    expectGolden(`enumeration.git.${laneId}.txt`, renderEnumerationSnapshot(required(snapshots, laneId)));
  });

  it('took the git route on every lane', () => {
    for (const [, snapshot] of snapshots) {
      expect(snapshot.route).toBe('git-ls-files');
    }
  });

  it('reports no restatement drift — the lane definitions still describe the real builders', () => {
    // If this fails, `lanes.ts` has drifted from the production code it claims
    // to describe, and every snapshot it produces is a fiction. Fix the lane
    // definition; do NOT regenerate the golden.
    for (const [laneId, snapshot] of snapshots) {
      expect(snapshot.restatementDrift, `lane ${laneId}`).toEqual([]);
    }
  });

  it('records a first-added-wins drop, and names which file won', () => {
    // Two distinct paths slugify to one resource id, so one of them is silently
    // dropped. Which one depends purely on arrival order — the property no
    // snapshot here may sort away.
    const snapshot = snapshots.get('resources');
    expect(snapshot?.collisions).toHaveLength(1);
    expect(snapshot?.collisions[0]?.existingPath).toBe('dup-hyphen/note.md');
    expect(snapshot?.collisions[0]?.conflictingPath).toBe('dup/hyphen-note.md');
  });

  it('shows the lanes disagreeing about what the corpus is', () => {
    // Not a defect to fix here — a divergence to hold still. Three lanes crawl
    // markdown only; two also crawl HTML. A restructure that silently unified
    // them would change which files are validated, and this is where that shows.
    const withHtml = snapshots.get('resources')?.enumerated.length ?? 0;
    const markdownOnly = snapshots.get('skills-build')?.enumerated.length ?? 0;
    expect(withHtml).toBeGreaterThan(markdownOnly);
    expect(snapshots.get('audit')?.enumerated.length).toBe(withHtml);
    expect(snapshots.get('inventory')?.enumerated.length).toBe(markdownOnly);
    expect(snapshots.get('skills-validate')?.enumerated.length).toBe(markdownOnly);
  });

  it('excludes gitignored files from the enumeration entirely', () => {
    // `git ls-files` cannot return an ignored path, which is why a `gitignored`
    // column on ENUMERATED rows is constant-false and the interesting question
    // is only ever about link targets.
    const resources = required(snapshots, 'resources');
    expect(resources.enumerated.map((row) => row.path)).not.toContain(GITIGNORED_FILE);
    for (const row of resources.enumerated) {
      expect(row.gitignored, `${row.path} should not be reported gitignored`).toBe(false);
    }
  });
});

describe('enumeration snapshot — walk route (no git anywhere above the corpus)', () => {
  let root: string;
  const snapshots = new Map<string, EnumerationSnapshot>();

  beforeAll(async () => {
    root = makeCorpusRoot('nogit');
    materializeTrapCorpus(root, { skipSymlinks: true });
    for (const lane of LANES) {
      snapshots.set(
        lane.id,
        await captureEnumerationSnapshot(lane, { corpusRoot: root, corpus: NON_GIT_CORPUS }),
      );
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('took the walk route — the corpus really is outside any repository', () => {
    // Every other VAT fixture is a git repo. That is what masked a defect worth
    // 88% of one command's runtime, because it cannot fire inside one.
    for (const [laneId, snapshot] of snapshots) {
      expect(snapshot.route, `lane ${laneId}`).toBe('walk');
      expect(snapshot.gitAvailable, `lane ${laneId}`).toBe(false);
    }
  });

  it.each(LANES.map((lane) => lane.id))('%s matches its set-and-attributes golden', (laneId) => {
    expectGolden(
      `enumeration.nogit.${laneId}.txt`,
      renderEnumerationSnapshotUnordered(required(snapshots, laneId)),
    );
  });

  it('is order-stable within a host, even though the order is not portable', async () => {
    // readdir order cannot be asserted across filesystems, but it MUST be
    // reproducible on one — first-added-wins means an unstable order changes
    // which colliding file survives from run to run.
    const lane = laneById('resources');
    const first = await captureEnumerationSnapshot(lane, { corpusRoot: root, corpus: NON_GIT_CORPUS });
    const second = await captureEnumerationSnapshot(lane, { corpusRoot: root, corpus: NON_GIT_CORPUS });
    expect(second.enumerated.map((row) => row.path)).toEqual(first.enumerated.map((row) => row.path));
    expect(second.admitted).toEqual(first.admitted);
  });

  it('includes the file that git would have hidden', () => {
    // `ignored/secret.md` is listed in .gitignore. Off the git route there is
    // no gitignore oracle at all, so it is simply a member. Same tree, one
    // variable, different population — stated rather than discovered later.
    const paths = snapshots.get('resources')?.enumerated.map((row) => row.path) ?? [];
    expect(paths).toContain(GITIGNORED_FILE);
  });
});

describe('parse-fact snapshot', () => {
  let root: string;

  beforeAll(() => {
    root = makeCorpusRoot('parse');
    materializeTrapCorpus(root, { skipSymlinks: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('matches its golden', async () => {
    expectGolden('parse-facts.nogit.txt', renderParseFactSnapshot(await captureCorpusFacts(root)));
  });

  it('parses EVERY path under a key and reports no disagreement', async () => {
    // The oracle used to parse the first path under each key and `continue` on
    // the rest — the cache's own assumption ("same key implies same facts")
    // implemented inside the instrument built to test it, leaving nothing to
    // compare. Both halves are asserted here: that a key with two paths exists
    // at all (or this check is vacuous), and that the independent parses agree.
    const facts = await captureCorpusFacts(root);

    const shared = Object.entries(facts.pathsByKey).filter(([, paths]) => paths.length > 1);
    expect(shared.length, 'no key has two paths — the comparison never runs').toBeGreaterThan(0);
    expect(shared.flatMap(([, paths]) => paths)).toEqual(
      expect.arrayContaining(['twins/left/same.md', 'twins/right/same.md']),
    );
    expect(facts.keyDisagreements).toEqual([]);
  });

  it('names the differing fields when two parses of one key disagree', () => {
    // A disagreement is unreachable from the corpus by construction — the whole
    // point is that it must stay that way — so the comparator is exercised on
    // fabricated rows. `[]` here would mean the section can never go non-empty.
    const facts = {
      contentKey: 'k',
      parserKind: 'markdown',
      sizeBytes: 10,
      estimatedTokenCount: 3,
      links: [],
      lexicalReferences: null,
      headings: [],
      frontmatterSource: null,
      frontmatterFields: null,
      anchors: null,
      decodedLength: 10,
      conditions: [],
      optionalArrays: [{ field: 'anchors', state: 'absent' as const }],
    };
    expect(diffParseFactRows(facts, { ...facts })).toEqual([]);
    expect(
      diffParseFactRows(facts, {
        ...facts,
        sizeBytes: 11,
        links: [
          {
            ordinal: 0,
            href: './x.md',
            text: 'x',
            type: 'local_file',
            line: 1,
            nodeType: 'link',
            resolvedId: 'leaked-from-another-skill',
          },
        ],
      }),
    ).toEqual(['links', 'sizeBytes']);
  });

  it('keys identical bytes at two extensions separately', async () => {
    // `empty.md` and `empty.html` are byte-identical. Git keys both as
    // e69de29…; their parse results are not the same, and a bytes-only key
    // would serve one for the other.
    const facts = await captureParseFactSnapshot(
      [safePath.join(root, 'empty.md'), safePath.join(root, 'empty.html')],
      { corpusRoot: root, corpus: 'empty-pair' },
    );
    expect(facts.rows).toHaveLength(2);
    expect(facts.rows[0]?.contentKey).not.toBe(facts.rows[1]?.contentKey);
    expect(new Set(facts.rows.map((row) => row.parserKind))).toEqual(new Set(['markdown', 'html']));
  });

  it('stores frontmatter as SOURCE, so a YAML round-trip cannot lose it', async () => {
    // `.inf`, `.nan` and `!!binary` all survive a YAML parse and are destroyed
    // by a JSON round-trip. A cache that stored the parsed object would hand
    // Ajv `Infinity` on a cold run and `null` on a warm one — same corpus, same
    // config, different reported issues.
    const facts = await captureParseFactSnapshot(
      [safePath.join(root, 'broken/exotic-frontmatter.md')],
      { corpusRoot: root, corpus: 'exotic' },
    );
    const source = facts.rows[0]?.frontmatterSource ?? '';
    expect(source).toContain('.inf');
    expect(source).toContain('.nan');
    expect(source).toContain('!!binary');
  });

  it('records parse-time oddities as conditions rather than throwing', async () => {
    const facts = await captureParseFactSnapshot(
      [
        safePath.join(root, 'broken/bad-frontmatter.md'),
        safePath.join(root, 'broken/dangling-reference.md'),
        safePath.join(root, 'broken/malformed.html'),
      ],
      { corpusRoot: root, corpus: 'broken' },
    );
    const codes = new Set(facts.rows.flatMap((row) => row.conditions.map((condition) => condition.code)));
    expect(codes).toContain('FRONTMATTER_INVALID_YAML');
    expect(codes).toContain('LINK_UNRESOLVED_REFERENCE');
    expect(codes).toContain('MALFORMED_HTML');
  });
});
