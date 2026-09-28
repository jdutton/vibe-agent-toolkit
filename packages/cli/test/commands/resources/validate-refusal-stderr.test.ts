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
 * The refusal is now the writer's (from the registry's declared denominator),
 * and the phase warns on stderr with the message of the finding it published.
 * The document is still what gates — stderr is the human half of one statement.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type { Report } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runResourcesValidatePhase } from '../../../src/commands/resources/validate.js';
import { captureProcessExit } from '../../test-doubles.js';

describe('resources validate — the refusal message reaches stderr', () => {
  let root: string;

  beforeAll(() => {
    root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-rv-refusal-')));
    // An include that enumerates nothing: the project has no docs/ at all.
    writeFileSync(
      safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
      'version: 1\nresources:\n  include:\n    - "docs/**/*.md"\n',
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('warns on stderr, once, with the message the published refusal carries', async () => {
    let outcome: Awaited<ReturnType<typeof runResourcesValidatePhase>> | undefined;
    const { stderr } = await captureProcessExit(async () => {
      outcome = await runResourcesValidatePhase(root, {});
    });
    const document = outcome?.document as Report<unknown>;
    const [refusal] = document.findings;

    // The machine half: refused, exit 1.
    expect(outcome?.exitCode).toBe(1);
    expect(document.examined).toBe(0);
    expect(refusal?.code).toBe('RESOURCE_CHECK_BROKEN');
    // The human half: the same remedy text, on stderr, once, without `--verbose`.
    expect(stderr.split(refusal?.message ?? '<no refusal>')).toHaveLength(2);
    expect(stderr).toContain('`vat resources scan`');
  });

  it('refuses a --collection the project does not declare, on stderr and in the document', async () => {
    let outcome: Awaited<ReturnType<typeof runResourcesValidatePhase>> | undefined;
    const { stderr } = await captureProcessExit(async () => {
      outcome = await runResourcesValidatePhase(root, { collection: 'no-such-collection' });
    });
    const document = outcome?.document as Report<unknown>;

    // The invocation's mistake — not a run over nothing, and never INTERNAL_ERROR.
    expect(outcome?.exitCode).toBe(2);
    expect(document.status === 'error' ? document.error.code : document.status).toBe('USAGE_INVALID');
    expect(stderr).toContain('--collection no-such-collection names no collection');
  });
});
