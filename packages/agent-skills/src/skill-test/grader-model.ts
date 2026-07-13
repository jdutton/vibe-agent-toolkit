/** vat-owned, pinned grader/judge model. Bumped on vat releases. Pinned under
 * subscription AND api-key auth (spec §2.3). */
export const DEFAULT_GRADER_MODEL = 'claude-sonnet-5';

/** Default bounded-parallel executor→grader pipeline width. */
export const DEFAULT_CONCURRENCY = 4;
