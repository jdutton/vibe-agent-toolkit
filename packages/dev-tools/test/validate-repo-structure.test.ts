/**
 * Unit tests for the severity-counts ratchet's source recognisers.
 *
 * The whole-repo run in `validate-repo-structure.ts` can only report the lanes it
 * SAW. A lane it never saw produces no output at all, so a green run is not
 * evidence that the population is right. These tests pin the recognisers directly.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';

import {
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import {
  runGitOrThrow,
} from '@vibe-agent-toolkit/utils/git';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import {
  classifySeverityCountsLane,
  contrabandPopulation,
  readTrackedFile,
  walkDirectory,
} from '../src/validate-repo-structure.js';

/** A lane whose status is a string literal from the vocabulary, with findings beside it. */
const LITERAL_STATUS_LANE = `
export interface Result {
  status: 'success' | 'error';
  issues: Issue[];
}
export function run(): Result {
  return { status: 'error', issues: [] };
}
`;

/** The shape `corpus/report.ts` uses: a NAMED status type, no vocabulary literal on the line. */
const NAMED_STATUS_TYPE_LANE = `
export type ReviewStatus = 'ok' | 'error' | 'skipped';

export interface ReviewSummary {
  reviewed: number;
  failed: number;
}

export interface ReviewOutcome {
  status: ReviewStatus;
  duration_ms: number;
  summary?: ReviewSummary;
  errors?: string[];
}
`;

/** A per-severity distribution published under a name outside the known set. */
const SHAPED_COUNTS_LANE = `
export type AuditStatus = 'success' | 'warning' | 'error';

export interface AuditSummary {
  errors: number;
  warnings: number;
  info: number;
  files_scanned: number;
}

export interface AuditOutcome {
  status: AuditStatus;
  summary?: AuditSummary;
}
`;

describe('classifySeverityCountsLane — regression guards', () => {
  it('sees a lane that calls the shared collapse, whatever it names its findings', () => {
    const result = classifySeverityCountsLane(`
      const status = calculateValidationStatus(rows);
    `);
    expect(result).toEqual({ isLane: true, publishesCounts: true });
  });

  it('sees a lane that builds the shared report envelope, and reads it as publishing counts', () => {
    // `buildReport()` derives `status` AND `summary` from the findings in one
    // place, so a lane migrated onto the envelope spells neither a status
    // literal nor a counts property — the migration that FIXED the lane erased
    // it from the population (three commands went "stale" the day they moved).
    const result = classifySeverityCountsLane(`
      return buildReport<CheckData>({ examined, findings, data });
    `);
    expect(result).toEqual({ isLane: true, publishesCounts: true });
  });

  it('sees a lane that imports the envelope builder under an alias', () => {
    // The alias is arbitrary, so the IMPORT is the structural fact the
    // recogniser keys on, not the call.
    const aliased = `
      import { buildReport as buildEnvelope } from '@vibe-agent-toolkit/schema';
      const r = buildEnvelope({ examined: 1, findings, data });
    `;
    expect(classifySeverityCountsLane(aliased)).toEqual({ isLane: true, publishesCounts: true });
  });

  it('sees a literal-status lane and marks it nonconforming without counts', () => {
    expect(classifySeverityCountsLane(LITERAL_STATUS_LANE)).toEqual({
      isLane: true,
      publishesCounts: false,
    });
  });

  it('does not read prose ABOUT the contract as the contract', () => {
    const result = classifySeverityCountsLane(`
      /** Call countBySeverity(result.allErrors) and publish issueCounts beside the status. */
      export const NOT_A_LANE = 1;
    `);
    expect(result).toEqual({ isLane: false, publishesCounts: false });
  });

  it('ignores a file that emits no verdict at all', () => {
    expect(classifySeverityCountsLane('export const x = 1;\n').isLane).toBe(false);
  });
});

