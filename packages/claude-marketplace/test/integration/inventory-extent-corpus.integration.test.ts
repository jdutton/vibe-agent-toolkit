/**
 * The **inventory** extent, run as a shadow of the walk `extract-skill.ts`
 * actually performs — the membership-only consumer of `walkLinkGraph`, and the
 * one lane a closure extent could replace outright.
 *
 * The sibling of `packages/cli/test/integration/projection-skill-extent-corpus.integration.test.ts`,
 * and deliberately built to its shape: sweep a real corpus, compare membership in
 * BOTH directions, attribute every difference to the walker's own stated reason,
 * assert the compared population is non-zero, and control the result by stripping
 * the new vocabulary from the declaration the shipped translation just produced.
 * Read that file for why each of those is there; this note states only what is
 * different.
 *
 * ## What is different: the walk, and the git oracle
 *
 * `collectLinkedFiles` is not the packager's walk. It runs at `maxDepth: Infinity`
 * with no exclude rules, no `deferredArtifacts`, and `excludeNavigationFiles: true`
 * as a literal — and it reads only `bundledResources[].filePath` and
 * `bundledAssets`. Nothing else in `LinkGraphResult` reaches a caller, which is
 * what makes membership the whole contract here rather than one half of it.
 *
 * It also takes an OPTIONAL `GitTracker`, and that option is a fork in the
 * comparison rather than a tuning knob:
 *
 * - **Tracker supplied.** The walker answers gitignore from the active set; the
 *   projection fills `resource_realizations.gitignored`, and the declaration's
 *   `flags` rule can refuse on it. Both arms can see the same fact.
 * - **No tracker.** The walker still answers — `readGitignored` spawns
 *   `git check-ignore` per target — while the projection's `gitignored` column is
 *   `false` on every row, because `FilesystemExtentContributor` fills it only from
 *   a tracker it was given. The closure therefore CANNOT refuse a gitignored
 *   target in this state, and no declaration can make it.
 *
 * That asymmetry is not a thing this file works around; it is a thing this file
 * MEASURES, once per state, over a corpus built so the two states can differ.
 * {@link FIXTURE_CORPUS} exists for exactly that: the real repository turned out
 * to link nothing gitignored from any SKILL.md, so on it the two states agree and
 * the `flags` rule is unfalsifiable. A corpus that cannot make the two answers
 * differ makes an equality over it vacuous
 * ([[fixtures-that-cannot-distinguish]]).
 *
 * ## Both arms are driven the way `extract-skill.ts` drives them
 *
 * - **Walker arm.** `crawlSkillLinkRegistry(root)` — the markdown-only registry
 *   the extractor builds, NOT `createProjectRegistry` — then one `walkLinkGraph`
 *   per skill with {@link walkOptionsFor}, which is `collectLinkedFiles`'s option
 *   object transcribed, conditional `gitTracker` assignment included.
 * - **Closure arm.** One `populate()` per (root, tracker state), with the
 *   filesystem extent and one {@link InventorySkillExtentContributor} per skill.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';

import {
  walkLinkGraph,
  type LinkResolution,
  type WalkLinkGraphOptions,
  type WalkableRegistry,
} from '@vibe-agent-toolkit/agent-skills';
import {
  ContributorRegistry,
  DISCARD_BLOB_POPULATION,
  FilesystemExtentContributor,
  ProjectionBuilder,
  populate,
  type JsonValue,
  type Projection,
  type ProjectionBase,
} from '@vibe-agent-toolkit/resources';
import { crawlDirectory, GitTracker, mkdirSyncReal, normalizedTmpdir, runGitOrThrow, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import { crawlSkillLinkRegistry, INVENTORY_REFUSED_GITIGNORED, inventoryExtentContributorId, inventoryExtentDeclaration, InventorySkillExtentContributor } from '../../src/index.js';

// ============================================================================
// The corpora
// ============================================================================

/** The repository root, three levels up from this file. */
const REPO_ROOT = safePath.resolve(__dirname, '..', '..', '..', '..');

/** A VAT project in this repository that ships real, linked skills. */
const DEV_AGENTS = 'packages/vat-development-agents';

