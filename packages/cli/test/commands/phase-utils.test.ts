/**
 * Unit tests for phase orchestration (`vat build` / `verify` / `validate`).
 *
 * A phase is a function returning `{ report }` — the `Report<T>` its own
 * command would publish, before the writer's run-integrity pass — and the
 * orchestrator folds every phase into ONE report. These pin the fold: findings
 * flat and unchanged, `examined` summed, a phase that did not finish making the
 * run `error` / `RUN_INCOMPLETE` with the finished phases still in the data, and
 * integrity applied once to the sum rather than per phase.
 */

import { buildReport, exitCodeForReport, ExitCode, FindingSchema, reportSchema, type Finding, type Report } from '@vibe-agent-toolkit/schema';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ORCHESTRATOR_EXAMINED, ORCHESTRATOR_REPORT_SCHEMA } from '../../src/commands/orchestrator-schema.js';
import {
  applyPhaseSelection,
  orchestrate,
  ORCHESTRATOR_GATE,
  orchestratorReport,
  runPhase,
  type Phase,
  type PhaseResult,
} from '../../src/commands/phase-utils.js';
import { CommandRefusalError } from '../../src/utils/command-refusal.js';
import { NOTHING_FINISHED, publishedReport, refusalReport } from '../../src/utils/document-writer.js';
import { createLogger } from '../../src/utils/logger.js';
import { withRunIntegrity } from '../../src/utils/run-integrity.js';

const WARNING: Finding = { code: 'LINK_MISSING_TARGET', severity: 'warning', message: 'gone', location: 'docs/a.md' };
const ERROR: Finding = { code: 'LINK_MISSING_TARGET', severity: 'error', message: 'gone', location: 'skills/x/SKILL.md', line: 3 };

/** A phase schema that accepts any `data` — for the tests where the data is not the question. */
const ANY_DATA = reportSchema(z.unknown(), FindingSchema);

/** A phase schema whose `data` must be `{ name: string }`, strictly — the question for the schema tests. */
const NAMED_DATA = reportSchema(z.object({ name: z.string() }).strict(), FindingSchema);

/** Run `body` with stderr silenced (a refusal prints its diagnostics there). */
async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return await body();
  } finally {
    stderr.mockRestore();
  }
}

/** A completed phase over `examined` things with `findings`. */
function done(name: string, examined: number, findings: Finding[] = [], data: unknown = { name }): PhaseResult {
  return { name, report: buildReport({ examined, findings, data, gate: ORCHESTRATOR_GATE }) };
}

/** A phase that did not finish, refused with `code`. */
function refused(name: string): PhaseResult {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return { name, report: refusalReport('CONFIG_INVALID', new Error(`${name} config is broken`), ORCHESTRATOR_GATE, NOTHING_FINISHED) };
  } finally {
    stderr.mockRestore();
  }
}

/** What the writer publishes for these phases, validated against the registered schema. */
function published(results: PhaseResult[]): Report<unknown> {
  return publishedReport('verify', orchestratorReport(results, ORCHESTRATOR_GATE, 5));
}

