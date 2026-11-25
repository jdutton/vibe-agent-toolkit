/**
 * An arm's state and its one spelling: `warm`, `cold`, or an edit arm's
 * `warm-edit<N>[:<kind>]` (see `edit-step.ts`). `--arm`, `--bar`, the report and
 * the arm's directory name all go through here, so no two spell one arm two ways.
 *
 * Imports nothing at run time: `arm-dirs.ts` names directories with it, and
 * `edit-step.ts` refuses through `arm-dirs.ts`.
 */

import type { EditKind } from './edit-step.js';
import type { ArmState, EditState } from './types.js';

/** Every edit kind, in the spelling `warm-edit<N>:<kind>` takes. */
const EDIT_KINDS: readonly EditKind[] = ['modify', 'create', 'delete'];

/** The kind an arm name that spells none means. */
const DEFAULT_EDIT_KIND: EditKind = 'modify';

/**
 * @param state - An arm state
 * @returns Whether it is an edit arm's
 */
export function isEditState(state: ArmState): state is EditState {
  return typeof state === 'object';
}

/** An arm state in its spelling: `warm`, `cold`, `warm-edit<N>`, or `warm-edit<N>:<create|delete>`. */
const ARM_STATE = /^(?:warm|cold|warm-edit([1-9]\d*)(?::(modify|create|delete))?)$/u;

/**
 * @param text - A state as `--arm`, `--bar` and the report spell it
 * @returns The state, or `null` when it is none
 */
export function parseArmState(text: string): ArmState | null {
  const match = ARM_STATE.exec(text);
  if (match === null) return null;
  const [whole, count, kind] = match;
  if (whole === 'warm' || whole === 'cold') return whole;
  return { warm: 'edit', count: Number(count), kind: EDIT_KINDS.find((each) => each === kind) ?? DEFAULT_EDIT_KIND };
}

/**
 * @param state - An arm state
 * @returns Its one spelling; the default kind is never spelled, so `warm-edit1:modify` and `warm-edit1` are one arm
 */
export function armStateName(state: ArmState): string {
  if (!isEditState(state)) return state;
  const kind = state.kind === DEFAULT_EDIT_KIND ? '' : `:${state.kind}`;
  return `warm-edit${String(state.count)}${kind}`;
}

/**
 * @param state - An arm state
 * @returns Its spelling as a directory-name segment (no `:`)
 */
export function armStateSegment(state: ArmState): string {
  return armStateName(state).replace(':', '-');
}
