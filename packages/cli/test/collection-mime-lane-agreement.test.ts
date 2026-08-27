/**
 * Every lane that builds a `ResourceRegistry` must reach the SAME verdict about
 * whether a file is prose as the projection that enumerates it.
 *
 * A collection may declare a `mimeType` (`resources.collections.<name>.mimeType`)
 * that overrides `mime-type.ts`'s extension tables and so decides which parser
 * runs. `ResourceRegistry.admitResource` routes through a resolver built from
 * `this.config?.resources?.collections` — and its own comment says this lane
 * "must reach the same verdict the projection lane does or the two disagree
 * about whether a file is prose". A registry constructed with **no config** has
 * no declarations, silently falls back to the extension table, and disagrees.
 *
 * ## Why this suite lives in `cli` and not in `resources`
 *
 * The defect is not in `ResourceRegistry`. It is in the four SHIPPED
 * CONSTRUCTION SITES that hand the registry a projection-backed population and
 * no config, and those sites live in three different packages
 * (`agent-skills`, `claude-marketplace`, `cli`). `cli` is the only package that
 * depends on all three, so it is the only place one suite can hold every lane to
 * one contract. A `resources`-local suite could only re-test the class, which is
 * the half that already works.
 *
 * ## The oracle
 *
 * Two observables, one per lane, both derived from the same question:
 *
 * - **Registry**: `resource.headings.length`. Every fixture below opens with an
 *   ATX heading, so "the markdown parser ran" ⟺ "this resource has a heading".
 *   A file routed to no parser gets `unparsedResourceFacts` — empty headings,
 *   empty links — by TYPE, not by accident.
 * - **Projection**: the `contentKey` prefix on the `resource_realizations` row.
 *   The parser kind is part of the key's digest preimage, so the prefix IS the
 *   route (`none.<digest>` for a file nothing parses).
 *
 * 🪤 The two fixture documents carry DIFFERENT bytes on purpose. Blobs are
 * content-addressed, so byte-identical fixtures collapse into one blob and every
 * assertion below would describe whichever path sorted first.
 */

import { crawlAndResolveRegistry } from '@vibe-agent-toolkit/agent-skills';
import { crawlSkillLinkRegistry } from '@vibe-agent-toolkit/claude-marketplace';
import {
  ContributorRegistry,
  DISCARD_BLOB_POPULATION,
  FilesystemExtentContributor,
  ResourceRegistry,
  crawlSourceFor,
  populate,
  type CollectionConfig,
  type ProjectConfig,
} from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { buildSharedValidationContext, buildSkillsValidateRegistry } from '../src/commands/skills/validate.js';
import { laneById } from '../src/pipeline-oracles/lanes.js';
import { createLogger } from '../src/utils/logger.js';

import { setupCorpusFixture } from './pipeline-oracles/helpers/corpus-fixture.js';

/** The control document: nothing declares anything about it. */
const CONTROL = 'README.md';

/** The declared document: a `.md` file a collection types as NOT prose. */
const DECLARED = 'page.hbs.md';

/**
 * The type the `templates` collection declares.
 *
 * A private vocabulary term, which `CollectionConfigSchema` deliberately allows,
 * and — the load-bearing part — one that routes to NO document parser. That is
 * the realistic shape of this feature: a corpus of `.md` files that are
 * templates, recorded as what they are so nothing link-checks a `{{handlebars}}`
 * placeholder.
 */
const TEMPLATE_MIME = 'text/x-handlebars-template';

/**
 * The declarations under test.
 *
 * `*.hbs.md` is a ROOT-LEVEL pattern in `pattern-expander.ts`'s sense (it starts
 * with `*` and contains no `/`), so it is matched against the basename and needs
 * no directory in the fixture — which matters, because `replantableCorpus`
 * writes a flat tree and creates no subdirectories.
 */
const COLLECTIONS: Readonly<Record<string, CollectionConfig>> = {
  templates: { include: ['*.hbs.md'], mimeType: TEMPLATE_MIME },
};

/** The same declarations as a whole project config — ONE source, no drift. */
const CONFIG: ProjectConfig = { version: 1, resources: { collections: COLLECTIONS } };

/**
 * The corpus, config file included.
 *
 * The `vibe-agent-toolkit.config.yaml` is not decoration: it is what makes the
 * temp root a discoverable project root (`findProjectRoot`), which is how
 * `crawlAndResolveRegistry` and `crawlSkillLinkRegistry` are reached at all, and
 * it is generated from {@link CONFIG} so the on-disk declarations and the
 * in-memory ones cannot drift apart.
 */
const CORPUS: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': yaml.stringify(CONFIG),
  [CONTROL]: '# README — the control document\n\nLinks to [the template](./page.hbs.md).\n',
  [DECLARED]: '# page.hbs.md — declared a template, not prose\n\nLinks to [the readme](./README.md).\n',
};

const corpus = setupCorpusFixture('vat-collection-mime-lane-', CORPUS);

/** What a lane decided about one file: did a document parser run over it? */
type Verdict = 'parsed' | 'unparsed';

/** The verdict every lane must agree on, keyed by root-relative path. */
const EXPECTED: Readonly<Record<string, Verdict>> = {
  [CONTROL]: 'parsed',
  [DECLARED]: 'unparsed',
};

