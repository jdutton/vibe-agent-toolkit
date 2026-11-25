/**
 * `vat validate`'s wiring of the checks overlap: the gate armed before the resources phase, the
 * checks turn that disarms it and takes its one decision, the end of the run that abandons a child
 * nobody read, and the debug-facts dump that states which mode ran.
 *
 * The gate itself (`checks-overlap-gate.ts`) is built from the run it listens to: the population's own root as the routing's base directory (the spelling the
 * population names its members by, so a `/tmp` root and its `/private/tmp` realpath cannot make
 * every member look foreign), and `RunPopulation.homeKey([])`, the home population the resources
 * phase crawls and the child populates the same way.
 *
 * Only a run with a `checks` phase arms a gate: a child spawned in a run with no checks turn would
 * be read by nobody.
 *
 * ## The post-spawn window
 *
 * The dump's write counts are this process's counter deltas from immediately before the spawn to
 * the CHILD's exit, raced with the end of the run's turn (or abandonment): a child whose kill the
 * OS refused never exits, and the run must still end and write its dump.
 */

import os from 'node:os';

import { parseRoutingFor, RunPopulation, type ProjectConfig } from '@vibe-agent-toolkit/resources';
import { readWorkCounters } from '@vibe-agent-toolkit/utils';

import { NO_HOME_SETTLED_LISTENER, type HomeSettledListener, type RunContext } from '../utils/resource-loader.js';

import {
  abandoningUnread,
  createChecksOverlapGate,
  type ChecksOverlapGate,
  type ChecksOverlapGateOptions,
  type GateDecision,
} from './checks-overlap-gate.js';
import { startOverlappedChecksPhase } from './resources/check.js';
import type { OverlappedRun } from './resources/overlapped-supervision.js';
import { openDebugFacts, writeDebugFacts, type ChecksPhaseObservation, type CounterSnapshot } from './validate-debug-facts.js';

/** What `vat validate` needs of its checks overlap. */
export interface ValidateChecksOverlap {
  /** `withRunContext`'s listener for the home population's settlement. */
  readonly homeSettledListener: (run: RunContext) => HomeSettledListener;
  /** The checks turn's first act: disarm the gate, and hand back its one decision. */
  readonly checksTurn: () => Promise<GateDecision>;
  /** Run the phases, then abandon a child whose turn never came; the dump follows. */
  readonly runPhases: (phases: () => Promise<void>) => Promise<void>;
}

/** The run's facts the gate is built over, beside the run itself. */
interface OverlapRequest {
  /** The project root the run resolved: the child checks exactly it. */
  readonly root: string;
  readonly debug: boolean;
  readonly base: string | undefined;
  /** The project's config: its collections route members as the resources phase does. */
  readonly config: ProjectConfig | undefined;
}

/** What the overlap reaches outside itself: the machine, the child, the counters and the dump. */
export interface OverlapSeams {
  /** The cores the run may use: the gate's condition (b). */
  readonly cores: () => number;
  /** Spawn the checks child ahead of its turn, asking `isArmed` immediately before the spawn. */
  readonly start: (isArmed: () => boolean) => Promise<OverlappedRun | 'disarmed'>;
  /** This process's work counters now. */
  readonly counters: () => CounterSnapshot;
  /** Write the debug-facts dump (nothing when the seam is off). Never throws. */
  readonly writeFacts: (observed: ChecksPhaseObservation) => void;
}

/**
 * The seams of a real run.
 *
 * @param request - The run's facts
 * @param env - Where the debug-facts seam is read from
 * @returns The seams
 */
export function liveOverlapSeams(request: OverlapRequest, env: NodeJS.ProcessEnv): OverlapSeams {
  const factsDirectory = openDebugFacts(env);
  return {
    // A property read at the call, not a captured function: a preload that patches the core count
    // reaches it.
    cores: () => os.availableParallelism(),
    start: (isArmed) => startOverlappedChecksPhase({ root: request.root, debug: request.debug, base: request.base, isArmed }),
    counters: readWorkCounters,
    writeFacts: (observed) => {
      writeDebugFacts(factsDirectory, observed);
    },
  };
}

/**
 * The gate's options for one run, less its spawn.
 *
 * @param run - The run the gate listens to
 * @param request - The run's facts
 * @param cores - The cores the run may use
 * @returns Every gate option but `spawn`
 */
export function gateOptionsFor(
  run: RunContext,
  request: OverlapRequest,
  cores: () => number,
): Omit<ChecksOverlapGateOptions, 'spawn'> {
  return {
    debug: request.debug,
    cores,
    childHomeKey: RunPopulation.homeKey([]),
    routing: parseRoutingFor(request.config, run.population.root),
  };
}

