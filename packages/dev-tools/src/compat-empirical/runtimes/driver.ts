/**
 * Runtime driver interface — one implementation per target. Drivers may be
 * `scripted` (fully automated), `scripted-assisted` (harness preps + waits
 * for a human confirmation), or `manual` (human does everything; harness
 * captures the result).
 */

import type { StagedSkill } from '../corpus/fetch-sources.js';
import type {
  DriverMode,
  ExpectedBehavior,
  RuntimeObservation,
  Target,
} from '../types.js';

export interface InvokeOpts {
  /** Skill identifier for record-keeping. */
  skillId: string;
  /** Trigger prompt id — written through to RuntimeObservation.promptId. */
  promptId: string;
  /** Zero-based attempt index for repeatN runs. */
  attemptIdx: number;
  triggerPrompt: string;
  expected: ExpectedBehavior;
  /** Where to write the transcript artifact. Caller owns the directory. */
  transcriptDir: string;
  /** Timeout in milliseconds, applied to fully-scripted drivers. */
  timeoutMs?: number;
  /**
   * Optional staged skill. Drivers that recreate per-invoke state (e.g.
   * claude-code's temp profile) use this to (re)install the skill inside
   * `invoke()` so each attempt gets a clean slate. Manual drivers ignore it
   * — they install once per cell via `install()`.
   */
  skill?: StagedSkill;
}

export interface RuntimeDriver {
  readonly target: Target;
  readonly driverMode: DriverMode;
  setup(): Promise<void>;
  install(skill: StagedSkill): Promise<{ ok: boolean; notes: string }>;
  invoke(opts: InvokeOpts): Promise<RuntimeObservation>;
  teardown(): Promise<void>;
}
