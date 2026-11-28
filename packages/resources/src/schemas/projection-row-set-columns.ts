/**
 * The columns every row-set instance's schemas share, declared once: the content key, the position
 * convention, counts, and the derived routes relation each instance publishes (`<instance>__routes`).
 *
 * The `data` instance (`projection-data.ts`) and the `ts` instance (`projection-ts.ts`) both build
 * on these, so a position or a route state means one thing in every instance.
 */

import { z } from 'zod';

import { ContentKeySchema } from '../content-key.js';

/** The description of every row-set row's `blob` column. */
export const BLOB_DESC = 'The content key of the bytes these rows describe';

/** The description of a 1-based line: one line index serves every instance. */
export const LINE_DESC = '1-based line, over the decoded text (BOM stripped); CR, LF and CRLF each one break';

/** The description of a 1-based column. */
export const COLUMN_DESC = '1-based column in UTF-16 code units';

/** @returns A count or an ordinal: a non-negative integer */
export const count = (): z.ZodNumber => z.number().int().nonnegative();

/** @returns A 1-based position or depth: a positive integer */
export const position = (): z.ZodNumber => z.number().int().positive();

/**
 * Where a routed pair's facts stand, in every instance's routes relation. The one statement of what
 * each state means: the pair-codes list in `docs/validation-codes.md` is held to it by a unit test,
 * and every other document links there rather than restating it.
 */
const RouteStateSchema = z.enum(['facts', 'defective', 'refused'])
  .describe('`facts`: the pair\'s rows are held; `defective`: the bytes or the file decide it (a parse error or another defect its instance\'s pair codes name, not text, a cap the bytes decide, a read the filesystem refused or failed), so the same file fails the same way every run: fix the file or exclude it in its instance\'s block (resources.extractors.data or resources.extractors.ts); `refused`: this run decided it (a time, heap or stack cap, a worker death, bytes changed or gone under the run, the machine out of descriptors or the path busy), so a rerun may answer, except a pair refused because a store-off run holds as many bytes of rows as it may: a rerun refuses it again, so run with the projection store on, inside a git repository');

/** The `root` and `path` columns that lead every derived per-file relation of an instance. */
export const ROOT_PATH_COLUMNS = {
  root: z.string().describe('The id of the root the path is under'),
  path: z.string().describe('The routed file, relative to its root'),
} as const;

/** The columns of an instance's derived routes relation, its variant schema given. */
type RouteRowShape<Variant extends z.ZodTypeAny> = typeof ROOT_PATH_COLUMNS & {
  blob: z.ZodNullable<typeof ContentKeySchema>;
  variant: Variant;
  state: typeof RouteStateSchema;
  code: z.ZodNullable<z.ZodString>;
};

/**
 * The derived routes relation of one instance: one row per routed path, naming the pair it routed
 * to and how the pair stands.
 *
 * @param variant - The instance's variant schema
 * @param relation - The relation's SQL name, for its description
 * @returns The row schema
 */
export function routeRowSchema<Variant extends z.ZodTypeAny>(variant: Variant, relation: string): z.ZodObject<RouteRowShape<Variant>, 'strict'> {
  return z.object({
    ...ROOT_PATH_COLUMNS,
    blob: ContentKeySchema.nullable().describe('The content key of the bytes, or null when the run holds none'),
    variant,
    state: RouteStateSchema,
    code: z.string().nullable().describe('Why the pair is not `facts`, or null when it is'),
  }).strict().describe(`A row of the derived \`${relation}\` relation`);
}
