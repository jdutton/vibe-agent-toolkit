/**
 * The wire shape of one external-link cache entry — the only thing standing
 * between bytes in a world-readable temp directory and a status code this
 * toolkit will report as fact.
 *
 * ## Why a schema here, and why it has to carry the whole load
 *
 * This tenant is deliberately NOT under the version namespace. External link
 * reachability is a fact about the world, not about this build, so
 * `cache-namespace.ts` files it at the `.vat-cache` root precisely so a VAT
 * upgrade does not re-fetch the internet. That decision has a price, and this
 * file is where it is paid: the parse cache can lean on "the namespace already
 * moved" for anything a validator cannot see, and this cache cannot. Whatever
 * protects a stale or foreign entry on read lives here, or nowhere.
 *
 * What it replaces is a hand-bumped `CACHE_VERSION = 1` stamped into every
 * entry and compared on read. That number never moved off 1, could only ever
 * move by someone remembering to move it, and — because it was checked
 * *instead of* the entry's own fields, never alongside them — it certified a
 * shape it had not looked at. An entry carrying `version: 1` and a
 * `statusCode` of `"404"` was handed back as a hit, and the string then reached
 * `isAliveStatus`, which is a `Set<number>.has`: no string is ever a member, so
 * every such entry reports its link *broken*, at full confidence, from a check
 * that passed. A number that certifies a shape it never inspects is not a
 * check; see the prohibition at the top of the repo's `CLAUDE.md`.
 *
 * ## What this catches, and the one thing it does not
 *
 * | Change to a stored entry | Caught? | How |
 * |---|---|---|
 * | A field's type changes | ✅ | the field's own check fails |
 * | A **required** field is added | ✅ | absent in the old entry ⇒ reject |
 * | A field is removed | ✅ | `.strict()` — an unknown key is a reject |
 * | Truncation / foreign JSON at the entry | ✅ | structural failure anywhere |
 * | An **optional** field is added | ❌ | absent is indistinguishable from |
 * | | | legitimately-absent |
 *
 * That last row is the same property of optionality `parse-facts.ts` documents,
 * and the answer there — put the two kinds of entry in different namespaced
 * directories — is exactly the answer unavailable here, by design. What closes
 * it instead is the TTL: every entry self-invalidates within `ttlHours` (24 by
 * default), so an entry written before an optional field existed is gone within
 * a day whether or not anything noticed. That is a weaker guarantee than the
 * parse cache's and it is stated as such — it is bounded-in-time, not
 * immediate. An entry-shape change that must take effect *now* is a `vat cache
 * clear`, not a field added here.
 *
 * ## The envelope is strict; there is nothing nested to be lenient about
 *
 * `.strict()` is the repo's rule for a schema over our own output
 * (`.claude/rules/schema-strictness.md`), and it is load-bearing rather than
 * decorative: an unknown key is the only signal that an entry disagrees with
 * this build about what an entry *contains*, which is the case the deleted
 * constant was pretending to cover. Unlike `ParseFactsSchema` there are no
 * nested object schemas here to hold to a laxer standard — an entry is three
 * scalars, and all three are load-bearing.
 */

import { z } from 'zod';

/**
 * One cached external-link check.
 *
 * `statusCode` admits `0`: the validator emits it for a transport failure with
 * no HTTP response, and `isAliveStatus` treats it as dead. Rejecting it would
 * make every unreachable host a permanent cache miss and re-fetch it every run,
 * which is the opposite of what this cache is for.
 *
 * Notably absent: a `version` field. Nothing read it but the check that is
 * gone, and pre-1.0 this repo does not keep a field alive for a reader that no
 * longer exists — an entry written by the old code path carries `version` as an
 * unknown key and `.strict()` makes it a miss, which is the correct and only
 * needed migration.
 */
export const ExternalLinkCacheEntrySchema = z.object({
  statusCode: z.number().int().nonnegative().describe('HTTP status, or 0 for a transport failure'),
  statusMessage: z.string().describe('HTTP status text, or the transport error'),
  timestamp: z.number().int().nonnegative().describe('Epoch ms the check was performed; the TTL clock'),
}).strict().describe('One cached external-link reachability check');

export type ExternalLinkCacheEntry = z.infer<typeof ExternalLinkCacheEntrySchema>;
