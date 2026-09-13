/**
 * Every committed JSON Schema artifact is in the state its generator produces.
 *
 * Three packages commit `schemas/*.json` rendered from Zod; `build` regenerates
 * them, so a Zod edit that forgets `git add` shipped a stale artifact past every
 * gate. `packages/schema` pins its own eight in `test/emitted-json-schemas.test.ts`
 * (with deeper per-record cases); this suite pins ALL three directories through
 * the shared helper, reading the same target list each generator writes from —
 * so a target added to a generator is under test the moment it exists.
 *
 * The fixture cases prove the helper can see each kind of drift; a helper that
 * returned `[]` for everything would make the real-tree case vacuous.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AGENT_SKILLS_SCHEMA_TARGETS, AGENT_SKILLS_SCHEMAS_DIR } from '../../agent-skills/scripts/generate-json-schemas.js';
import { CLI_SCHEMA_TARGETS, CLI_SCHEMAS_DIR } from '../../cli/scripts/generate-json-schemas.js';
import { JSON_SCHEMA_TARGETS as SCHEMA_PACKAGE_TARGETS } from '../../schema/src/json-schema-targets.js';
import { PROJECT_ROOT } from '../src/common.js';
import { RESOURCES_SCHEMA_TARGETS, RESOURCES_SCHEMAS_DIR } from '../src/generate-resources-json-schemas.js';
import { findEmittedSchemaDrift, renderEmittedSchema, writeEmittedSchemas, type EmittedSchemaTarget } from '../src/pin-emitted-schemas.js';

import { cleanupTestTempDir, createTestTempDir } from './test-helpers.js';

const SCHEMA_PACKAGE_DIR = safePath.join(PROJECT_ROOT, 'packages', 'schema', 'schemas');

describe('findEmittedSchemaDrift', () => {
  let dir: string;
  const targets: EmittedSchemaTarget[] = [
    { name: 'thing', schema: z.object({ id: z.string() }).strict() },
    { name: 'other', schema: z.object({ n: z.number() }).strict(), postProcess: (doc) => { doc['title'] = 'Other'; } },
  ];
  beforeEach(() => {
    dir = createTestTempDir({ prefix: 'emitted-schemas-' });
  });
  afterEach(() => {
    cleanupTestTempDir(dir);
  });

  it('reports nothing when the directory is exactly what the writer produced', () => {
    writeEmittedSchemas(dir, targets);

    expect(findEmittedSchemaDrift(dir, targets)).toEqual([]);
  });

  it('applies postProcess in both the writer and the render it compares against', () => {
    writeEmittedSchemas(dir, targets);

    expect(JSON.parse(readFileSync(safePath.join(dir, 'other.json'), 'utf8'))).toMatchObject({ title: 'Other' });
    expect(renderEmittedSchema(targets[1] as EmittedSchemaTarget)).toContain('"title": "Other"');
  });

  it('sees a missing artifact, a stale one, and one no target produces', () => {
    writeEmittedSchemas(dir, targets);
    // stale: a hand edit that would be rewritten by the next generator run
    writeFileSync(safePath.join(dir, 'thing.json'), `${readFileSync(safePath.join(dir, 'thing.json'), 'utf8')}\n`);
    // unlisted: an artifact whose target was removed
    writeFileSync(safePath.join(dir, 'ghost.json'), '{}\n');
    // missing: a target never generated
    const withExtra = [...targets, { name: 'never-written', schema: z.string() }];

    const drift = findEmittedSchemaDrift(dir, withExtra).sort((a, b) => a.name.localeCompare(b.name));

    expect(drift).toEqual([
      { name: 'ghost', kind: 'unlisted' },
      { name: 'never-written', kind: 'missing' },
      { name: 'thing', kind: 'stale' },
    ]);
  });
});

describe.each([
  ['packages/agent-skills/schemas', AGENT_SKILLS_SCHEMAS_DIR, AGENT_SKILLS_SCHEMA_TARGETS],
  ['packages/cli/schemas', CLI_SCHEMAS_DIR, CLI_SCHEMA_TARGETS],
  ['packages/resources/schemas', RESOURCES_SCHEMAS_DIR, RESOURCES_SCHEMA_TARGETS],
  ['packages/schema/schemas', SCHEMA_PACKAGE_DIR, SCHEMA_PACKAGE_TARGETS],
] as const)('%s', (_label, dir, targets) => {
  it('is committed in the state `generate:schemas` produces — nothing missing, stale, or unlisted', () => {
    expect(findEmittedSchemaDrift(dir, targets)).toEqual([]);
  });

  it('has at least one target, so an emptied list cannot pass by vacancy', () => {
    expect(targets.length).toBeGreaterThan(0);
  });
});
