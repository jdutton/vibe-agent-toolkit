/**
 * Fakes for the checks overlap gate and `vat validate`'s wiring of it: a stored home population, a
 * blob tier, and an overlapped child run whose exit, turn and abandonment a test drives.
 */

import {
  ParseDispatcher,
  type BlobFactsOutcome,
  type BlobFactsReader,
  type HomeSettlement,
  type ParseCache,
  type ResourceEnumeration,
  type StoredContent,
} from '@vibe-agent-toolkit/resources';

import type { SupervisedRun } from '../../src/commands/resources/check-supervisor.js';
import type { OverlappedRun, OverlappedTurn } from '../../src/commands/resources/overlapped-supervision.js';

export const ROOT = '/repo';
export const HOME_KEY = '[] home';
export const MARKDOWN_KEY = `markdown.${'a'.repeat(64)}`;
/** The run's limits when they are the population's: what a dispatcher with no named limits resolves. */
export const POPULATION_LIMITS = new ParseDispatcher({ enabled: false, stats: { hits: 0, misses: 0 } } as unknown as ParseCache, {}).limits;

type Realization = StoredContent['members'] extends ReadonlyMap<string, infer R> ? R : never;

export const keyed = (contentKey: string): Realization => ({ contentKey, contentState: 'keyed', mime: 'text/markdown' });

/**
 * A reader answering `outcomes` by key, each key one row, counting the keys it answered and the
 * outcomes it built.
 */
export function readerOf(outcomes: Readonly<Record<string, BlobFactsOutcome>>): BlobFactsReader & { answered: number; built: number } {
  const outcomeOf = (key: string): BlobFactsOutcome => outcomes[key] ?? { kind: 'uncovered', reason: 'not in the fake tier' };
  const reader = {
    answered: 0,
    built: 0,
    outcome: (key: string): BlobFactsOutcome => {
      reader.built += 1;
      return outcomeOf(key);
    },
    answer: (key: string) => {
      reader.answered += 1;
      return { kind: outcomeOf(key).kind, rowsRead: 1 };
    },
  };
  return reader;
}

/** A blob tier answering `outcomes` by key, recording each read of it. */
export function tierOf(outcomes: Readonly<Record<string, BlobFactsOutcome>>): {
  reads: number;
  reader: ReturnType<typeof readerOf>;
  facts: StoredContent['facts'];
} {
  const tier = {
    reads: 0,
    reader: readerOf(outcomes),
    facts: () => {
      tier.reads += 1;
      return Promise.resolve<BlobFactsReader>(tier.reader);
    },
  };
  return tier;
}

export const FACTS: BlobFactsOutcome = { kind: 'facts', facts: { links: [], headings: [] } as unknown as Extract<BlobFactsOutcome, { kind: 'facts' }>['facts'], decoding: null };

export function hit(members: Record<string, Realization>, facts: StoredContent['facts']): HomeSettlement {
  const enumeration: ResourceEnumeration = {
    paths: Object.keys(members),
    conditions: [],
    outcome: { population: 'store', stored: 'hit' },
    extentSource: 'git',
    stored: { members: new Map(Object.entries(members)), facts, readByRun: false },
  };
  return { ok: true, enumeration };
}

/** A store hit whose one member the tier holds facts for: every member admitted, so the gate overlaps. */
export const ADMITTED_HOME = (): { tier: ReturnType<typeof tierOf>; settlement: HomeSettlement } => {
  const tier = tierOf({ [MARKDOWN_KEY]: FACTS });
  return { tier, settlement: hit({ [`${ROOT}/a.md`]: keyed(MARKDOWN_KEY) }, tier.facts) };
};

const PENDING = 'pending';

/** The decision if it has resolved once every queued callback has run, else `pending`. */
export async function settledDecision<T>(decision: Promise<T>): Promise<T | typeof PENDING> {
  await new Promise((resolve) => setImmediate(resolve));
  return Promise.race<T | typeof PENDING>([decision, Promise.resolve(PENDING)]);
}

/** An overlapped child run a test drives, recording its turns and abandonments. */
export interface FakeOverlappedRun {
  readonly run: OverlappedRun;
  /** Abandonments that acted (before any turn); one after the turn is a no-op, as the real run's is. */
  abandons: number;
  turns: number;
  /** The child exits. Never called models a child whose kill the OS refused. */
  exit(): void;
}

/**
 * @param options - What the turn and the abandonment come to
 * @param options.turn - The bytes the child had written before the turn, or the error the turn rejects with
 * @param options.abandonFails - The error an abandonment rejects with, if any
 * @returns The fake
 */
export function fakeOverlappedRun(options: {
  turn: { stderrBytesAtTurn: number } | Error;
  abandonFails: Error | undefined;
}): FakeOverlappedRun {
  const exited = Promise.withResolvers<undefined>();
  let turned = false;
  const fake: FakeOverlappedRun = {
    abandons: 0,
    turns: 0,
    exit: () => exited.resolve(undefined),
    run: {
      exited: exited.promise,
      atTurn: () => {
        turned = true;
        fake.turns += 1;
        if (options.turn instanceof Error) return Promise.reject(options.turn);
        const turn: OverlappedTurn = {
          value: { outcome: 'completed' } as unknown as SupervisedRun,
          leftover: undefined,
          stderrBytesAtTurn: options.turn.stderrBytesAtTurn,
        };
        return Promise.resolve(turn);
      },
      abandon: () => {
        if (turned) return Promise.resolve();
        fake.abandons += 1;
        return options.abandonFails === undefined ? Promise.resolve() : Promise.reject(options.abandonFails);
      },
    },
  };
  return fake;
}
