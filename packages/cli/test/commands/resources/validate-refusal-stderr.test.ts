/**
 * The run-integrity refusal on `vat resources validate` must reach the
 * OPERATOR, not only the document.
 *
 * ## The defect
 *
 * The refusal once sat in the document as a row with an empty file name, and
 * stderr said nothing at all; run through `vat validate` it sat under
 * `phases[].report` with stderr reading `▶ Surface: resources` and no more.
 * `run-integrity.ts` invariant 5 says the message tells the operator what to
 * do; a message nobody sees does not.
 *
 * The refusal is the writer's (from the registry's declared denominator), and
 * the command warns on stderr with the message of the finding it published —
 * inside `vat validate` zero examined is judged on the whole run instead.
 * The document is still what gates — stderr is the human half of one statement.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type { Report } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runResourcesValidatePhase, validateCommand } from '../../../src/commands/resources/validate.js';
import { captureCommand } from '../../helpers/stdout-capture.js';
import { captureProcessExit } from '../../test-doubles.js';

describe('resources validate — the refusal message reaches stderr', () => {
  let root: string;

  beforeAll(() => {
    root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-rv-refusal-')));
    // An include that enumerates nothing: the project has no docs/ at all.
    writeFileSync(
      safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
      'resources:\n  include:\n    - "docs/**/*.md"\n',
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('warns on stderr, once, with the message the published refusal carries', async () => {
    const captured = await captureCommand(() => validateCommand(root, { format: 'json' }));
    const document = JSON.parse(captured.stdout) as Report<unknown>;
    const [refusal] = document.findings;

    // The machine half: refused, exit 1.
    expect(captured.exited).toBe(1);
    expect(document.examined).toBe(0);
    expect(refusal?.code).toBe('RESOURCE_CHECK_BROKEN');
    // The human half: the same remedy text, on stderr, once, without `--verbose`.
    expect(captured.stderr.split(refusal?.message ?? '<no refusal>')).toHaveLength(2);
    expect(captured.stderr).toContain('`vat resources scan`');
  });

  it('refuses a --collection the project does not declare, on stderr and in the report', async () => {
    let report: Report<unknown> | undefined;
    const { stderr } = await captureProcessExit(async () => {
      ({ report } = await runResourcesValidatePhase(root, { collection: 'no-such-collection' }));
    });

    // The invocation's mistake — not a run over nothing, and never INTERNAL_ERROR.
    expect(report?.status === 'error' ? report.error.code : report?.status).toBe('USAGE_INVALID');
    expect(stderr).toContain('--collection no-such-collection names no collection');
  });
});