/** The label {@link FIXTURE_CORPUS} is built and reported under. */
const FIXTURE_LABEL = 'fixture/gitignored';

/** One corpus: an absolute root, and the skills discovered beneath it. */
interface CorpusSpec {
  /** Stable name, appearing in every printed table. */
  readonly label: string;
  /** Absolute root every path is stated against, and both arms are driven from. */
  readonly root: string;
  /** What this corpus is for — printed with the run. */
  readonly note: string;
}

/** The state in which both arms can see gitignore. */
const WITH_TRACKER = 'with-tracker';

/** The state in which only the WALKER can — see the module note. */
const NO_TRACKER = 'no-tracker';

/** Whether the walk and the population were handed a git oracle. */
type TrackerState = typeof WITH_TRACKER | typeof NO_TRACKER;

/** Both states, always swept together — a rule gated on one is untested by the other. */
const TRACKER_STATES: readonly TrackerState[] = [WITH_TRACKER, NO_TRACKER];

/** One skill of a corpus: what `extract-skill.ts` is handed, in both coordinate systems. */
interface CorpusSkill {
  /** Discriminator for the extent and the contributor id — the root-relative path. */
  readonly name: string;
  /** Absolute path to SKILL.md, as `extractClaudeSkillInventory` resolves it. */
  readonly absolutePath: string;
  /** Root-relative, forward-slashed — how `resource_realizations.path` spells it. */
  readonly relativePath: string;
}

/** One corpus at one tracker state, with both arms' inputs prepared. */
interface Corpus {
  readonly spec: CorpusSpec;
  readonly state: TrackerState;
  readonly skills: readonly CorpusSkill[];
  /** The walker's input: the markdown-only registry `crawlSkillLinkRegistry` builds. */
  readonly registry: WalkableRegistry;
  /** The closure arm's input: a real `populate()` of the same root, at this state. */
  readonly projection: Projection;
  /** A base rebuilt from {@link projection}, so one `contribute` can be repeated. */
  readonly base: ProjectionBase;
  /** Skill name → the `resolution_contexts.contextId` its extent got. */
  readonly extentIdByName: ReadonlyMap<string, string>;
  /** The oracle both arms share, or undefined in the `no-tracker` state. */
  readonly gitTracker: GitTracker | undefined;
  /** What each arm's preparation cost, in ms — where a flip's real cost lives. */
  readonly preparationMs: { readonly registry: number; readonly populate: number };
}

/**
 * The transitive divergence cause, borrowed verbatim from the sibling shadow: a
 * path neither arm's exclusion list names, because the walker never reached it.
 */
const PRUNED = 'pruned-behind-exclusion';

/** Why one path is in one arm and not the other — the walker's own verdict, or {@link PRUNED}. */
type DivergenceCause = NonNullable<LinkResolution['excludeReason']> | typeof PRUNED;

/** One path present in one arm and absent from the other, with its cause. */
interface AttributedPath {
  readonly path: string;
  readonly cause: DivergenceCause;
}

/** One skill's disagreement between the two arms, at one tracker state. */
interface Divergence {
  readonly corpus: string;
  readonly state: TrackerState;
  readonly skill: string;
  /** Linked by the walker, refused by the closure. */
  readonly walkerOnly: readonly string[];
  /** Admitted by the closure, refused by the walker, each with the walker's reason. */
  readonly closureOnly: readonly AttributedPath[];
}

/** Everything one walk produced, in the comparison's coordinate system. */
interface WalkerRun {
  /** Membership: the skill's own path plus everything `collectLinkedFiles` collects. */
  readonly members: string[];
  /** Every path the walker reached — bundled or refused, with the reason. */
  readonly seen: ReadonlyMap<string, DivergenceCause | 'bundled'>;
}

// ============================================================================
// The fixture corpus — the one that CAN distinguish the two tracker states
// ============================================================================

