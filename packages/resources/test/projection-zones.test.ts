import { describe, expect, it } from 'vitest';

import {
  LensEntryPointRowSchema,
  ResolutionContextRowSchema,
  ZoneKindSchema,
  ZoneProvenanceRowSchema,
  ZoneSpeciesSchema,
} from '../src/schemas/projection-zones.js';

/** The shared `claude-context` resolution context every entry point below joins to. */
const CLAUDE_CONTEXT_ID = 'claude-context:primary';

describe('ZoneKindSchema', () => {
  it('accepts every kind the model names today', () => {
    const kinds = [
      'filesystem', 'git', 'tree', 'package', 'skill', 'plugin',
      'marketplace', 'install', 'registry', 'collection',
      'claude-context', 'github-render', 'wiki',
    ];
    for (const kind of kinds) {
      expect(ZoneKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it('accepts a kind VAT has never heard of — the vocabulary is open', () => {
    expect(ZoneKindSchema.safeParse('sharepoint-tenant').success).toBe(true);
  });

  it('rejects an empty kind', () => {
    expect(ZoneKindSchema.safeParse('').success).toBe(false);
  });
});

describe('ZoneSpeciesSchema', () => {
  it('accepts the two species', () => {
    expect(ZoneSpeciesSchema.safeParse('extent').success).toBe(true);
    expect(ZoneSpeciesSchema.safeParse('lens').success).toBe(true);
  });

  it('rejects anything else', () => {
    expect(ZoneSpeciesSchema.safeParse('zone').success).toBe(false);
  });
});

describe('ResolutionContextRowSchema', () => {
  const gitExtent = {
    contextId: 'git:primary',
    species: 'extent',
    kind: 'git',
    rootId: 'primary',
    extentContextId: null,
    role: null,
  };

  it('accepts an extent that is its own base', () => {
    expect(ResolutionContextRowSchema.safeParse(gitExtent).success).toBe(true);
  });

  it('accepts a tree extent carrying a role', () => {
    const row = { ...gitExtent, contextId: 'tree:dist', kind: 'tree', role: 'dist' };
    expect(ResolutionContextRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a lens over a named extent', () => {
    const row = {
      contextId: CLAUDE_CONTEXT_ID,
      species: 'lens',
      kind: 'claude-context',
      rootId: 'primary',
      extentContextId: 'filesystem:primary',
      role: null,
    };
    expect(ResolutionContextRowSchema.safeParse(row).success).toBe(true);
  });

  it('rejects an extent that points at a base extent — an extent IS its base', () => {
    const row = { ...gitExtent, extentContextId: 'filesystem:primary' };
    expect(ResolutionContextRowSchema.safeParse(row).success).toBe(false);
  });

  it('rejects a lens with no base extent — a lens is always over an extent', () => {
    const row = {
      contextId: 'wiki:primary',
      species: 'lens',
      kind: 'wiki',
      rootId: 'primary',
      extentContextId: null,
      role: null,
    };
    expect(ResolutionContextRowSchema.safeParse(row).success).toBe(false);
  });

  it('rejects a role on a non-tree kind', () => {
    const row = { ...gitExtent, role: 'source' };
    expect(ResolutionContextRowSchema.safeParse(row).success).toBe(false);
  });
});

describe('LensEntryPointRowSchema', () => {
  it('accepts a directory entry point with an ancestry chain', () => {
    const row = {
      entryPointId: 'claude-context:primary@docs/architecture',
      contextId: CLAUDE_CONTEXT_ID,
      parameter: 'docs/architecture',
      ancestry: ['r-docs-architecture-claude', 'r-docs-claude', 'r-root-claude'],
    };
    expect(LensEntryPointRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts an empty ancestry — a directory with no CLAUDE.md above it', () => {
    const row = {
      entryPointId: 'claude-context:primary@vendor',
      contextId: CLAUDE_CONTEXT_ID,
      parameter: 'vendor',
      ancestry: [],
    };
    expect(LensEntryPointRowSchema.safeParse(row).success).toBe(true);
  });
});

describe('ZoneProvenanceRowSchema', () => {
  it('accepts a contributor record with a digest', () => {
    const row = {
      contextId: 'skill:vat-audit',
      contributorId: 'agent-skills/skill-extent',
      parameterSet: { publish: false, linkFollowDepth: 3 },
      extentDigest: 'sha256:' + 'a'.repeat(64),
    };
    expect(ZoneProvenanceRowSchema.safeParse(row).success).toBe(true);
  });

  it('rejects a row with no extent digest — §7.4 deletes the completeness claim rather than weakening it', () => {
    const row = {
      contextId: 'skill:vat-audit',
      contributorId: 'agent-skills/skill-extent',
      parameterSet: {},
    };
    expect(ZoneProvenanceRowSchema.safeParse(row).success).toBe(false);
  });
});