describe('orchestratorReport', () => {
  it('publishes every phase\'s findings flat, with their location unchanged, and sums examined', () => {
    const report = published([done('resources', 4, [WARNING]), done('skills', 2, [ERROR])]);

    expect(report.status).toBe('findings');
    expect(report.examined).toBe(6);
    expect(report.findings).toEqual([WARNING, ERROR]);
    expect(report.summary).toEqual({ errors: 1, warnings: 1, info: 0 });
    expect(exitCodeForReport(report)).toBe(ExitCode.FINDINGS);
  });

  it('carries each phase\'s status, count, summary and its own data under data.phases', () => {
    const report = published([done('resources', 4, [WARNING], { resources: 4 }), done('skills', 2)]);

    expect(report.data).toEqual({
      phases: [
        { name: 'resources', status: 'findings', examined: 4, summary: { errors: 0, warnings: 1, info: 0 }, data: { resources: 4 } },
        { name: 'skills', status: 'ok', examined: 2, summary: { errors: 0, warnings: 0, info: 0 }, data: { name: 'skills' } },
      ],
    });
  });

  it('a warning never fails the run', () => {
    expect(exitCodeForReport(published([done('skills', 1, [WARNING])]))).toBe(ExitCode.OK);
  });

  it('a phase system error publishes status error with the finished phases in data, exit 2', () => {
    const report = published([done('resources', 3, [WARNING]), refused('skills')]);

    expect(report.status).toBe('error');
    if (report.status !== 'error') throw new Error('unreachable');
    expect(report.error.code).toBe('RUN_INCOMPLETE');
    expect(report.error.message).toContain("'skills' (CONFIG_INVALID)");
    // The finished phase's work stands: its findings, its count, its entry.
    expect(report.findings).toEqual([WARNING]);
    expect(report.examined).toBe(3);
    expect((report.data as { phases: { name: string; status: string; error?: unknown }[] }).phases).toEqual([
      expect.objectContaining({ name: 'resources', status: 'findings' }),
      expect.objectContaining({ name: 'skills', status: 'error', error: { code: 'CONFIG_INVALID', message: 'skills config is broken' } }),
    ]);
    expect(exitCodeForReport(report)).toBe(ExitCode.ERROR);
    // A refusal document carries no `durationMs`, though the run was timed.
    expect(report).not.toHaveProperty('durationMs');
  });

  it('applies run integrity ONCE, to the sum: a phase that examined nothing does not fail a run that examined something', () => {
    // A project with a resources: block and a skills: block that matched no
    // SKILL.md, or a marketplace of plugin-local skills and no skills: pool.
    const report = published([done('resources', 5), done('skills', 0)]);

    expect(report.status).toBe('ok');
    expect(exitCodeForReport(report)).toBe(ExitCode.OK);
  });

  it('refuses a run whose every phase examined nothing — and a run of no phase at all', () => {
    for (const results of [[done('skills', 0)], []]) {
      const report = published(results);
      expect(report.findings.map((finding) => finding.code)).toEqual(['RESOURCE_CHECK_BROKEN']);
      expect(report.findings[0]?.message).toContain(ORCHESTRATOR_EXAMINED.whenZero);
      expect(exitCodeForReport(report)).toBe(ExitCode.FINDINGS);
    }
  });

  it('is what the registered schema describes', () => {
    const report = withRunIntegrity(orchestratorReport([done('a', 1, [ERROR]), refused('b')], ORCHESTRATOR_GATE), ORCHESTRATOR_EXAMINED);
    expect(() => ORCHESTRATOR_REPORT_SCHEMA.parse(report)).not.toThrow();
  });
});