/** Files the fixture corpus is written from, as `path → contents`. */
const FIXTURE_FILES: Readonly<Record<string, string>> = {
  '.gitignore': 'ignored/\n',
  // Every link here reaches a DIFFERENT cascade branch, so all four declared
  // refusal rules — and the gitignore rule in particular — get a candidate to
  // judge. `doc.md` is the control: it must survive every rule, or "the cascade
  // refused something" would also be satisfied by a cascade that refused all.
  'skills/demo/SKILL.md': [
    '---', 'name: demo', 'description: fixture skill', '---', '',
    '- [ordinary](./doc.md)',
    '- [gitignored](../../ignored/secret.md)',
    '- [navigation](./README.md)',
    '- [agent instructions](./CLAUDE.md)',
    '- [a directory](./nested)',
    '- [an asset](./asset.txt)',
    '',
  ].join('\n'),
  'skills/demo/doc.md': '# doc\n',
  'skills/demo/README.md': '# readme\n\n[behind the hub](./behind-readme.md)\n',
  'skills/demo/behind-readme.md': '# behind readme\n',
  'skills/demo/CLAUDE.md': '# claude\n\n[behind claude](./behind-claude.md)\n',
  'skills/demo/behind-claude.md': '# behind claude\n',
  'skills/demo/nested/inner.md': '# inner\n',
  'skills/demo/asset.txt': 'asset\n',
  'ignored/secret.md': '# secret\n\n[behind the ignored hub](./behind-secret.md)\n',
  'ignored/behind-secret.md': '# behind secret\n',
};

/**
 * Write the fixture corpus into a fresh temp directory and commit it.
 *
 * `git init` + `add` + `commit` is not ceremony: `crawlSkillLinkRegistry` reaches
 * its file set through `git ls-files`, so an uncommitted tree yields an EMPTY
 * registry and every walk returns a singleton — a green run that measured nothing
 * ([[probe-project-needs-git-tracked-files]]). The `.gitignore` needs a
 * repository for the same reason ([[tmpdir-fixture-has-no-gitignore]]).
 *
 * @returns The absolute fixture root
 */
