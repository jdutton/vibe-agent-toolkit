/**
 * What one run hydrates: the projection tables its statements name, with its own rows, and nothing
 * else — and, in a run holding more than one root, not a relation whose rows could not say which
 * root their path is under.
 *
 * In-process over one small projection built once from a temp directory: no store, no spawned `vat`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  allDerivedSpecs,
  buildResourceProjection,
  PROJECTION_STATEMENT_REFUSED_CODE,
  PROJECTION_TABLES,
  type Projection,
} from '@vibe-agent-toolkit/resources';
import { isVatError, safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/utils/logger.js';
import { AUTHORED_LINK_LENS, planHydration } from '../../src/utils/projection-lenses.js';
import { askPopulatedProjection } from '../../src/utils/projection-query.js';
import { hydrateRunDatabase } from '../../src/utils/projection-store.js';

/** Every relation a statement can name. */
const QUERYABLE = [...Object.values(PROJECTION_TABLES), ...allDerivedSpecs()].map((spec) => spec.name);

const ONE_ROOT: readonly unknown[] = [{ id: 'root-1', path: '/a' }];
const TWO_ROOTS: readonly unknown[] = [...ONE_ROOT, { id: 'root-2', path: '/b' }];

const NAMES_BLOBS = 'SELECT COUNT(*) AS n FROM blobs';
const NAMES_REALIZATIONS = 'SELECT path FROM resource_realizations';

let root: string;
let projection: Projection;

beforeAll(async () => {
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-hydration-'));
  mkdirSyncReal(safePath.join(root, 'docs'));
  writeFileSync(safePath.join(root, 'docs', 'a.md'), '# A\n\nSee [b](./b.md).\n');
  writeFileSync(safePath.join(root, 'docs', 'b.md'), '# B\n');
  ({ projection } = await buildResourceProjection({ root }));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** What one call threw, or undefined. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('planHydration: the relations', () => {
  it('plans exactly the projection tables a statement names', () => {
    const plan = planHydration({ statements: [NAMES_BLOBS], roots: ONE_ROOT });
    expect(plan.relations).toStrictEqual(['blobs']);
    expect(plan.lenses).toStrictEqual([]);
    expect([...plan.withheld]).toStrictEqual([]);
  });

  it('adds no table for a lens relation: no lens reads the run database', () => {
    const plan = planHydration({ statements: ['SELECT COUNT(*) FROM edges'], roots: ONE_ROOT });
    expect(plan.relations).toStrictEqual([]);
    expect(plan.lenses).toStrictEqual([AUTHORED_LINK_LENS]);
  });

  it('plans both halves of a statement joining a lens relation to a table', () => {
    const plan = planHydration({
      statements: ['SELECT r.path FROM edges e JOIN resource_realizations r ON r.path = e.src'],
      roots: ONE_ROOT,
    });
    expect(plan.relations).toStrictEqual(['resource_realizations']);
    expect(plan.lenses).toStrictEqual([AUTHORED_LINK_LENS]);
  });

  it('plans nothing for a statement naming no relation', () => {
    expect(planHydration({ statements: ['SELECT 1 AS x'], roots: ONE_ROOT }).relations).toStrictEqual([]);
  });
});

describe('planHydration: a run holding more than one root', () => {
  it('withholds a relation with a root-relative path column and no root column, with why', () => {
    const plan = planHydration({ statements: [NAMES_REALIZATIONS, NAMES_BLOBS], roots: TWO_ROOTS });
    expect(plan.relations).toStrictEqual(['blobs']);
    expect(plan.withheld.get('resource_realizations')).toMatch(/root-relative path column and no `root` column/u);
  });

  it('does not evaluate a lens that owns a withheld relation, and withholds every relation of it named', () => {
    // `edges` has no path column; its lens also produces `edge_resolutions`, whose `dstKey` is one.
    const plan = planHydration({ statements: ['SELECT COUNT(*) FROM edges', 'SELECT chainId FROM claude_context_loads'], roots: TWO_ROOTS });
    expect(plan.lenses).toStrictEqual([]);
    expect(plan.withheld.get('edges')).toMatch(/its lens is not evaluated, because it also produces edge_resolutions/u);
    expect(plan.withheld.get('claude_context_loads')).toMatch(/root-relative path column/u);
  });

  it('withholds nothing in a run holding one root', () => {
    const plan = planHydration({ statements: [NAMES_REALIZATIONS], roots: ONE_ROOT });
    expect(plan.relations).toStrictEqual(['resource_realizations']);
    expect([...plan.withheld]).toStrictEqual([]);
  });
});

describe('hydrateRunDatabase: a statement naming only blobs', () => {
  it('hydrates exactly the run\'s blob rows, and no other relation exists', async () => {
    expect(projection.blobs.length, 'the fixture holds no blob, so the count below is vacuous').toBeGreaterThan(0);
    const database = await hydrateRunDatabase(projection, planHydration({ statements: [NAMES_BLOBS], roots: projection.roots }));
    try {
      expect(database.query(NAMES_BLOBS)[0]?.['n']).toBe(projection.blobs.length);
      for (const name of QUERYABLE.filter((relation) => relation !== 'blobs')) {
        expect(() => database.query(`SELECT 1 FROM "${name}"`), name).toThrow(/no such table/u);
      }
    } finally {
      await database.close();
    }
  });

  it('refuses a projection with no root row, since there is no id to file it under', async () => {
    await expect(hydrateRunDatabase({ ...projection, roots: [] }, { relations: [] })).rejects.toThrow(/no root row/u);
  });
});

describe('a run holding two roots', () => {
  it('refuses a statement over a withheld relation, naming why and listing none of its columns; blobs answers', async () => {
    const [first] = projection.roots;
    if (first === undefined) throw new Error('the fixture projection has no root row');
    const twoRoots: Projection = { ...projection, roots: [...projection.roots, { ...first, id: 'root-2', path: '/b' }] };
    const outcome = await askPopulatedProjection(
      {
        projection: twoRoots,
        outcome: { population: 'derived' },
        root,
        logger: createLogger(),
        statements: [NAMES_REALIZATIONS, NAMES_BLOBS],
        base: undefined,
        cache: undefined,
        populationStart: performance.now(),
      },
      (ask) => ({ blobs: ask(NAMES_BLOBS), refused: thrownBy(() => ask(NAMES_REALIZATIONS)) }),
    );

    expect(outcome.blobs[0]?.['n']).toBe(projection.blobs.length);
    expect(isVatError(outcome.refused, PROJECTION_STATEMENT_REFUSED_CODE), String(outcome.refused)).toBe(true);
    const message = String((outcome.refused as Error).message);
    expect(message).toMatch(/resource_realizations, which this run withheld/u);
    expect(message).toMatch(/more than one root/u);
    expect(message, 'a withheld relation\'s columns were listed').not.toMatch(/pathLower/u);
  });
});
