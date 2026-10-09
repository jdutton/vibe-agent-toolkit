/**
 * What a listing does with a directory it was refused — the vocabulary shared
 * by the filesystem walk (`file-crawler.ts`) and the git listings
 * (`git-utils.ts`), so a caller decides ONCE for both routes.
 *
 * 🚨 A refused listing is a gap in the POPULATION: every file beneath that
 * directory the listing would have found was never seen and is absent from
 * every count downstream. There are exactly two honest answers — stop, with a
 * sentence the adopter can act on, or keep going and REPORT the gap — and
 * which one is right is the caller's knowledge, not the crawler's. So the
 * policy is {@link UnreadablePolicy}, it is REQUIRED wherever a listing is
 * asked for, and it has no default.
 *
 * 🪤 It used to be `onUnreadable?`, an optional callback. Every caller that
 * ignored it compiled; the two routes then defaulted differently (the walk
 * threw a programmer-facing sentence, the git route dropped the refusal off
 * its stderr without a word); and the miss surfaced one review round later as
 * a HIGH. A required field is what makes `tsc` enumerate the callers.
 */

import { fsFaultOf } from './errors/errno-table.js';
import { FS_FAULT_CODE, FsFaultError, type FsSide } from './errors/fs-fault.js';
import { VatError } from './errors/vat-error.js';
import { type DirectoryRefusal, transientRefusalClause } from './fs-utils.js';
import { canonicalPath } from './path-containment.js';
import { relativeEscapesRoot } from './path-core.js';
import { safePath, toForwardSlash } from './path-utils.js';

/**
 * What a caller that STOPS on a refusal tells the person reading the error.
 *
 * A caller that has decided to stop — a build that must not ship an incomplete
 * bundle, a discovery that must not silently find fewer skills — owes the
 * adopter the directory against the root they know, and the knob THEY have.
 */
export interface RefuseListingContext {
  /**
   * The root the refused directory is expressed against. An absolute path in
   * an error is the developer's `$HOME` in every CI log.
   */
  root: string;
  /**
   * What the adopter can do about it — naming this lane's deliberate-drop
   * mechanism (`resources.exclude`, a plugin `exclude:`, `--exclude`), which
   * differs per caller and is why the crawler cannot supply it.
   */
  remedy: string;
  /**
   * Which side of the calling verb the listed directories are on — an input it reads
   * (`source`), an output it wrote (`destination`), or VAT's own scratch (`environment`).
   * Required: the refusal table decides the refusal by it, and only the caller knows which
   * tree it is listing. In a CRAWL, a directory that is (or lies in, or holds) one of the
   * crawl's declared `outputs` is the destination's whatever this says: the crawl's
   * `outputs` are the one declaration of what the verb writes ({@link settleCrawlRefusal}).
   */
  side: FsSide;
}

/**
 * The caller's decision about a directory the listing cannot open.
 *
 * - `{ refuse }` — STOP: the listing throws {@link DirectoryListingRefusedError}
 *   with the adopter-facing sentence built from the context. Right for every
 *   lane whose output is acted on as a complete population (a build, a
 *   discovery, a fingerprint, a copy).
 * - `{ degrade }` — KEEP GOING and hand the refusal over. The caller is
 *   promising to REPORT the gap — as its own finding, with the directory and
 *   errno the refusal carries — not to drop it. Right for a backstop appended
 *   to a larger report, where one unlistable directory must not destroy every
 *   finding beside it.
 *
 * A directory that VANISHED between being enumerated and being listed
 * (`ENOENT` / `ENOTDIR`) is not a refusal under either arm: it is no longer in
 * the population and is skipped without a call.
 */
export type UnreadablePolicy =
  | { readonly refuse: RefuseListingContext }
  | { readonly degrade: (refusal: DirectoryRefusal) => void };

/**
 * Thrown by a listing under `{ refuse }` when a directory refused to be
 * listed. The message is the adopter's sentence — see {@link refusedListingMessage}.
 *
 * Coded `FS_FAULT` and carrying the classified fault as its `cause` (side from
 * the caller's context, class from the errno), so the refusal is the schema
 * table's for that side and class — never a code of its own. An errno outside
 * the classifier's table carries no cause: it is not known to be the
 * filesystem's, so it stays a defect report.
 */
export class DirectoryListingRefusedError extends VatError {
  readonly refusal: DirectoryRefusal;

  constructor(refusal: DirectoryRefusal, context: RefuseListingContext) {
    super(FS_FAULT_CODE, refusedListingMessage(refusal, context), { cause: classifiedListingFault(refusal, context.side) });
    this.refusal = refusal;
  }
}

/** The classified fault a refused listing stands for, or `undefined` for an errno outside the table. */
function classifiedListingFault(refusal: DirectoryRefusal, side: FsSide): FsFaultError | undefined {
  const facts = fsFaultOf({ code: refusal.code });
  if (facts === undefined) return undefined;
  return new FsFaultError({
    side,
    faultClass: facts.faultClass,
    errno: facts.errno,
    path: refusal.directory,
    origin: 'content',
    action: 'list a directory',
    cause: undefined,
  });
}

/**
 * What a refused listing costs, said so it is true on BOTH routes.
 *
 * 🪤 It used to read "so nothing beneath it was enumerated: every file there
 * is in the declared scan". Both halves were the readdir walk's truth and the
 * git route's lie: `git ls-files --others` reports the refusal while the index
 * has already named every TRACKED file beneath the directory — the same run
 * that printed the sentence had scanned one of them — and the projection's
 * population is the whole non-ignored tree, which no `include`/`exclude`
 * "declared". What holds on every route is the hazard itself: whatever the
 * listing would have found and nothing else named is missing, and the shorter
 * result is indistinguishable from a complete one.
 */
