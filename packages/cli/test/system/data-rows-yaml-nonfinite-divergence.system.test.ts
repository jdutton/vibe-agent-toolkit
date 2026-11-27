/**
 * A recorded divergence, pinned: the same three YAML lines (`x: .nan`, `y: .inf`, `z: -.inf`) read by the markdown
 * frontmatter lane and by the `data` instance's YAML rows answer differently, and this file holds
 * exactly what each answers today, so a change to either side is seen rather than drifting.
 *
 * - The frontmatter lane parses the YAML and stores the result as JSON text: JSON has no NaN or
 *   Infinity, so all three become JSON `null` in `blobs.frontmatter`, the number gone without a trace.
 * - The data rows keep `type number` and the source `lexeme`, raise `DATA_LOSSY_NUMBER` on each, and
 *   store the double the parser resolved: SQLite holds ±Infinity as REAL (`CAST` reads `Inf` and
 *   `-Inf`) and stores NaN as NULL, so `.nan`'s `value` is SQL NULL (NaN again in a decoded JS row).
 *
 * The register row naming this divergence quotes these values. Read through the built
 * `vat resources query` over a committed corpus on both arms, store off and store on, each cold and
 * then warm (served from the store), and `data__values` answers identically on all four.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { answeredRows, countedQuery, DATA_CONFIG, dataIncludeConfig, freshDataArm } from '../helpers/data-rows.js';
import { commitTestFixture, writeCorpus } from '../test-helpers.js';

import { createSuiteContext } from './test-common.js';

/** The three lines both lanes read. */
const NON_FINITE_YAML = 'x: .nan\ny: .inf\nz: -.inf\n';

const MARKDOWN_PATH = 'divergence.md';
const DATA_PATH = 'yaml/divergence.yaml';

/** The frontmatter as stored, and each key's JSON type. */
const FRONTMATTER_SQL = [
  "SELECT b.frontmatter AS frontmatter, json_type(b.frontmatter, '$.x') AS x, json_type(b.frontmatter, '$.y') AS y, json_type(b.frontmatter, '$.z') AS z",
  'FROM resource_realizations r JOIN blobs b ON b.contentKey = r.contentKey',
  `WHERE r.path = '${MARKDOWN_PATH}'`,
].join(' ');

/** The data rows' scalars: type, lexeme, the stored value's storage class and its text. */
const VALUES_SQL = [
  'SELECT pointer, type, lexeme, typeof(value) AS storage, CAST(value AS TEXT) AS text FROM data__values',
  `WHERE path = '${DATA_PATH}' AND pointer <> '' ORDER BY pointer`,
].join(' ');

/** The data rows' conditions, by line. */
const CONDITIONS_SQL = 'SELECT code, line FROM data__conditions ORDER BY line';

const context = createSuiteContext('vat-data-rows-nonfinite-', import.meta.url);
beforeAll(() => context.setup());
afterAll(() => context.cleanup());

/** What `data__values` answers for the three lines, on every arm. */
const EXPECTED_VALUES = [
  { pointer: '/x', type: 'number', lexeme: '.nan', storage: 'null', text: null },
  { pointer: '/y', type: 'number', lexeme: '.inf', storage: 'real', text: 'Inf' },
  { pointer: '/z', type: 'number', lexeme: '-.inf', storage: 'real', text: '-Inf' },
];

describe('recorded divergence: YAML .nan and .inf in markdown frontmatter versus the data rows', () => {
  // Reds, each seeded once and reverted:
  // - the expected frontmatter `x` as `real` (what the data rows' `.inf` holds) in place of `null`:
  //   the frontmatter assertion failed, 1 failure;
  // - before `decodeScalar` read a stored NULL of type number as NaN, the store-on cold run refused
  //   with INTERNAL_ERROR (Scalar "value" of type number needs a number and its lexeme, got object
  //   and string), 1 failure.
  it('pins what each lane yields for the same three lines today, data rows alike store off and on, cold and warm', async () => {
    const cwd = safePath.join(context.createTempDir(), 'corpus');
    writeCorpus(cwd, {
      'vibe-agent-toolkit.config.yaml': DATA_CONFIG + dataIncludeConfig([DATA_PATH]),
      [MARKDOWN_PATH]: `---\n${NON_FINITE_YAML}---\n# Non-finite frontmatter\n`,
      [DATA_PATH]: NON_FINITE_YAML,
    });
    commitTestFixture(cwd);
    const query = async (arm: ReturnType<typeof freshDataArm>, sql: string): Promise<readonly Record<string, unknown>[]> => answeredRows(await countedQuery(context, cwd, arm, sql));

    // The frontmatter lane: all three numbers stored as JSON null.
    expect(await query(freshDataArm(context, true), FRONTMATTER_SQL), 'blobs.frontmatter').toEqual([
      { frontmatter: '{"x":null,"y":null,"z":null}', x: 'null', y: 'null', z: 'null' },
    ]);
    // The data rows: the number kept, with its lexeme; ±Infinity stored as REAL, NaN as NULL.
    const answers: Record<string, unknown> = {};
    for (const storeOff of [true, false]) {
      const arm = freshDataArm(context, storeOff);
      for (const pass of ['cold', 'warm']) answers[`${storeOff ? 'storeOff' : 'storeOn'}:${pass}`] = await query(arm, VALUES_SQL);
    }
    expect(answers, 'data__values on every arm').toEqual({
      'storeOff:cold': EXPECTED_VALUES,
      'storeOff:warm': EXPECTED_VALUES,
      'storeOn:cold': EXPECTED_VALUES,
      'storeOn:warm': EXPECTED_VALUES,
    });
    expect(await query(freshDataArm(context, false), CONDITIONS_SQL), 'data__conditions').toEqual([
      { code: 'DATA_LOSSY_NUMBER', line: 1 },
      { code: 'DATA_LOSSY_NUMBER', line: 2 },
      { code: 'DATA_LOSSY_NUMBER', line: 3 },
    ]);
  });
});
