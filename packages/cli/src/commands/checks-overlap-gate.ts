/**
 * The checks overlap gate: once per `vat validate` run, whether the supervised checks child starts
 * during the resources phase (overlapped) or at its turn (sequential), and the ONE decision promise
 * the checks turn awaits.
 *
 * ## The conditions, in order, all required
 *
 * - (a) `--debug` is off: the child's first `--debug` line describes its stderr stream, which an
 *   overlapped child holds as a file;
 * - (b) at least two cores (`os.availableParallelism()`);
 * - (c) the home population for the child's outputs (`childHomeKey`) settled as a store hit. A
 *   derived home carries content too (its own projection's blob rows, which admission after a miss
 *   reads), but a child spawned beside a miss would read a store the parent has only just written,
 *   with no handoff of the tree it was written under, so a miss stays sequential;
 * - (d) the run parses under the limits the store's facts were filed under: decided once per run,
 *   where the run's store is resolved (`hydratesUnder`), so a run under other limits has no store,
 *   settles not-hit and declines at (c);
 * - (e) every stored member is admitted from the store by admission's OWN predicates
 *   (`storedComputeBy`: `storedRoute`, then the kind the one fact reader would return for the
 *   key, over whichever rows the population carried: `StoredContent.facts` is the one reader
 *   whatever its row source), under the parser the run's one routing sends it to
 *   (`parserKindForResolvedPath`). The
 *   check is route-only: it builds no member's facts and keeps nothing it read, so the parent's
 *   memory is admission's alone. The rows its predicates check are counted
 *   `checks.gate.rows.read`, summed per member, and no other counter. The tier read itself is the population's shared
 *   one, which admission reads too, except that the gate asks every home member and admission only
 *   the crawled ones: when no crawled member reads the tier, an overlapped run counts the one
 *   `store.reads.blob` (and its decoded rows) a sequential run skips
 *   (resource-scanning-and-caching.md 3.7b). Any member admission would compute means the parent could write the store
 *   or the parse cache after the spawn, so the run stays sequential.
 *
 * (a) and (b) are decided when the gate is created. (c) to (e) are judged when the home settles,
 * on a side branch of the population memo: {@link ChecksOverlapGate.onHomeSettled} never throws.
 * Every failure of its judgment (a rejected settlement, a rejected tier read, a spawn that
 * rejected) is the decline `rejected`, carrying the failure's message, so the debug-facts dump and
 * the lab show it. Each rejection also stays where the run meets it: the tier read is memoized, and
 * a sequential turn spawns as it always did.
 *
 * ## One decision, one spawn
 *
 * The checks turn calls {@link ChecksOverlapGate.disarm} and then awaits the decision. Disarming
 * resolves it `sequential` unless something already did, and from then on the gate reads
 * no further row and spawns nothing. A disarm that lands while a spawn is minting its
 * scope resolves the decision only once that spawn has torn its scope down, so whoever awaits the
 * decision (the checks turn, or {@link abandoningUnread}) never runs beside a closing scope: no
 * leftover line in the middle of the sequential checks phase, no minted directory after a refusal.
 * The spawn checks `isArmed` after the progress directory is minted and immediately before its
 * synchronous spawn; a `true` answer COMMITS the
 * gate, so a disarm that lands between the child's start and its handle reaching the gate waits for
 * that handle instead of deciding `sequential` beside a running child.
 *
 * The spawn's contract (`startOverlappedSupervision`): once `isArmed` answered true it rejects only
 * before the synchronous spawn (the stderr sink would not open), with its scope already closed; a
 * spawn that fails at the OS is a recorded ending of the run it returns, never a rejection. So a
 * rejected spawn leaves no child, and the sequential turn it falls back to is the only spawn.
 */

import {
  parserKindForResolvedPath,
  storedComputeBy,
  type BlobFactsReader,
  type HomeSettlement,
  type ParseRouting,
  type StoredComputeBy,
  type StoredContent,
} from '@vibe-agent-toolkit/resources';
import { countWork, safePath } from '@vibe-agent-toolkit/utils';

import type { OverlappedRun } from './resources/overlapped-supervision.js';

/** Why the gate left the checks child to its turn: the first condition that failed. */
export type GateDecline =
  /**
   * `disarmed`: the turn came while the gate was still judging the settlement it saw.
   * `not-settled`: the turn came before any settlement for the child's key (a run with no store
   * never sends one).
   */
  | { readonly condition: 'debug' | 'cores' | 'not-hit' | 'disarmed' | 'not-settled' }
  /**
   * The judgment failed: the failure's message (or its string), for the dump to show. Copied as it
   * is, unlike `member`'s path: a message that names an absolute path carries it into the dump.
   */
  | { readonly condition: 'rejected'; readonly error: string }
  /**
   * A member admission would compute: its path relative to the routing's base directory (never
   * absolute, so a dump does not carry the machine's home directory), and the predicate that said so.
   */
  | { readonly condition: 'member'; readonly member: string; readonly route: StoredComputeBy };

