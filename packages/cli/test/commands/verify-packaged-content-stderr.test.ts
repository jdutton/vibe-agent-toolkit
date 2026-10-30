/**
 * `vat verify`'s `packaged-content` refusal must be logged, so stderr agrees
 * with the exit code.
 *
 * ## The defect
 *
 * The command reported the crawl's findings on stderr BEFORE deriving the
 * phase document — `if (crawl.issues.length > 0) report(crawl.issues)` — and
 * the zero-bundle refusal is derived inside `buildPackagedContentPhase`, one
 * line later. So on an unbuilt project the crawl found nothing, nothing was
 * logged, the skills phase's `✅ All validations passed` was the last line on
 * stderr, and the process exited 1 on a refusal that existed only in the YAML.
 * `run-integrity.ts` invariant 6: stderr may carry the human warning, and the
 * document and the exit code must agree with it.
 *
 * The phase reports the findings it derived, and `runPhase` — which derives the
 * zero-bundle refusal, through the one helper every phase's zero goes through —
 * says that refusal on stderr as it adds it. So what stderr says and what the
 * exit code is computed from are one list.
 */

import { describe, expect, it, vi } from 'vitest';

import { runPhase } from '../../src/commands/phase-utils.js';
import {
  buildPackagedContentPhase,
  IN_PROCESS_PHASES,
  reportPackagedContentPhase,
  runPackagedContentPhase,
} from '../../src/commands/verify.js';
import { fakePluginLocalIndex } from '../helpers/plugin-local-fixture.js';
import { recordingLogger } from '../test-doubles.js';

describe('verify packaged-content — the refusal reaches stderr', () => {
  it('says the zero-bundle refusal on stderr beside publishing it', async () => {
    // No discovered skills → no bundle to crawl → refused. A root that does
    // not exist is fine: nothing is read when there is nothing to crawl.
    const { logger } = recordingLogger();
    const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let stderr: string;
    let phase: Awaited<ReturnType<typeof runPhase>>;
    try {
      phase = await runPhase({
        ...IN_PROCESS_PHASES['packaged-content'],
        run: () => Promise.resolve({ report: runPackagedContentPhase('/no-such-project-pc', [], fakePluginLocalIndex([]), new Map(), logger).report }),
      });
      stderr = written.mock.calls.map(([line]) => String(line)).join('');
    } finally {
      written.mockRestore();
    }

    expect(phase.report.status).toBe('findings');
    expect(phase.report.examined).toBe(0);
    expect(phase.report.findings.map((finding) => finding.code)).toEqual(['RESOURCE_CHECK_BROKEN']);
    expect(stderr).toContain('Warning: Nothing was examined: 0 built skill bundles');
    expect(stderr).toContain('packaged-content phase');
    expect(stderr).toContain('vat build');
  });

  it('says why a run whose every discovered skill is in place inspected nothing', () => {
    const { logger, lines } = recordingLogger();
    const crawl = { bundlesInspected: 0, bundlesExpected: 0, bundlesMissing: [], issues: [] };

    const phase = buildPackagedContentPhase({ ...crawl, bundlesInPlace: 2 });
    reportPackagedContentPhase(phase, logger);

    expect(phase.report.status).toBe('ok');
    expect(lines.join('\n')).toContain('nothing to inspect: all 2 discovered skill(s) are in place');

    // Control: a stale in-place bundle that WAS inspected cleanly logs no such line.
    const inspected = recordingLogger();
    reportPackagedContentPhase(buildPackagedContentPhase({ ...crawl, bundlesInspected: 1, bundlesInPlace: 2 }), inspected.logger);
    expect(inspected.lines).toEqual([]);
  });
});
