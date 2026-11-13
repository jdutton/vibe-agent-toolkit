/**
 * `superviseQuery`: what a supervised query publishes once its child has ended, with the spawn and
 * the progress directory stubbed so the directory the OS would not remove can be handed in.
 *
 * A leftover progress directory is ONE `TREE_CLEANUP_INCOMPLETE` warning beside whatever the run
 * came to — a completed child's document, or the `RUN_INCOMPLETE` refusal of one that was killed —
 * said once on stderr; with no leftover, nothing is added. The spawned half is proved in
 * `resources-query-budget.system.test.ts`.
 */

import type { Report } from '@vibe-agent-toolkit/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { superviseRun, withProgressLog, type SupervisedRun } from '../../src/commands/resources/check-supervisor.js';
import { superviseQuery } from '../../src/commands/resources/query-supervision.js';
import { buildProjectionQueryReport } from '../../src/commands/resources/query.js';
import { createLogger } from '../../src/utils/logger.js';
import type * as OutputModule from '../../src/utils/output.js';
import { captureCommand } from '../helpers/stdout-capture.js';

vi.mock('../../src/commands/resources/check-supervisor.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  superviseRun: vi.fn(),
  withProgressLog: vi.fn(),
}));

// `writeStdoutSync` writes fd 1 directly, past the capture; route it through process.stdout.
vi.mock('../../src/utils/output.js', async (importOriginal) => ({
  ...(await importOriginal<typeof OutputModule>()),
  writeStdoutSync: (content: string) => process.stdout.write(content),
}));

/** The directory the OS would not remove, as `withTempDir` hands it back. */
const LEFTOVER = new Error('could not remove /scratch/vat-query-leftover: EBUSY');
const CLEANUP = 'TREE_CLEANUP_INCOMPLETE';

/** A completed child's document, as the supervisor read it. */
function completedRun(): SupervisedRun {
  const report = buildProjectionQueryReport({
    columns: ['n'],
    rows: [{ n: 1 }],
    membersEnumerated: 1,
    root: '/corpus',
    population: 'derived',
    lensPopulation: 'none',
    durationMs: 10,
    populationMs: 5,
    lensMs: 0,
    lensesEvaluated: [],
  });
  return { outcome: 'completed', document: { text: `${JSON.stringify(report)}\n`, report } };
}

const KILLED: SupervisedRun = { outcome: 'killed', log: '', elapsedMs: 1000 };

/** Run `superviseQuery` over a child that ended as `run`, the progress directory left or not. */
async function supervised(run: SupervisedRun, leftover: unknown): Promise<{ document: Report<unknown>; stderr: string; exited: number | undefined }> {
  vi.mocked(superviseRun).mockResolvedValue(run);
  vi.mocked(withProgressLog).mockImplementation(async (_verb, work) => ({
    value: await work({ path: '/scratch/progress.jsonl', guard: undefined as never }),
    ...(leftover === undefined ? {} : { leftover }),
  }));
  const captured = await captureCommand(() => superviseQuery({
    sql: 'SELECT 1 AS n',
    parameters: [],
    root: '/corpus',
    base: undefined,
    debug: false,
    format: 'json',
    budgetSecs: 5,
    logger: createLogger(),
  }));
  return { document: JSON.parse(captured.stdout) as Report<unknown>, stderr: captured.stderr, exited: captured.exited };
}

/** How many times `text` says `needle`. */
const timesSaid = (text: string, needle: string): number => text.split(needle).length - 1;

describe('superviseQuery — a progress directory the OS would not remove', () => {
  beforeEach(() => {
    vi.mocked(superviseRun).mockReset();
    vi.mocked(withProgressLog).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds exactly one cleanup warning to a completed child\'s document, and says it once', async () => {
    const { document, stderr, exited } = await supervised(completedRun(), LEFTOVER);

    expect(document.findings.map((finding) => finding.code)).toStrictEqual([CLEANUP]);
    expect(timesSaid(stderr, CLEANUP)).toBe(1);
    expect(exited).toBe(0);
  });

  it('forwards a completed child\'s document with no finding added when nothing was left', async () => {
    const { document, stderr } = await supervised(completedRun(), undefined);

    expect(document.findings).toStrictEqual([]);
    expect(stderr).not.toContain(CLEANUP);
  });

  it('puts exactly that warning beside a killed run\'s RUN_INCOMPLETE refusal', async () => {
    const { document, exited } = await supervised(KILLED, LEFTOVER);

    expect(document.findings.map((finding) => finding.code)).toStrictEqual([CLEANUP]);
    expect(JSON.stringify(document)).toContain('RUN_INCOMPLETE');
    expect(exited).toBe(2);
  });

  it('adds no finding to a killed run\'s refusal when nothing was left', async () => {
    const { document, exited } = await supervised(KILLED, undefined);

    expect(document.findings).toStrictEqual([]);
    expect(JSON.stringify(document)).toContain('RUN_INCOMPLETE');
    expect(exited).toBe(2);
  });
});