/**
 * Every condition a {@link GateDecline} names, at runtime: the lab's debug-facts contract test
 * writes one decline per entry. `satisfies` on the record makes a condition added to (or dropped
 * from) the union fail typecheck here until the list matches it.
 */
export const GATE_DECLINE_CONDITIONS: ReadonlyArray<GateDecline['condition']> = Object.keys({
  debug: true,
  cores: true,
  'not-hit': true,
  disarmed: true,
  'not-settled': true,
  rejected: true,
  member: true,
} satisfies Record<GateDecline['condition'], true>) as Array<GateDecline['condition']>;

/** Every route a `member` decline can carry, at runtime, held to {@link StoredComputeBy} as above. */
export const GATE_MEMBER_ROUTES: readonly StoredComputeBy[] = Object.keys({
  storedRoute: true,
  readRoute: true,
} satisfies Record<StoredComputeBy, true>) as StoredComputeBy[];

/** The one decision the checks turn acts on. */
export type GateDecision =
  | { readonly mode: 'overlapped'; readonly run: OverlappedRun }
  | { readonly mode: 'sequential'; readonly declinedBy: GateDecline };

/** What the gate is built over. */
export interface ChecksOverlapGateOptions {
  /** Whether the run is under `--debug`: condition (a). */
  readonly debug: boolean;
  /** The cores the run may use (`os.availableParallelism`), asked once at creation: condition (b). */
  readonly cores: () => number;
  /** The home population's memo key for the child's outputs (`RunPopulation.homeKey`). */
  readonly childHomeKey: string;
  /** The resources phase's parse routing, which admission routes each member by: condition (e). */
  readonly routing: ParseRouting<string>;
  /**
   * Open the overlapped scope and spawn the child, asking `isArmed` after the mint and immediately
   * before the synchronous spawn; `'disarmed'` when it answered false and the scope was torn down.
   */
  readonly spawn: (isArmed: () => boolean) => Promise<OverlappedRun | 'disarmed'>;
}

/** The gate: the population's settlement listener, the turn's disarm, and the decision. */
export interface ChecksOverlapGate {
  /** The run population's `onHomeSettled`. Never throws. */
  readonly onHomeSettled: (key: string, settlement: HomeSettlement) => void;
  /** The checks turn's first act: synchronous, and final unless a spawn already committed. */
  readonly disarm: () => void;
  /** Resolves exactly once. */
  readonly decision: Promise<GateDecision>;
}

/** The reader the gate asks once it has closed: it reads no row, and its answer is never acted on. */
const CLOSED_READER: BlobFactsReader = {
  outcome: () => ({ kind: 'uncovered', reason: 'the overlap gate was disarmed' }),
  answer: () => ({ kind: 'uncovered', rowsRead: 0 }),
};

/**
 * Build the gate for one `vat validate` run.
 *
 * @param options - The run's facts and its spawn
 * @returns The gate
 */
export function createChecksOverlapGate(options: ChecksOverlapGateOptions): ChecksOverlapGate {
  const settled = Promise.withResolvers<GateDecision>();
  // open: judging, or waiting for the home; committed: a spawn answered armed; closing: disarmed
  // while a spawn mints, waiting for its teardown to decide; decided: resolved.
  let state: 'open' | 'committed' | 'closing' | 'decided' = 'open';
  let sawHome = false;
  let spawning = false;
  const decide = (decision: GateDecision): void => {
    if (state === 'decided') return;
    state = 'decided';
    settled.resolve(decision);
  };
  const decline = (declinedBy: GateDecline): void => decide({ mode: 'sequential', declinedBy });
  const rejected = (error: unknown): void =>
    decline({ condition: 'rejected', error: error instanceof Error ? error.message : String(error) });
  const open = (): boolean => state === 'open';
  // Idempotent: the first true answer commits, and every later ask while committed is true too.
  const isArmed = (): boolean => {
    if (state === 'committed') return true;
    if (!open()) return false;
    state = 'committed';
    return true;
  };

  if (options.debug) decline({ condition: 'debug' });
  else if (options.cores() < 2) decline({ condition: 'cores' });

  async function judge(settlement: HomeSettlement): Promise<void> {
    if (!settlement.ok) return rejected(settlement.error);
    const { outcome, stored } = settlement.enumeration;
    if (outcome.stored !== 'hit' || stored === null) return decline({ condition: 'not-hit' });
    // (e) ranges over EVERY member of the home population, not only the ones the resources crawl
    // admits: the spec requires every member to route `read`, which makes the parent compute
    // nothing anywhere in the population after the spawn. That is stronger than the post-spawn
    // window needs (the checks turn waits for the child's exit before the skills phase starts).
    // The lab's `gateDeclinedBy` reports when this keeps the gate from firing.
    const computed = await firstComputedMember(stored, options.routing, open);
    if (!open()) return;
    if (computed !== undefined) return decline({ condition: 'member', ...computed });
    spawning = true;
    const run = await options.spawn(isArmed);
    decide(run === 'disarmed' ? { mode: 'sequential', declinedBy: { condition: 'disarmed' } } : { mode: 'overlapped', run });
  }

  return {
    onHomeSettled: (key, settlement) => {
      if (key !== options.childHomeKey || !open()) return;
      sawHome = true;
      judge(settlement).catch(rejected);
    },
    disarm: () => {
      if (!open()) return;
      // The spawn answers `disarmed` (or rejects) once its scope is down, and that decides.
      if (spawning) state = 'closing';
      else decline({ condition: sawHome ? 'disarmed' : 'not-settled' });
    },
    decision: settled.promise,
  };
}