describe('runPhase', () => {
  it('hands back the phase\'s report under its name', async () => {
    const report = done('skills', 2).report;
    expect(await runPhase({ name: 'skills', schema: NAMED_DATA, run: () => Promise.resolve({ report }) })).toEqual({ name: 'skills', report });
  });

  /**
   * The orchestrator's schema holds a phase's `data` as `unknown`, so nothing
   * downstream of the fold could catch a phase publishing data its own verb's
   * schema does not describe. `runPhase` holds each report to the schema the
   * phase declares, and a report that fails it is VAT's defect.
   */
  it('refuses a phase whose report its own schema rejects — INTERNAL_ERROR, never folded as finished', async () => {
    const report = buildReport({ examined: 1, findings: [], data: { name: 'skills', extra: true }, gate: ORCHESTRATOR_GATE });
    const result = await quietly(() => runPhase({ name: 'skills', schema: NAMED_DATA, run: () => Promise.resolve({ report }) }));

    expect(result.report).toMatchObject({ status: 'error', error: { code: 'INTERNAL_ERROR' }, examined: 0 });
    expect(orchestratorReport([result], ORCHESTRATOR_GATE)).toMatchObject({ status: 'error', error: { code: 'RUN_INCOMPLETE' } });
  });

  /**
   * The backstop. A phase returns its own refusal as a report; a throw that
   * escaped that would abort the orchestrator's loop and silently skip every
   * later phase, so it becomes the phase's refusal instead — INTERNAL_ERROR
   * when it carries no code, since an uncoded escape is VAT's defect.
   */
  it('turns a throw past the phase\'s own handling into that phase\'s refusal', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runPhase({ name: 'skills', schema: ANY_DATA, run: () => Promise.reject(new Error('registry blew up')) });

      expect(result.report.status).toBe('error');
      expect(result.report).toMatchObject({ error: { code: 'INTERNAL_ERROR', message: 'registry blew up' }, examined: 0 });
      expect(exitCodeForReport(orchestratorReport([result], ORCHESTRATOR_GATE))).toBe(ExitCode.ERROR);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('applyPhaseSelection', () => {
  const logger = createLogger({});
  const phases: Phase[] = [{ name: 'skills', schema: ANY_DATA, run: () => Promise.resolve({ report: done('skills', 1).report }) }];

  it('returns the phases untouched when there is work to do', () => {
    expect(applyPhaseSelection({ kind: 'run', phases }, logger)).toBe(phases);
  });

  it('throws the selection\'s refusal, carrying its code, for the orchestrator to publish', () => {
    expect(() => applyPhaseSelection({ kind: 'fail', code: 'USAGE_INVALID', message: "Phase 'claude' is not configured" }, logger))
      .toThrow(expect.objectContaining({ refusal: 'USAGE_INVALID', message: "Phase 'claude' is not configured" }));
  });

  it('runs no phase for a warned no-op — the writer refuses the zero-examined run', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(applyPhaseSelection({ kind: 'noop', warning: 'check your config' }, logger)).toEqual([]);
    expect(warn).toHaveBeenCalledWith('check your config');
  });
});

describe('orchestrate', () => {
  it('folds a clean run into the one report, over every phase the body recorded', async () => {
    const report = await orchestrate((results) => {
      results.push(done('resources', 3, [WARNING]), done('skills', 2));
      return Promise.resolve();
    });

    expect(report).toMatchObject({ status: 'findings', examined: 5, findings: [WARNING] });
  });

  /**
   * The run itself refused AFTER phases finished — discovery that could not see
   * the tree, a package.json the OS would not read. The refusal carries its own
   * code, and the finished phases' work stands in the envelope.
   */
  it('publishes a throw after phases finished as that code, with the finished phases in data', async () => {
    const report = await quietly(() => orchestrate((results) => {
      results.push(done('resources', 3, [WARNING]));
      throw new CommandRefusalError('INPUT_UNREADABLE', 'dist/ could not be read');
    }));

    expect(report.status).toBe('error');
    if (report.status !== 'error') throw new Error('unreachable');
    expect(report.error).toEqual({ code: 'INPUT_UNREADABLE', message: 'dist/ could not be read' });
    expect(report.examined).toBe(3);
    expect(report.findings).toEqual([WARNING]);
    expect(report.data).toEqual({
      phases: [{ name: 'resources', status: 'findings', examined: 3, summary: { errors: 0, warnings: 1, info: 0 }, data: { name: 'resources' } }],
    });
    expect(() => ORCHESTRATOR_REPORT_SCHEMA.parse(publishedReport('verify', report))).not.toThrow();
    expect(exitCodeForReport(report)).toBe(ExitCode.ERROR);
  });

  it('publishes a throw before any phase finished with nothing finished: data null, examined 0', async () => {
    const report = await quietly(() => orchestrate(() => {
      throw new CommandRefusalError('USAGE_INVALID', 'a path argument');
    }));

    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' }, examined: 0, findings: [], data: null });
  });
});