describe('classifySeverityCountsLane — named status types', () => {
  it('sees a lane whose status is a NAMED type rather than a literal', () => {
    expect(classifySeverityCountsLane(NAMED_STATUS_TYPE_LANE).isLane).toBe(true);
  });

  it("sees a declared vocabulary whose only success value is 'ok'", () => {
    const okOnly = `
      export type RunStatus = 'ok' | 'skipped';
      export interface RunOutcome { status: RunStatus; }
    `;
    expect(classifySeverityCountsLane(okOnly).isLane).toBe(true);
  });

  it('judges a named-status lane WITHOUT counts as nonconforming', () => {
    expect(classifySeverityCountsLane(NAMED_STATUS_TYPE_LANE).publishesCounts).toBe(false);
  });

  it('accepts a per-severity distribution published under another name', () => {
    expect(classifySeverityCountsLane(SHAPED_COUNTS_LANE)).toEqual({
      isLane: true,
      publishesCounts: true,
    });
  });

  it('does not mistake a lone `errors` field for a per-severity distribution', () => {
    const errorsOnly = `
      export type GateStatus = 'success' | 'error';
      export interface GateResult { status: GateStatus; errors: string[]; }
    `;
    expect(classifySeverityCountsLane(errorsOnly).publishesCounts).toBe(false);
  });

  it('accepts a lane that DERIVES its counts block from the shared type', () => {
    // The refactor that strengthens a lane must not erase it. Deriving from
    // `SeverityCounts` deletes the three hand-declared properties the shape
    // recogniser keys on, so without a dedicated arm the improved file reads as
    // a REGRESSION — which is exactly what happened to `corpus/report.ts`.
    const derived = `
      import type { SeverityCounts } from '@vibe-agent-toolkit/schema';
      export type GateStatus = 'success' | 'error';
      export interface GateSummary extends SeverityCounts { files_scanned: number; }
      export interface GateResult { status: GateStatus; summary: GateSummary; }
    `;
    expect(classifySeverityCountsLane(derived)).toEqual({
      isLane: true,
      publishesCounts: true,
    });
  });

  it('does not read a MENTION of the shared type in prose as derivation', () => {
    const proseOnly = `
      export type GateStatus = 'success' | 'error';
      /** Someday this should extend SeverityCounts. It does not yet. */
      export interface GateResult { status: GateStatus; errors: string[]; }
    `;
    expect(classifySeverityCountsLane(proseOnly).publishesCounts).toBe(false);
  });

  // The first version of the derivation arm matched the BARE NAME
  // `SeverityCounts`. Each case below was certified by it while publishing no
  // distribution at all. Consuming a type is not publishing one.
  it.each([
    ['a string literal naming the type', `throw new Error('expected SeverityCounts, got nothing');`],
    ['a pure CONSUMER of the type', `export function render(c: SeverityCounts): string { return String(c); }`],
    ['a bare re-export', `export type { SeverityCounts } from './counts.js';`],
    ['an unrelated identifier of the same name', `const SeverityCounts = 0;`],
  ])('does not certify %s', (_label, body) => {
    const lane = `
      export type GateStatus = 'success' | 'error';
      export interface GateResult { status: GateStatus; errors: string[]; }
      ${body}
    `;
    expect(classifySeverityCountsLane(lane).publishesCounts).toBe(false);
  });

  it('still sees the counts field VANISH from a lane that merely imports the type', () => {
    // The regression the bucket notes for `phase-utils.ts`, `skills/package.ts`
    // and `validators/types.ts` exist to catch. All three conform via the counts
    // PROPERTY, not the shared collapse, and all three keep an
    // `import type { SeverityCounts }` line that a bare-name match would have
    // accepted on its own — silently certifying the very deletion under test.
    const regressed = `
      import type { SeverityCounts } from '@vibe-agent-toolkit/schema';
      export type GateStatus = 'success' | 'error';
      export interface GateResult { status: GateStatus; findings: string[]; }
      export function toCounts(c: SeverityCounts): SeverityCounts { return c; }
    `;
    expect(classifySeverityCountsLane(regressed)).toEqual({
      isLane: true,
      publishesCounts: false,
    });
  });
});

/** Encoding for every fixture file this suite writes. */
const UTF8 = 'utf8';

/** Committed before the gate runs — the population `git ls-files` already saw. */
const TRACKED_FILE = 'tracked.ts';
/** Written but never committable: the shape the token list itself has. */
const IGNORED_FILE = 'ignored.ts';
/** Written, not staged — the state every new file is in when the gate runs. */
const NEW_FILE = 'nested/brand-new.ts';