const REFUSAL_GAP_CLAUSE =
  'any file beneath it that no other listing named is absent from every count, ' +
  'and the result cannot be told from a complete one';

/**
 * The adopter-facing sentence: root-relative directory, errno, the gap, and
 * the caller's remedy — **the one owner of that sentence.**
 *
 * Exported so every lane that refuses says the same thing. Three lanes used to
 * compose this by hand and had drifted by a clause each ("enumerated" /
 * "scanned" / "the population could not be enumerated"); the transient clause
 * in particular was written once in `fs-utils.ts` precisely so nobody would.
 * See {@link REFUSAL_GAP_CLAUSE} for why it asserts nothing about what WAS
 * enumerated beneath the directory.
 *
 * @param refusal - What was refused
 * @param context - The root to express it against, and what the adopter can do
 * @returns One sentence, root-relative, never containing the absolute path
 */
export function refusedListingMessage(refusal: DirectoryRefusal, context: RefuseListingContext): string {
  const relative = toForwardSlash(safePath.relative(context.root, refusal.directory));
  const where = relative === '' ? 'the scan root itself' : `the directory '${relative}'`;
  const remedy = refusal.transient
    ? `${transientRefusalClause(refusal.code)}, so nothing is wrong with the tree — re-run before investigating anything.`
    : context.remedy;
  return `Listing ${where} was refused (${refusal.code}): ${REFUSAL_GAP_CLAUSE}. ${remedy}`;
}

/**
 * Apply the caller's policy to one refusal: throw under `{ refuse }`, hand it
 * over under `{ degrade }`. The single place either route settles a refusal,
 * so the two cannot drift.
 *
 * @param policy - The caller's decision
 * @param refusal - The directory that could not be listed
 */
export function settleRefusal(policy: UnreadablePolicy, refusal: DirectoryRefusal): void {
  if ('refuse' in policy) throw new DirectoryListingRefusedError(refusal, policy.refuse);
  policy.degrade(refusal);
}

/**
 * Whether `path` is on what a crawl's verb WRITES: one of its `outputs`, inside one, or holding
 * one (the crawl base of a project a build writes into holds its output). THE one place a
 * crawl derives a side from its `outputs` — the base `stat`, a refused listing at the base or
 * beneath it, on every route. Paths are compared canonically (`canonicalPath`: real path, one
 * spelling), so a directory git reports under its real path (`/private/var` for `/var`) or
 * another drive-letter case is still the output.
 *
 * @param path - A directory the crawl met
 * @param outputs - The trees the calling verb writes, `[]` for a verb that only reads
 */
export function onCrawlOutput(path: string, outputs: readonly string[]): boolean {
  if (outputs.length === 0) return false;
  const at = canonicalOrSpelled(path);
  return outputs.some((output) => {
    const out = canonicalOrSpelled(output);
    return !relativeEscapesRoot(safePath.relative(out, at)) || !relativeEscapesRoot(safePath.relative(at, out));
  });
}

/**
 * The side of a path a crawl met: the destination's when it is on the verb's `outputs`
 * ({@link onCrawlOutput}), else the side of the tree the verb reads — the policy's own
 * (`source` when the policy degrades).
 */
export function crawlSideOf(path: string, outputs: readonly string[], policy: UnreadablePolicy): FsSide {
  if (onCrawlOutput(path, outputs)) return 'destination';
  return 'refuse' in policy ? policy.refuse.side : 'source';
}

/**
 * Settle one refusal a CRAWL met: a refused directory that is on the crawl's `outputs`
 * ({@link onCrawlOutput}) is the destination's; any other keeps the policy's own side.
 *
 * @param policy - The caller's decision
 * @param refusal - The directory that could not be listed
 * @param outputs - The trees the calling verb writes (the crawl's one declaration of them)
 */
export function settleCrawlRefusal(policy: UnreadablePolicy, refusal: DirectoryRefusal, outputs: readonly string[]): void {
  const onOutput = 'refuse' in policy && onCrawlOutput(refusal.directory, outputs);
  settleRefusal(onOutput ? { refuse: { ...policy.refuse, side: 'destination' } } : policy, refusal);
}

function canonicalOrSpelled(path: string): string {
  try {
    return toForwardSlash(canonicalPath(path));
  } catch (error) {
    // A directory that refused its listing may refuse resolution too: its spelling is all there is.
    if (fsFaultOf(error) === undefined) throw error;
    return toForwardSlash(safePath.resolve(path));
  }
}

/**
 * Refuse an omitted policy up front, by name, before any directory is listed.
 *
 * The type already makes `unreadable` required, and that is what enumerates
 * the TypeScript callers. This is the runtime half, for the callers the type
 * cannot reach — test files are not typechecked by the build, and a JavaScript
 * adopter has no compiler at all. Without it an omitted policy would surface
 * only on the first refusal, as a `TypeError` from the `in` operator, and a
 * tree with nothing unreadable would keep returning complete lists — the
 * optional seam back again, one layer down.
 *
 * @param policy - What the caller passed as `unreadable`
 * @param api - The entry point, for the sentence
 */
export function requireUnreadablePolicy(policy: UnreadablePolicy | undefined, api: string): asserts policy is UnreadablePolicy {
  if (policy === undefined) {
    throw new TypeError(
      `${api}: \`unreadable\` is required — pass { refuse: { root, remedy, side } } to stop on a directory the listing cannot open, ` +
        'or { degrade: (refusal) => … } to keep going and report the gap yourself.',
    );
  }
}
