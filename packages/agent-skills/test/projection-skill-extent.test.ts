/**
 * The skill extent's TRANSLATION — `skillExtentDeclaration` and the contributor's
 * identity — as pure functions of config, with no filesystem.
 *
 * The experiment that holds the translation to account (set equality against
 * `walkLinkGraph` over a cloned corpus on disk) is integration-shaped work and
 * lives in `integration/projection-skill-extent.integration.test.ts`.
 */


import { ContributorRegistry } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { LINK_GRAPH_MEMBER_GLOBS } from '../src/link-graph-members.js';
import {
  SKILL_EXTENT_KIND,
  SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
  SKILL_REFUSED_DIRECTORY_TARGET,
  SKILL_REFUSED_NAVIGATION_FILE,
  SKILL_REFUSED_PATTERN_MATCHED,
  SKILL_REFUSED_SKILL_DEFINITION,
  SkillExtentContributor,
  skillExtentContributorId,
  skillExtentDeclaration,
} from '../src/projection/skill-extent.js';
import { AGENT_INSTRUCTION_FILE_PATTERNS, NAVIGATION_FILE_PATTERNS } from '../src/validators/validation-rules.js';

import { CLAUDE_REL, DECLARED_CLAUDE_SOURCE, DEFAULT_CONFIG, DEFAULT_DEPTH, README_REL, SKILL_NAME, SKILL_REL } from './projection-skill-extent-fixture.js';

// ============================================================================
// The translation
// ============================================================================

