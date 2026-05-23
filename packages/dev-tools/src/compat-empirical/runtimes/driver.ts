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
  triggerPrompt: string;
  expected: ExpectedBehavior;
  /** Where to write the transcript artifact. Caller owns the directory. */
  transcriptDir: string;
  /** Timeout in milliseconds, applied to fully-scripted drivers. */
  timeoutMs?: number;
  /** Skill identifier for record-keeping. */
  skillId: string;
}

export interface RuntimeDriver {
  readonly target: Target;
  readonly driverMode: DriverMode;
  setup(): Promise<void>;
  install(skill: StagedSkill): Promise<{ ok: boolean; notes: string }>;
  invoke(opts: InvokeOpts): Promise<RuntimeObservation>;
  teardown(): Promise<void>;
}
