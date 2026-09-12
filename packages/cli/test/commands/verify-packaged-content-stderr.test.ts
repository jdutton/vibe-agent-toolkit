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
 * The phase runner now reports the DOCUMENT's issues — the refusal included —
 * so what stderr says and what the exit code is computed from are one list.
 */

import { describe, expect, it } from 'vitest';

import { runPackagedContentPhase } from '../../src/commands/verify.js';
import { recordingLogger } from '../test-doubles.js';

describe('verify packaged-content — the refusal reaches stderr', () => {
  it('logs the zero-bundle refusal beside publishing it', () => {
    // No discovered skills → no bundle to crawl → refused. A root that does
    // not exist is fine: nothing is read when there is nothing to crawl.
    const { logger, lines } = recordingLogger();

    const phase = runPackagedContentPhase('/no-such-project-pc', [], logger);
    const stderr = lines.join('\n');

    expect(phase.status).toBe('error');
    expect(phase.bundlesInspected).toBe(0);
    expect(stderr).toContain('▶ Phase: packaged-content');
    expect(stderr).toContain('RESOURCE_CHECK_BROKEN');
    expect(stderr).toContain('inspected 0 built skill bundles');
    expect(stderr).toContain('vat build');
  });
});