/** A run with no `checks` phase: no gate, no child, no dump. */
const NO_CHECKS_OVERLAP: ValidateChecksOverlap = {
  homeSettledListener: NO_HOME_SETTLED_LISTENER,
  checksTurn: () => Promise.reject(new Error('vat validate reached a checks turn in a run with no checks phase')),
  runPhases: (phases) => phases(),
};

/**
 * Build the overlap for one `vat validate` run.
 *
 * @param request - The run's facts, and whether it has a `checks` phase at all
 * @param request.checksPhase - Whether the run has a `checks` phase
 * @param seams - The machine, the child, the counters and the dump
 * @returns The overlap
 */
export function createValidateChecksOverlap(
  request: OverlapRequest & { readonly checksPhase: boolean },
  seams: OverlapSeams,
): ValidateChecksOverlap {
  if (!request.checksPhase) return NO_CHECKS_OVERLAP;
  let gate: ChecksOverlapGate | undefined;
  let observation: Promise<ChecksPhaseObservation> | undefined;
  const gateOf = (): ChecksOverlapGate => {
    if (gate === undefined) throw new Error('the checks overlap gate is built with the run, before any phase');
    return gate;
  };
  return {
    homeSettledListener: (run) => {
      gate = createChecksOverlapGate({
        ...gateOptionsFor(run, request, seams.cores),
        spawn: async (isArmed) => {
          const spawned = await spawnObserved(seams, isArmed);
          if (spawned === 'disarmed') return spawned;
          observation = spawned.observation;
          return spawned.run;
        },
      });
      return gate.onHomeSettled;
    },
    checksTurn: () => {
      gateOf().disarm();
      return gateOf().decision;
    },
    runPhases: async (phases) => {
      try {
        await abandoningUnread(gateOf(), phases);
      } finally {
        await writeObservation(seams, gateOf(), () => observation);
      }
    },
  };
}

/**
 * Spawn the child, taking the counters immediately before the synchronous spawn, and observe it.
 *
 * @param seams - The child and the counters
 * @param isArmed - The gate's question
 * @returns The observed run, or `'disarmed'`
 */
async function spawnObserved(
  seams: OverlapSeams,
  isArmed: () => boolean,
): Promise<{ run: OverlappedRun; observation: Promise<ChecksPhaseObservation> } | 'disarmed'> {
  // Retaken immediately before the spawn, when the gate answers armed: a run comes back only then.
  let atSpawn = seams.counters();
  const run = await seams.start(() => {
    const armed = isArmed();
    if (armed) atSpawn = seams.counters();
    return armed;
  });
  return run === 'disarmed' ? run : observing(run, atSpawn, seams.counters);
}

/**
 * Wrap a run so its turn (or its abandonment) records what the dump states: the bytes the child had
 * written before the turn, and the counters at the child's exit, raced with the turn's end.
 *
 * @param run - The spawned run
 * @param atSpawn - The counters immediately before the spawn
 * @param counters - Reads the counters
 * @returns The run to hand the checks turn, and what it will have observed once its turn ends
 */
function observing(
  run: OverlappedRun,
  atSpawn: CounterSnapshot,
  counters: () => CounterSnapshot,
): { run: OverlappedRun; observation: Promise<ChecksPhaseObservation> } {
  const ended = Promise.withResolvers<undefined>();
  const atChildExit = Promise.race([run.exited, ended.promise]).then(() => counters());
  let childStderrBytesAtTurn = 0;
  const ending = <T>(work: Promise<T>): Promise<T> => work.finally(() => ended.resolve(undefined));
  return {
    run: {
      exited: run.exited,
      atTurn: (write) => ending(run.atTurn(write).then((turn) => {
        childStderrBytesAtTurn = turn.stderrBytesAtTurn;
        return turn;
      })),
      abandon: () => ending(run.abandon()),
    },
    observation: Promise.all([atChildExit, ended.promise]).then(([atExit]) => ({
      mode: 'overlapped',
      childStderrBytesAtTurn,
      atSpawn,
      atChildExit: atExit,
    })),
  };
}

/**
 * Write the dump once the run's phases are over and its child is ended: the gate has decided (the
 * checks turn or {@link abandoningUnread} disarmed it), and an overlapped run's turn or
 * abandonment has ended.
 *
 * @param seams - Where the dump goes
 * @param gate - The run's gate
 * @param observation - The overlapped run's observation, once spawned
 */
async function writeObservation(
  seams: OverlapSeams,
  gate: ChecksOverlapGate,
  observation: () => Promise<ChecksPhaseObservation> | undefined,
): Promise<void> {
  gate.disarm();
  const decision = await gate.decision;
  if (decision.mode === 'sequential') return seams.writeFacts({ mode: 'sequential', declinedBy: decision.declinedBy });
  // An overlapped decision carries the run the spawn observed: its observation was set with it.
  const observed = observation();
  if (observed === undefined) throw new Error('the gate overlapped a run its spawn did not observe');
  seams.writeFacts(await observed);
}
