/**
 * One whole `populate()`, in its own OS process, against a shared store.
 *
 * The sibling of `store-writer-child.mjs`, and it exists because that one
 * deliberately writes **synthetic** bundles: it proves the storage engine
 * survives contention, and says nothing about whether a real population is
 * reusable. This script runs the real driver over a real corpus, so what the
 * parent compares is a projection contributors produced rather than rows a test
 * invented.
 *
 * A separate **process**, not a worker thread, for the same reason the writer
 * child is: POSIX advisory locks are held per process, and two connections
 * inside one process are arbitrated by SQLite's own machinery instead of by the
 * file locks a second process takes. A thread-based harness would pass without
 * touching the claim. It is also the shape of the claim itself — `vat validate`,
 * `vat verify` and `vat build` each `spawnSync` the vat binary, so nothing is
 * ever shared in-process and the only reuse a store can deliver is a later
 * invocation reading what an earlier one derived.
 *
 * Imports the built packages rather than the sources, because this runs under
 * plain `node` with no TypeScript loader — which is why the package's own
 * `build` is a dependency of `test:integration` (see `turbo.json`).
 *
 * Usage:
 *   node store-sharing-child.mjs <corpusRoot> <storeDirectory> <treeHash> <question> <outputPath>
 *
 *   question `broad`  — filesystem extent + the `alpha` and `beta` closures
 *   question `narrow` — filesystem extent + the `gamma` closure alone
 *
 * The result is written to `outputPath` as JSON rather than printed, so a stray
 * warning on stdout cannot corrupt the parent's oracle. (`node:sqlite` prints
 * an experimental-feature warning on every start, which is exactly that hazard.)
 */

import { writeFileSync } from 'node:fs';

import { openSqliteProjectionStore } from '@vibe-agent-toolkit/projection-sqlite';
import {
  ClosureExtentContributor,
  ContributorRegistry,
  exportProjection,
  FilesystemExtentContributor,
  populate,
} from '@vibe-agent-toolkit/resources';

/** The `resolution_contexts.kind` every closure extent here is registered under. */
const SKILL_KIND = 'skill';

/** The document the fixture's reference chain starts from. */
const ROOT_DOC = 'skills/foo/SKILL.md';

/** The middle of the chain — `SKILL.md → b.md → c.md`. */
const DOC_B = 'skills/foo/b.md';

/** The end of the chain. */
const DOC_C = 'skills/foo/c.md';

/** The one reference form these declarations follow — the fixture's links are markdown. */
const MARKDOWN_LINK = 'markdown-link';

/**
 * The three closure declarations, spelled **once, here**, and shared by every
 * process.
 *
 * Not a parent-supplied argument, on purpose. A stored extent answers a run only
 * when `zone_provenance.parameterSet` matches the parameters that run asked
 * under, so two processes that spell one declaration differently — a reordered
 * key, a number written as a string — ask *different* questions and every read
 * misses. Keeping the literal in one module makes "the same question" a property
 * of the code rather than of two call sites happening to agree.
 */
const DECLARATIONS = {
  'closure:alpha': { kind: SKILL_KIND, closureFrom: ROOT_DOC, follow: [MARKDOWN_LINK], maxDepth: 'full' },
  'closure:beta': { kind: SKILL_KIND, closureFrom: DOC_B, follow: [MARKDOWN_LINK], maxDepth: 'full' },
  'closure:gamma': { kind: SKILL_KIND, closureFrom: DOC_C, follow: [MARKDOWN_LINK], maxDepth: 'full' },
};

/**
 * Which closure extents each question declares, beside the filesystem extent.
 *
 * `narrow` names an extent `broad` never declares rather than a subset of
 * `broad`'s. A strict subset would be answered by a store holding `broad`'s
 * write and the run would hit, writing nothing — so the *write* is what has to
 * be narrower here, not the question. See the additive arm in
 * `store-sharing.integration.test.ts`.
 */
const QUESTIONS = {
  broad: ['alpha', 'beta'],
  narrow: ['gamma'],
};

/**
 * Build the registry one question asks under.
 *
 * @param question - `broad` or `narrow`
 * @returns The filesystem extent plus that question's closure extents
 */
function registryFor(question) {
  const closures = QUESTIONS[question];
  if (closures === undefined) {
    throw new Error(`unknown question "${question}"; expected one of ${Object.keys(QUESTIONS).join(', ')}.`);
  }
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());
  for (const name of closures) registry.register(new ClosureExtentContributor(name, SKILL_KIND));
  return registry;
}

const [corpusRoot, storeDirectory, treeHash, question, outputPath] = process.argv.slice(2);

const store = openSqliteProjectionStore({ directory: storeDirectory });

/**
 * Every contributor invocation this process performed, as `id@pass`.
 *
 * Empty is the **observable signature of a hit**: `populate` short-circuits
 * before the builder exists, so on a hit nothing can have run. Identical
 * documents alone would not prove reuse — a correct re-population of an
 * unchanged tree produces the identical document too, which is precisely what
 * makes the document usable as an oracle. Only the absence of work proves the
 * store answered.
 */
const contributorRuns = [];

try {
  const projection = await populate({
    root: corpusRoot,
    registry: registryFor(question),
    // Every declaration is handed over on every run, registered or not:
    // `requestedContributors` reads the registry and ignores a parameter set
    // nobody claims, so one constant keeps each contributor's parameter set
    // identical across processes and across questions.
    parameters: DECLARATIONS,
    onContributorTiming: (timing) => {
      contributorRuns.push(`${timing.contributorId}@${timing.pass}`);
    },
    cache: { store, treeHash },
  });

  // `exportProjection` sorts every table by its primary key and redacts the one
  // column that legitimately varies between two runs (`roots.path`, an absolute
  // path). That is what turns "process B hydrated what process A derived" into
  // a comparison rather than a judgement call.
  //
  // The tables travel structurally rather than as `serializeProjection`'s
  // string, because the parent must canonicalize key order before comparing —
  // see the note on the oracle in `store-sharing.integration.test.ts`.
  const { tables } = exportProjection(projection);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the parent supplies this path, beneath its own mkdtemp root
  writeFileSync(
    outputPath,
    JSON.stringify({
      contributorRuns,
      tables,
      counts: Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length])),
    }),
    'utf-8',
  );
} finally {
  await store.close();
}