function buildFixtureCorpus(): string {
  const root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-inventory-extent-')));
  for (const [relative, contents] of Object.entries(FIXTURE_FILES)) {
    const absolute = safePath.join(root, relative);
    mkdirSyncReal(safePath.join(absolute, '..'), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path this function just composed under its own mkdtemp root
    writeFileSync(absolute, contents, 'utf-8');
  }
  runGitOrThrow(['init', '-q'], { cwd: root });
  runGitOrThrow(['add', '-A'], { cwd: root });
  runGitOrThrow(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

/** The fixture root, built once in `beforeAll`. */
let FIXTURE_ROOT = '';

/** The message every fixture case throws when discovery lost the one skill. */
const NO_FIXTURE_SKILL = 'fixture lost its skill';

/** The paths only the gitignore rule can keep out — the fixture's whole reason for existing. */
const IGNORED_PATHS = ['ignored/secret.md', 'ignored/behind-secret.md'] as const;

// ============================================================================
// Corpus assembly
// ============================================================================

/**
 * Every SKILL.md beneath a root, as `extractClaudeSkillInventory` would be
 * pointed at them.
 *
 * Discovery is a crawl and not a config read, deliberately: `vat inventory`
 * reaches a skill by PATH (`inventory.ts`'s `endsWith('SKILL.md')` branch, and
 * the plugin extractor's `skills/` scan), never through `skills.include`. Driving
 * this sweep off the config would shadow a population production never uses.
 *
 * @param root - Absolute corpus root
 * @returns One entry per discovered skill, in crawl order
 */
async function discoverSkills(root: string): Promise<CorpusSkill[]> {
  const found = await crawlDirectory({
    baseDir: root,
    include: ['**/SKILL.md'],
    absolute: true,
    filesOnly: true,
    includeUntracked: true,
  });
  return found.map((absolute) => {
    const relativePath = toForwardSlash(safePath.relative(root, absolute));
    return { name: relativePath, absolutePath: safePath.resolve(absolute), relativePath };
  });
}

/**
 * Rebuild a `ProjectionBase` holding only what a closure walk reads.
 *
 * Copied from the populated projection rather than re-derived, so the repeated
 * `contribute` the negative control needs is the same computation over the same
 * edges — the sibling shadow's `baseFrom`, for its reasons.
 *
 * @param root - Absolute project root
 * @param projection - The populated projection to copy rows from
 * @param extentIds - Skill-extent ids, whose realization rows duplicate the
 *   filesystem rows and are dropped
 * @param gitTracker - The oracle this population ran under, carried onto the base
 * @returns A base carrying the base-stratum realizations and every blob reference
 */
function baseFrom(
  root: string,
  projection: Projection,
  extentIds: ReadonlySet<string>,
  gitTracker: GitTracker | undefined,
): ProjectionBase {
  const builder = new ProjectionBuilder(root, gitTracker);
  builder.addRoot({ id: builder.identities.rootId, path: safePath.resolve(root) });

  for (const row of projection.resources) builder.addResource(row);
  for (const row of projection.resourceRealizations) {
    if (!extentIds.has(row.extentId)) builder.addRealization(row);
  }
  for (const row of projection.blobReferences) builder.addBlobReference(row);

  return builder.base();
}

/**
 * Populate one corpus at one tracker state, with one inventory extent per skill.
 *
 * @param root - Absolute project root
 * @param skills - The discovered skills
 * @param gitTracker - The run's oracle, or undefined in the `no-tracker` state
 * @returns The projection, and the extent id each skill's contributor produced
 */
async function populateCorpus(
  root: string,
  skills: readonly CorpusSkill[],
  gitTracker: GitTracker | undefined,
): Promise<{ projection: Projection; extentIdByName: Map<string, string> }> {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());

  const parameters: Record<string, JsonValue> = {};
  for (const skill of skills) {
    registry.register(new InventorySkillExtentContributor(skill.name));
    parameters[inventoryExtentContributorId(skill.name)] = declarationFor(skill, gitTracker !== undefined);
  }

  const projection = await populate({
    root,
    registry,
    parameters,
    onBlobPopulation: DISCARD_BLOB_POPULATION,
    ...(gitTracker !== undefined && { gitTracker }),
  });

  const extentIdByName = new Map<string, string>();
  for (const skill of skills) {
    const contributorId = inventoryExtentContributorId(skill.name);
    const row = projection.zoneProvenance.find((entry) => entry.contributorId === contributorId);
    if (row === undefined) throw new Error(`No provenance row for ${contributorId}`);
    extentIdByName.set(skill.name, row.contextId);
  }

  return { projection, extentIdByName };
}

/** Assemble both arms' inputs for one corpus at one tracker state. */
async function corpusOf(spec: CorpusSpec, state: TrackerState): Promise<Corpus> {
  const skills = await discoverSkills(spec.root);

  let gitTracker: GitTracker | undefined;
  if (state === WITH_TRACKER) {
    gitTracker = new GitTracker(spec.root);
    await gitTracker.initialize();
  }

  const registryStartedAt = performance.now();
  const registry = await crawlSkillLinkRegistry(spec.root);
  const registryMs = performance.now() - registryStartedAt;

  const populateStartedAt = performance.now();
  const { projection, extentIdByName } = await populateCorpus(spec.root, skills, gitTracker);
  const populateMs = performance.now() - populateStartedAt;

  return {
    spec,
    state,
    skills,
    registry: registry as unknown as WalkableRegistry,
    projection,
    base: baseFrom(spec.root, projection, new Set(extentIdByName.values()), gitTracker),
    extentIdByName,
    gitTracker,
    preparationMs: { registry: registryMs, populate: populateMs },
  };
}

// ============================================================================
// The two arms
// ============================================================================

/** Order by UTF-16 code unit — never `localeCompare`, whose collation is locale-dependent. */
function byCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** The comparison currency: a deduplicated, deterministically ordered path set. */
function pathSet(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort(byCodeUnit);
}

/** Members of `left` that `right` does not have. */
function only(left: readonly string[], right: readonly string[]): string[] {
  const other = new Set(right);
  return left.filter((path) => !other.has(path));
}

/** Whether the declaration carries the `flags` vocabulary, or the control stripped it. */
type Narrowing = 'on' | 'off';

/**
 * One skill's declaration, as `PopulateOptions.parameters` carries it.
 *
 * The control removes the gitignore rule BY LABEL from the declaration
 * {@link inventoryExtentDeclaration} actually produced, never by rebuilding a
 * "before" declaration by hand — a hand-built control keeps agreeing after the
 * translation changes, and so controls nothing.
 */
// `JsonValue` IS a union by definition and is the declared parameter type of both
// `populate` and `contribute`; narrowing this return only moves the cast to every
// call site.
// eslint-disable-next-line sonarjs/function-return-type -- see the note above
function declarationFor(
  skill: CorpusSkill,
  hasGitTracker: boolean,
  narrowing: Narrowing = 'on',
): JsonValue {
  const declaration = inventoryExtentDeclaration(
    skill.relativePath,
    hasGitTracker,
  ) as unknown as Record<string, unknown>;
  if (narrowing === 'on') return declaration as JsonValue;
  return {
    ...declaration,
    refusals: (declaration['refusals'] as readonly { readonly label: string }[])
      .filter((rule) => rule.label !== INVENTORY_REFUSED_GITIGNORED),
  } as JsonValue;
}

/** The refusal labels a real declaration's cascade carries, in cascade order. */
function refusalLabelsOf(declaration: JsonValue): string[] {
  const refusals = (declaration as Record<string, unknown>)['refusals'];
  return (refusals as readonly { readonly label: string }[]).map((rule) => rule.label);
}

/**
 * `collectLinkedFiles`'s option object, transcribed.
 *
 * The conditional `gitTracker` assignment is reproduced rather than collapsed to
 * a literal `undefined`: `exactOptionalPropertyTypes` forbids the literal, and
 * the option object this shadow hands the walker must be key-for-key the one
 * production hands it.
 *
 * @param corpus - The corpus (and tracker state) the skill belongs to
 * @param skill - The skill being walked
 * @returns Options for {@link walkLinkGraph}
 */
function walkOptionsFor(corpus: Corpus, skill: CorpusSkill): WalkLinkGraphOptions {
  const options: WalkLinkGraphOptions = {
    maxDepth: Infinity,
    excludeRules: [],
    projectRoot: corpus.spec.root,
    skillRootPath: skill.absolutePath,
    excludeNavigationFiles: true,
  };
  if (corpus.gitTracker !== undefined) {
    options.gitTracker = corpus.gitTracker;
  }
  return options;
}

/**
 * Run `walkLinkGraph` for one skill and record what `collectLinkedFiles` would
 * collect, plus every path the walker refused and why.
 *
 * Membership is `bundledResources[].filePath` ∪ `bundledAssets` ∪ the skill's own
 * path — the first two are literally the two loops in `collectLinkedFiles`, and
 * the third is what makes the two sets describe the same thing (the walk's own
 * root is never listed in `bundledResources`, while `closureFrom` is a member).
 *
 * @param corpus - The corpus the skill belongs to
 * @param skill - The skill being walked
 * @returns Root-relative membership, and every path the walker reached
 */
function walkerRun(corpus: Corpus, skill: CorpusSkill): WalkerRun {
  const result = walkLinkGraph(
    corpus.registry.getResource(skill.absolutePath)?.id ?? '',
    corpus.registry,
    walkOptionsFor(corpus, skill),
  );
  const relative = (absolute: string): string =>
    toForwardSlash(safePath.relative(corpus.spec.root, absolute));

  const members = pathSet([
    skill.relativePath,
    ...result.bundledResources.map((resource) => relative(resource.filePath)),
    ...result.bundledAssets.map(relative),
  ]);

  const seen = new Map<string, DivergenceCause | 'bundled'>();
  for (const path of members) seen.set(path, 'bundled');
  for (const reference of result.excludedReferences) {
    // `bundled` wins: one path can be reached twice, refused on one route and
    // admitted on another, and it is a member either way.
    const path = relative(reference.path);
    if (seen.get(path) === 'bundled') continue;
    seen.set(path, reference.excludeReason ?? PRUNED);
  }

  return { members, seen };
}

/** One inventory extent's membership, as the populated projection recorded it. */
function projectedMembers(corpus: Corpus, skill: CorpusSkill): string[] {
  const extentId = corpus.extentIdByName.get(skill.name);
  return pathSet(corpus.projection.resourceRealizations
    .filter((row) => row.extentId === extentId)
    .map((row) => row.path));
}

/**
 * The closure's membership for one skill under an arbitrary narrowing.
 *
 * Runs the same contributor `populate` ran, over the base rebuilt from that
 * population — the only way to vary a declaration without re-crawling the corpus.
 */
async function closureRun(
  corpus: Corpus,
  skill: CorpusSkill,
  narrowing: Narrowing = 'on',
): Promise<string[]> {
  const contribution = await new InventorySkillExtentContributor(skill.name)
    .contribute(corpus.base, declarationFor(skill, corpus.gitTracker !== undefined, narrowing));
  return pathSet(contribution.realizations.map((row) => row.path));
}

/** Both arms for one skill, and their attributed difference. */
async function compareSkill(
  corpus: Corpus,
  skill: CorpusSkill,
  narrowing: Narrowing = 'on',
): Promise<{ walker: string[]; closure: string[]; divergence: Divergence | undefined }> {
  const walk = walkerRun(corpus, skill);
  const closure = await closureRun(corpus, skill, narrowing);
  const walkerOnly = only(walk.members, closure);
  const closureOnly = only(closure, walk.members).map((path) => ({
    path,
    // The walker's own verdict where it has one; otherwise it never reached the
    // path at all, which is the transitive case.
    cause: (walk.seen.get(path) ?? PRUNED) as DivergenceCause,
  }));

  const divergence = walkerOnly.length === 0 && closureOnly.length === 0
    ? undefined
    : { corpus: corpus.spec.label, state: corpus.state, skill: skill.name, walkerOnly, closureOnly };
  return { walker: walk.members, closure, divergence };
}

/** What one pass over one corpus produced. */
interface SweepResult {
  readonly divergences: Divergence[];
  /** One printable row per skill. */
  readonly rows: Record<string, unknown>[];
  /** Cells in which either arm admitted more than the SKILL.md alone. */
  readonly followed: number;
  /** Paths compared, summed over every skill — the anti-vacuity population. */
  readonly compared: number;
}

/** Run both arms over every skill of one corpus. */
async function sweep(corpus: Corpus, narrowing: Narrowing = 'on'): Promise<SweepResult> {
  const divergences: Divergence[] = [];
  const rows: Record<string, unknown>[] = [];
  let followed = 0;
  let compared = 0;

  for (const skill of corpus.skills) {
    const { walker, closure, divergence } = await compareSkill(corpus, skill, narrowing);
    if (divergence !== undefined) divergences.push(divergence);
    if (walker.length > 1 || closure.length > 1) followed += 1;
    compared += new Set([...walker, ...closure]).size;
    rows.push({
      corpus: corpus.spec.label,
      state: corpus.state,
      skill: skill.name,
      walker: walker.length,
      closure: closure.length,
      agree: divergence === undefined,
    });
  }

  return { divergences, rows, followed, compared };
}

/** Render a divergence so a failure names the corpus, the state, the skill and the cause. */
function renderDivergences(divergences: readonly Divergence[]): string[] {
  return divergences.map((row) => `${row.corpus}[${row.state}]/${row.skill}: `
    + row.closureOnly.map((entry) => `${entry.path} (${entry.cause})`).join(', ')
    + (row.walkerOnly.length > 0 ? ` | walker-only: ${row.walkerOnly.join(', ')}` : ''));
}

// ============================================================================
// Setup
// ============================================================================

let corpora: Corpus[];

/** One corpus at one state, looked up by label and state. */
function corpusAt(label: string, state: TrackerState): Corpus {
  const found = corpora.find((entry) => entry.spec.label === label && entry.state === state);
  if (found === undefined) throw new Error(`no corpus ${label}[${state}]`);
  return found;
}

/** The fixture corpus and its two ambient siblings, in increasing order of what they distinguish. */
const FIXTURE_CORPUS = FIXTURE_LABEL;

beforeAll(async () => {
  FIXTURE_ROOT = buildFixtureCorpus();
  const specs: CorpusSpec[] = [
    {
      label: 'production/dev-agents',
      root: safePath.join(REPO_ROOT, DEV_AGENTS),
      note: 'the root findProjectRoot resolves for these skills',
    },
    {
      label: 'repo-root',
      root: REPO_ROOT,
      note: 'same skills, wider root — turns ../../ pointers into in-project edges',
    },
    {
      label: FIXTURE_CORPUS,
      root: FIXTURE_ROOT,
      note: 'the only corpus with a gitignored link target — what makes the flags rule falsifiable',
    },
  ];

  corpora = [];
  for (const spec of specs) {
    for (const state of TRACKER_STATES) {
      // Sequential: each entry crawls and populates a whole project, and two at
      // once would put two full crawls in flight for no shorter test.
      corpora.push(await corpusOf(spec, state));
    }
  }

  console.table(corpora.map((corpus) => ({
    corpus: corpus.spec.label,
    state: corpus.state,
    skills: corpus.skills.length,
    realizations: corpus.projection.resourceRealizations.length,
    'reference candidates': corpus.projection.blobReferences.length,
    'crawlSkillLinkRegistry ms': Number(corpus.preparationMs.registry.toFixed(0)),
    'populate ms': Number(corpus.preparationMs.populate.toFixed(0)),
  })));
}, 3_600_000);

// ============================================================================
// The experiment
// ============================================================================

describe('inventory extent as a shadow of collectLinkedFiles', () => {
  it('agrees on membership in BOTH gitTracker states, or names every difference', async () => {
    const divergences: Divergence[] = [];
    const rows: Record<string, unknown>[] = [];
    let followed = 0;
    let compared = 0;

    for (const corpus of corpora) {
      if (corpus.spec.label === FIXTURE_CORPUS) continue;
      const result = await sweep(corpus);
      divergences.push(...result.divergences);
      rows.push(...result.rows);
      followed += result.followed;
      compared += result.compared;
      // The arm the sweep compares must be the one `populate` actually ran, or
      // every figure here describes something else.
      for (const skill of corpus.skills) {
        expect(await closureRun(corpus, skill)).toEqual(projectedMembers(corpus, skill));
      }
    }

    console.table(rows.filter((row) => (row['walker'] as number) > 1 || (row['closure'] as number) > 1));
    console.log(`[real corpus] ${rows.length} (corpus, state, skill) cells,`
      + ` ${followed} following an edge, ${compared} distinct paths compared`);
    if (divergences.length > 0) console.log('[divergences]', JSON.stringify(divergences, null, 2));

    // Anti-vacuity FIRST: an empty divergence list over an empty sweep is the
    // pass a closure returning nothing would also give.
    expect(rows.length).toBeGreaterThan(0);
    expect(compared).toBeGreaterThan(rows.length);
    expect(followed).toBeGreaterThan(0);

    expect(renderDivergences(divergences)).toEqual([]);
  }, 1_800_000);

  it('FIXTURE: with a tracker, the gitignore rule closes the only remaining difference', async () => {
    const corpus = corpusAt(FIXTURE_CORPUS, WITH_TRACKER);
    const { divergences, rows, followed } = await sweep(corpus);
    console.table(rows);

    // The fixture must actually reach every branch, or agreement over it says
    // nothing. One skill, following six links.
    expect(followed).toBe(1);
    expect(renderDivergences(divergences)).toEqual([]);

    // …and the paths only this rule can keep out really are out of BOTH arms.
    const skill = corpus.skills[0];
    if (skill === undefined) throw new Error(NO_FIXTURE_SKILL);
    const { walker, closure } = await compareSkill(corpus, skill);
    for (const ignored of IGNORED_PATHS) {
      expect(walker).not.toContain(ignored);
      expect(closure).not.toContain(ignored);
    }
  }, 600_000);

  it('FIXTURE NEGATIVE CONTROL: stripping the gitignore rule brings the difference back', async () => {
    // Without this, the agreement above is unfalsifiable: it is exactly what a
    // corpus with no gitignored link target would report, and exactly what a rule
    // that never fired would report.
    const corpus = corpusAt(FIXTURE_CORPUS, WITH_TRACKER);
    const skill = corpus.skills[0];
    if (skill === undefined) throw new Error(NO_FIXTURE_SKILL);

    // The stripped label must EXIST on a real declaration, or the control is a
    // no-op that agrees with everything — the failure mode of every unchecked
    // exclusion list.
    const declaration = declarationFor(skill, true);
    expect(refusalLabelsOf(declaration)).toContain(INVENTORY_REFUSED_GITIGNORED);
    expect(refusalLabelsOf(declarationFor(skill, true, 'off')))
      .not.toContain(INVENTORY_REFUSED_GITIGNORED);
    // …and the control must strip THAT rule and nothing else.
    expect(refusalLabelsOf(declarationFor(skill, true, 'off')))
      .toEqual(refusalLabelsOf(declaration).filter((label) => label !== INVENTORY_REFUSED_GITIGNORED));

    const { divergences } = await sweep(corpus, 'off');
    const attributed = divergences.flatMap((row) => row.closureOnly);
    console.log('[control]', JSON.stringify(attributed));

    // The rule recovers EXACTLY the directly-linked hub, attributed to the
    // walker's own `gitignored` reason. So the rule is load-bearing and this
    // corpus can see it: without the rule the closure admits a file the walker
    // refuses, with it the two agree.
    expect(attributed).toEqual([{ path: IGNORED_PATHS[0], cause: 'gitignored' }]);

    // ⚠️ And NOT the file behind it, which is the interesting half. Everywhere
    // else in this family a refusal at a hub prunes the subtree behind it; here
    // the subtree was already unreachable for an unrelated reason, so the control
    // cannot demonstrate pruning and does not pretend to.
    //
    // The reason is `FilesystemExtentContributor`'s `contentDemand:
    // 'deferGitignored'`: with a tracker, a gitignored path is realized but NOT
    // keyed, so it has no blob and therefore no `blob_references` rows, and the
    // closure has no edges to follow out of it whatever the cascade says. Pinned
    // as a column comparison across the two states rather than asserted as a
    // story — a claim about WHY is worth nothing while the mechanism it names is
    // unmeasured.
    const keyedIn = (state: TrackerState): boolean => {
      const row = corpusAt(FIXTURE_CORPUS, state).projection.resourceRealizations
        .find((entry) => entry.path === IGNORED_PATHS[0]);
      if (row === undefined) throw new Error(`fixture lost ${IGNORED_PATHS[0]} at ${state}`);
      return row.contentKey !== null;
    };
    expect(keyedIn(WITH_TRACKER)).toBe(false);
    expect(keyedIn(NO_TRACKER)).toBe(true);

    // Still a superset in the closure's direction: nothing the walker linked went
    // missing, which is what makes this a NARROWING problem throughout.
    expect(divergences.flatMap((row) => row.walkerOnly)).toEqual([]);
  }, 600_000);

  it('FIXTURE: records what the NO-TRACKER state can and cannot do, as a measurement', async () => {
    // ⛔ The one place the two arms are NOT equivalent, pinned rather than left to
    // be discovered. `walkLinkGraph` answers gitignore with no tracker by spawning
    // `git check-ignore` per target; `FilesystemExtentContributor` fills
    // `resource_realizations.gitignored` only from a tracker it was given, so with
    // none the column is false everywhere and NO declaration can refuse on it.
    //
    // This is why `extract-skill.ts` must obtain a tracker of its own rather than
    // treat one as an optimization: the closure arm's correctness depends on it,
    // where the walker's only performance did.
    const corpus = corpusAt(FIXTURE_CORPUS, NO_TRACKER);
    const skill = corpus.skills[0];
    if (skill === undefined) throw new Error(NO_FIXTURE_SKILL);

    // The declaration is HONEST about it: no rule is emitted for a column the
    // population could not fill, rather than one emitted and silently inert.
    expect(refusalLabelsOf(declarationFor(skill, false))).not.toContain(INVENTORY_REFUSED_GITIGNORED);

    const { walker, closure, divergence } = await compareSkill(corpus, skill);
    console.log(`[no-tracker] walker=${walker.length} closure=${closure.length}`,
      JSON.stringify(divergence?.closureOnly ?? []));

    // Measured, not reasoned: the walker keeps them out, the closure cannot.
    for (const ignored of IGNORED_PATHS) {
      expect(walker).not.toContain(ignored);
      expect(closure).toContain(ignored);
    }
    expect(divergence?.walkerOnly).toEqual([]);
  }, 600_000);
});