/**
 * Read a registry's verdict for both fixture documents.
 *
 * @param registry - The registry to interrogate
 * @returns Path → verdict, for exactly the two fixture documents
 */
function registryVerdicts(registry: ResourceRegistry): Record<string, Verdict> {
  const verdicts: Record<string, Verdict> = {};
  for (const name of [CONTROL, DECLARED]) {
    const resource = registry.getResource(safePath.join(corpus.root(), name));
    if (resource === undefined) {
      throw new Error(`the registry never admitted "${name}" — this lane is measuring nothing`);
    }
    verdicts[name] = resource.headings.length > 0 ? 'parsed' : 'unparsed';
  }
  return verdicts;
}

/**
 * Populate the fixture through the projection lane and read its verdicts.
 *
 * @returns Path → verdict, for exactly the two fixture documents
 */
async function projectionVerdicts(): Promise<Record<string, Verdict>> {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor(() => crawlSourceFor(corpus.root())));

  const projection = await populate({
    root: corpus.root(),
    registry,
    collections: COLLECTIONS,
    onBlobPopulation: DISCARD_BLOB_POPULATION,
  });

  const verdicts: Record<string, Verdict> = {};
  for (const name of [CONTROL, DECLARED]) {
    const row = projection.resourceRealizations.find((candidate) => candidate.path === name);
    if (row === undefined) {
      throw new Error(`the projection never realized "${name}" — this arm is measuring nothing`);
    }
    if (row.contentKey === null) {
      throw new Error(`"${name}" was never keyed (contentState "${row.contentState}") — no route to read`);
    }
    // The kind is the key's prefix, up to the first `.` — see `content-key.ts`.
    verdicts[name] = row.contentKey.startsWith('none.') ? 'unparsed' : 'parsed';
  }
  return verdicts;
}

describe('the projection lane and ResourceRegistry agree about a declared mimeType', () => {
  it('routes the declared file to NO parser on the projection lane', async () => {
    // The non-vacuity floor for every cross-lane comparison below. If the
    // projection did not itself honour the declaration, "the two lanes agree"
    // would be satisfiable by two lanes that both ignore it.
    await expect(projectionVerdicts()).resolves.toEqual(EXPECTED);
  });

  it('routes the declared file to NO parser in a config-bearing ResourceRegistry', async () => {
    // The class-level contract, and the branch nothing covered: replacing
    // `this.config?.resources?.collections` with `undefined` in
    // `admitResource` left the whole suite green before this existed.
    const registry = await ResourceRegistry.fromCrawl(
      { baseDir: corpus.root(), include: ['**/*.md'] },
      { config: CONFIG },
    );

    expect(registryVerdicts(registry)).toEqual(EXPECTED);
  });

  it('parses the declared file when the SAME registry is built without the config', async () => {
    // The mechanism, pinned as a positive fact rather than left as an inference:
    // the disagreement is caused by the absent config and by nothing else, so
    // every failing lane below has exactly one cause.
    const registry = await ResourceRegistry.fromCrawl({
      baseDir: corpus.root(),
      include: ['**/*.md'],
    });

    expect(registryVerdicts(registry)[DECLARED]).toBe('parsed');
  });
});

describe('every shipped registry-construction site reaches the projection lane verdict', () => {
  it('crawlAndResolveRegistry — `vat audit`, `vat skills build` post-build validation', async () => {
    const registry = await crawlAndResolveRegistry(corpus.root());

    expect(registryVerdicts(registry)).toEqual(EXPECTED);
  });

  it('crawlSkillLinkRegistry — `vat inventory`', async () => {
    const registry = await crawlSkillLinkRegistry(corpus.root());

    expect(registryVerdicts(registry)).toEqual(EXPECTED);
  });

  it('buildSkillsValidateRegistry — the builder `vat skills validate` shares', async () => {
    const registry = await buildSkillsValidateRegistry(corpus.root(), { config: CONFIG });

    expect(registryVerdicts(registry)).toEqual(EXPECTED);
  });

  it('the shared context `vat skills validate` really builds, config and all', async () => {
    // The arm above proves the BUILDER honours a config it is handed; this one
    // proves the command HANDS it one. They are different failures with the same
    // symptom, and only this one fails when the call site drops the argument.
    //
    // `SKILL.md` need not exist: the context only reads the path to derive a
    // project root, which the fixture's config file already anchors.
    const skill = {
      name: 'fixture',
      sourcePath: safePath.join(corpus.root(), 'SKILL.md'),
      packagingConfig: {},
    };

    const context = await buildSharedValidationContext([skill], [], CONFIG, createLogger());

    if (context.registry === undefined) {
      throw new Error('the command built no shared registry — this arm is measuring nothing');
    }
    expect(registryVerdicts(context.registry)).toEqual(EXPECTED);
  });

  it('the `skills-validate` pipeline oracle, which restates that command', async () => {
    // The oracle exists to describe what the command really does. A lane that
    // routes differently from its own subject reports on a lane nobody runs.
    const registry = await laneById('skills-validate').build(corpus.root());

    expect(registryVerdicts(registry)).toEqual(EXPECTED);
  });
});