/**
 * A throwaway repo holding one file in each staging state that matters.
 *
 * @returns The repo root
 */
function repoWithStagingStates(): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'contraband-pop-'));
  const git = (...args: string[]): void => {
    runGitOrThrow(args, { cwd: root });
  };
  const write = (relPath: string, body: string): void => {
    writeFileSync(safePath.join(root, relPath), body, UTF8);
  };

  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');

  write('.gitignore', `${IGNORED_FILE}\n`);
  write(TRACKED_FILE, '// tracked\n');
  git('add', '.gitignore', TRACKED_FILE);
  git('commit', '-qm', 'initial');

  // The state the gate was blind to: a NEW file, written but not yet staged.
  // This repo validates ONCE and commits at the end, so every new file is in
  // exactly this state at the moment the gate runs.
  mkdirSyncReal(safePath.join(root, 'nested'), { recursive: true });
  write(NEW_FILE, '// new\n');
  write(IGNORED_FILE, '// ignored\n');
  return root;
}

/**
 * The population, with separators normalised so Windows compares equal.
 *
 * @returns Every path the gate would read
 */
function population(): readonly string[] {
  return contrabandPopulation(repoWithStagingStates()).map((p) => toForwardSlash(p));
}

describe('contrabandPopulation — what the confidentiality gate is allowed to miss', () => {
  it('includes a brand-new untracked file, because that is what the commit will publish', () => {
    expect(population()).toContain(NEW_FILE);
  });

  it('still includes tracked files', () => {
    expect(population()).toContain(TRACKED_FILE);
  });

  it('excludes ignored files, which no commit will publish', () => {
    // Not pedantry: the token list itself may be a gitignored file in the repo
    // root, so a population that swept ignored files would report the list of
    // secrets as a leak of them.
    expect(population()).not.toContain(IGNORED_FILE);
  });

  it('lists each path once, however many git listings named it', () => {
    const paths = population();
    expect(new Set(paths).size).toBe(paths.length);
  });
});

/** `chmod 000` denies nothing to uid 0 and binds nothing on Windows. */

/**
 * The content rules read every tracked file. A file that is absent from the
 * working tree (a sparse checkout, a delete not yet committed) has no content
 * to check and is skipped. A file the OS REFUSES to read is different: the
 * rules over its content did not run, and a gate that says nothing about that
 * reads as a clean bill of health for a file it never saw.
 */
describe('readTrackedFile — what an unreadable tracked file does to the gate', () => {
  it('returns null and records nothing for a file that is not there', async () => {
    const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'read-tracked-'));
    const recorded: string[] = [];

    const bytes = await readTrackedFile(safePath.join(root, 'gone.ts'), (reason) => recorded.push(reason));

    expect(bytes).toBeNull();
    expect(recorded).toEqual([]);
  });

  it.skipIf(CANNOT_DENY_READS)('returns null and records the refusal, naming the errno, for a file it may not read', async () => {
    const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'read-tracked-'));
    const locked = safePath.join(root, 'locked.ts');
    writeFileSync(locked, '// locked\n', UTF8);
    chmodSync(locked, 0o000);
    const recorded: string[] = [];

    try {
      const bytes = await readTrackedFile(locked, (reason) => recorded.push(reason));
      expect(bytes).toBeNull();
    } finally {
      chmodSync(locked, 0o600);
    }
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain('EACCES');
  });
});

describe('walkDirectory — a directory the walk could not list', () => {
  it('is a no-op over a directory that does not exist', async () => {
    const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'walk-dir-'));
    const seen: string[] = [];

    await walkDirectory(safePath.join(root, 'absent'), 'absent', {
      onFile: async ({ relPath }) => {
        seen.push(relPath);
      },
    });

    expect(seen).toEqual([]);
  });

  it.skipIf(CANNOT_DENY_READS)('throws rather than reporting the directory as empty when the listing is refused', async () => {
    const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'walk-dir-'));
    const locked = safePath.join(root, 'locked');
    mkdirSyncReal(locked, { recursive: true });
    writeFileSync(safePath.join(locked, 'inside.ts'), '// inside\n', UTF8);
    chmodSync(locked, 0o000);

    try {
      await expect(walkDirectory(locked, 'locked', {})).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