describe('skillExtentDeclaration', () => {
  it('translates a config-less skill into the packager\'s own default depth', () => {
    const declaration = skillExtentDeclaration(DEFAULT_CONFIG, SKILL_REL, false);
    expect(declaration).toEqual({
      kind: SKILL_EXTENT_KIND,
      closureFrom: SKILL_REL,
      maxDepth: DEFAULT_DEPTH,
      // The packager's door rule: the walker traverses REGISTRY members, and the
      // registry is this glob. Not derived from config: the packager applies it
      // to every skill regardless of what the skill declares.
      traverseGlobs: [...LINK_GRAPH_MEMBER_GLOBS],
      follow: ['markdown-link', 'markdown-link-reference', 'markdown-definition'],
      // The schema default, materialized by `parse`. A skill bundle's links are
      // markdown hrefs and are read under RFC 3986; Claude Code's `@`-import
      // dialect is declared only where an `@` token really is an import, and
      // picking it up here would change what a skill BUNDLES.
      referenceDialect: 'href',
      // In `classifyExclusion`'s own branch order — see the next test for why
      // that order is now behaviour rather than presentation.
      // A config-less skill declares no exclude rules, so the cascade's last
      // branch contributes NO rule — one rule per declared rule, and there are
      // none. It used to emit one empty rule that could never match.
      refusals: [
        // `classifyPathKind` refuses a directory unconditionally — no knob gates it.
        {
          label: SKILL_REFUSED_DIRECTORY_TARGET,
          patterns: [], basenames: [], kinds: ['directory'], flags: {}, payload: null,
        },
        // `skill-packager.ts:582` defaults `excludeNavigationFiles` to true, so a
        // config-less skill refuses this list too.
        {
          label: SKILL_REFUSED_NAVIGATION_FILE,
          patterns: [], basenames: [...NAVIGATION_FILE_PATTERNS], kinds: [], flags: {}, payload: null,
        },
        {
          label: SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
          patterns: [], basenames: [...AGENT_INSTRUCTION_FILE_PATTERNS], kinds: [], flags: {}, payload: null,
        },
        // A SIBLING skill's definition. An ordinary basename rule, sitting after
        // agent-instruction and before the globs because that is where
        // `classifyExclusion` checks it. ⚠️ This rule covers only the cross-skill
        // half of the walker's `skill-definition` branch — a SELF-link is not a
        // refusal on either arm and is handled in the primitive, which skips a
        // reference resolving to `closureFrom` because the root is a member by
        // declaration. Encoding the self case as a rule here would refuse the
        // extent's own root.
        {
          label: SKILL_REFUSED_SKILL_DEFINITION,
          patterns: [], basenames: ['SKILL.md'], kinds: [], flags: {}, payload: null,
        },
      ],
      admitPaths: [],
    });
  });

  it('orders the cascade exactly as classifyExclusion does — the order IS the label', () => {
    // The primitive is first-match-wins and each rule carries a distinct label,
    // so this sequence is what decides that a directory ALSO matching an exclude
    // pattern reports `directory-target` rather than `pattern-matched` — which is
    // `classifyExclusion`'s documented behaviour (`walk-link-graph.ts`: "the
    // order IS the behaviour"). Asserted as a LIST rather than as membership: a
    // set-shaped assertion would pass against any permutation, which is exactly
    // the property under test.
    //
    // Driven from a config that DECLARES an exclude rule, not from the empty
    // one: the pattern branch now contributes a rule only when the config does,
    // so a config-less declaration could not show that the pattern rules sit
    // LAST — the position this test exists to pin.
    const config: SkillPackagingConfig = {
      excludeReferencesFromBundle: { rules: [{ patterns: ['docs/**'] }] },
    };
    expect(skillExtentDeclaration(config, SKILL_REL, false).refusals.map((rule) => rule.label))
      .toEqual([
        SKILL_REFUSED_DIRECTORY_TARGET,
        SKILL_REFUSED_NAVIGATION_FILE,
        SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
        SKILL_REFUSED_SKILL_DEFINITION,
        SKILL_REFUSED_PATTERN_MATCHED,
      ]);
  });

  it('keeps the agent-instruction rule when excludeNavigationFiles is false, and drops only navigation', () => {
    // The walker's agent-instruction branch is deliberately NOT gated on this
    // knob (`refusesAgentInstructionFile`): the knob is about content
    // granularity, "this file is not distributable" is a different question. A
    // translation that gated both would ship every repo's CLAUDE.md the moment
    // an author asked for their READMEs back.
    const declaration = skillExtentDeclaration({ excludeNavigationFiles: false }, SKILL_REL, false);
    // The navigation rule is OMITTED, not emptied: the declaration says the
    // branch does not run, rather than that it runs and catches nothing.
    expect(declaration.refusals.map((rule) => rule.label)).toEqual([
      SKILL_REFUSED_DIRECTORY_TARGET,
      SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
      SKILL_REFUSED_SKILL_DEFINITION,
    ]);
    const agentInstruction = declaration.refusals
      .find((rule) => rule.label === SKILL_REFUSED_AGENT_INSTRUCTION_FILE);
    expect(agentInstruction?.basenames).toEqual([...AGENT_INSTRUCTION_FILE_PATTERNS]);
    expect(declaration.refusals.flatMap((rule) => rule.basenames)).not.toContain('README.md');
  });

  it('carries linkFollowDepth "full" through unchanged', () => {
    expect(skillExtentDeclaration({ linkFollowDepth: 'full' }, SKILL_REL, false).maxDepth).toBe('full');
  });

  it('expands each ordered rule into its OWN refusal rule, same label, declared order', () => {
    // One rule apiece, NOT one flattened rule. Both encodings select the same
    // files and report the same reason — the walker says `pattern-matched` for
    // all of them, so the LABEL is deliberately shared and the condition code is
    // unchanged. What one rule per rule buys is the thing the flat encoding threw
    // away: WHICH declared rule caught the file, which is `matchedRule` on the
    // walker's row and `matchedPattern` + `matchedPayload` on the closure's.
    //
    // The primitive is first-match-wins over this array, which is exactly
    // `excludeMatchers.find(...)` over `options.excludeRules` — same order, same
    // winner — so the expansion is a re-encoding, not a behaviour change.
    const config: SkillPackagingConfig = {
      excludeReferencesFromBundle: {
        rules: [
          { patterns: ['**/*.mjs'], template: 'https://example.test/{{path}}' },
          { patterns: ['docs/**', '**/*.json'] },
        ],
      },
    };
    const refusals = skillExtentDeclaration(config, SKILL_REL, false).refusals;
    const patternRules = refusals.filter((rule) => rule.label === SKILL_REFUSED_PATTERN_MATCHED);
    expect(patternRules).toHaveLength(2);
    // A LIST, not a set: the declared order is the first-match-wins order.
    expect(patternRules.map((rule) => rule.patterns))
      .toEqual([['**/*.mjs'], ['docs/**', '**/*.json']]);
    // The payload is the channel for what the primitive has no column for: the
    // rule's identity when two rules share a first pattern, and its `template`,
    // which the flat encoding lost outright. `template: null` rather than an
    // absent key — a consumer must not have to tell "no template" from "no key".
    expect(patternRules.map((rule) => rule.payload)).toEqual([
      { ruleIndex: 0, template: 'https://example.test/{{path}}' },
      { ruleIndex: 1, template: null },
    ]);
    // …and they sit AFTER the basename rules. The expansion widens one cascade
    // step into two; it must not move the step.
    expect(refusals.map((rule) => rule.label)).toEqual([
      SKILL_REFUSED_DIRECTORY_TARGET,
      SKILL_REFUSED_NAVIGATION_FILE,
      SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
      SKILL_REFUSED_SKILL_DEFINITION,
      SKILL_REFUSED_PATTERN_MATCHED,
      SKILL_REFUSED_PATTERN_MATCHED,
    ]);
  });

  it('admits an EXPLICIT files:-declared agent-instruction source, and nothing else', () => {
    // The walker's escape hatch, mirrored. Three entries, one of which earns it:
    //   notes/CLAUDE.md   — explicit + agent-instruction  → admitted
    //   docs/README.md    — explicit, but the `navigation-file` branch sits
    //                       EARLIER in the cascade and carries NO hatch, so the
    //                       walker still refuses it and so must the closure
    //   vendor/**\/AGENTS.md — a GLOB: `DeferredArtifacts.from` registers it by
    //                       its static base, so `sourcePaths` never contains the
    //                       matched file and exact membership refuses it
    const config: SkillPackagingConfig = {
      files: [
        { source: DECLARED_CLAUDE_SOURCE, dest: DECLARED_CLAUDE_SOURCE },
        { source: README_REL, dest: README_REL },
        { source: 'vendor/**/AGENTS.md', dest: 'vendor/AGENTS.md' },
      ],
    };
    expect(skillExtentDeclaration(config, SKILL_REL, false).admitPaths).toEqual([DECLARED_CLAUDE_SOURCE]);
  });

  it('normalizes a files: source into projection coordinates', () => {
    // `DeferredArtifacts.from` resolves a source through
    // `relative(projectRoot, resolve(join(projectRoot, source)))`, which strips a
    // leading `./`. `admitPaths` is compared by EXACT equality against
    // `resource_realizations.path`, so an unnormalized `./notes/CLAUDE.md` would
    // match nothing at all — a silently dead escape hatch.
    const config: SkillPackagingConfig = {
      files: [{ source: `./${DECLARED_CLAUDE_SOURCE}`, dest: CLAUDE_REL }],
    };
    expect(skillExtentDeclaration(config, SKILL_REL, false).admitPaths).toEqual([DECLARED_CLAUDE_SOURCE]);
  });
});

describe('SkillExtentContributor', () => {
  it('is a closure-stratum contributor under the ids zone_provenance keys on', () => {
    const contributor = new SkillExtentContributor(SKILL_NAME);
    expect(contributor.id).toBe(skillExtentContributorId(SKILL_NAME));
    expect(contributor.kind).toBe(SKILL_EXTENT_KIND);
    expect(contributor.stratum).toBe('closure');
  });

  it('gives two skills two contributor ids, so both can register', () => {
    // A fixed id capped a population at ONE skill extent: the registry refuses
    // a duplicate, and this repo alone ships thirteen skills.
    const registry = new ContributorRegistry();

    expect(() => {
      registry.register(new SkillExtentContributor(SKILL_NAME));
      registry.register(new SkillExtentContributor('another-skill'));
    }).not.toThrow();
    expect(registry.forKind(SKILL_EXTENT_KIND)).toHaveLength(2);
  });
});