/**
 * Run a validate run's phases, then end the gate however they ended: disarm it, await its one
 * decision, and abandon an overlapped child whose turn never came (its tree killed, its scope
 * closed), before the phases' result or throw goes on to be published, exactly as a sequential run
 * publishes it. No child outlives the run that spawned it.
 *
 * A child whose turn came is the turn's: its abandonment is a no-op (`OverlappedRun.abandon`). A
 * throw that escapes the phases is a run refusal (`isRunRefusal`), since `runPhase` records every
 * other phase throw and the run goes on to the checks turn; anything else that escapes is answered
 * the same way.
 *
 * An abandonment that fails after phases that threw is said on stderr, and the phases' own throw is
 * the one rethrown, so the run's refusal is never replaced by its cleanup's. After phases that
 * finished, it is the run's one failure and is thrown, not said.
 *
 * @param gate - The run's gate
 * @param phases - The run's phases
 * @returns What `phases` returned
 * @throws What `phases` threw, after the child is gone; or, after phases that finished, the
 *   abandonment's failure
 */
export async function abandoningUnread<T>(
  gate: Pick<ChecksOverlapGate, 'disarm' | 'decision'>,
  phases: () => Promise<T>,
): Promise<T> {
  const ended = await phases().then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  gate.disarm();
  const decision = await gate.decision;
  if (decision.mode === 'overlapped') {
    try {
      await decision.run.abandon();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const said = `the checks child could not be abandoned: ${detail}`;
      if (ended.ok) throw new Error(said, { cause: error });
      process.stderr.write(`vat: ${said}\n`);
    }
  }
  if (!ended.ok) throw ended.error;
  return ended.value;
}

/**
 * The first stored member, in the store's order, that admission would compute, by admission's own
 * predicates (`storedComputeBy`); `undefined` when every one is admitted from the store. Route-only:
 * no member's facts are built, and nothing read is kept. The tier is read once, when the first
 * member's route asks, through a reader that reads no row once the gate has closed, so a disarm
 * that lands while the tier is read stops the judgment. The rows read are counted
 * `checks.gate.rows.read`, summed per member: a content key several members share counts once for each.
 *
 * @param stored - The hit's stored content
 * @param routing - The run's parse routing
 * @param open - Whether the gate still judges
 * @returns The member and the predicate that sends it cold
 * @throws What the tier read rejected with
 */
async function firstComputedMember(
  stored: StoredContent,
  routing: ChecksOverlapGateOptions['routing'],
  open: () => boolean,
): Promise<{ member: string; route: StoredComputeBy } | undefined> {
  const facts = async (): Promise<BlobFactsReader> => {
    const reader = await stored.facts();
    return open() ? reader : CLOSED_READER;
  };
  const answers = await Promise.all([...stored.members].map(async ([path, realization]) => ({
    path,
    answer: await storedComputeBy(realization, parserKindForResolvedPath(path, routing.resolver, routing.baseDir), facts),
  })));
  const rowsRead = answers.reduce((total, { answer }) => total + answer.rowsRead, 0);
  if (rowsRead > 0) countWork('checks.gate.rows.read', rowsRead);
  for (const { path, answer } of answers) {
    if (answer.computeBy !== null) return { member: safePath.relative(routing.baseDir, path), route: answer.computeBy };
  }
  return undefined;
}
