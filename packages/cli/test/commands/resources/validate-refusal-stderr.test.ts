/**
 * The run-integrity refusal on `vat resources validate` must reach the
 * OPERATOR, not only the document.
 *
 * ## The defect
 *
 * `withRunIntegrity` publishes the refusal as a row with `file: ''`, and the
 * default (non-verbose) listing projects a row to `{file, errors, codes}` — so
 * the document said `RESOURCE_CHECK_BROKEN: 1` beside an empty file name and
 * nothing else, and stderr said nothing at all. The message — which collection
 * matched nothing, "drop the filter", "`vat resources scan` lists what an
 * enumeration finds" — existed only under `--verbose`. Run through
 * `vat validate` the same row sat under `phases[].report` with stderr reading
 * `▶ Surface: resources` and no more. `run-integrity.ts` invariant 5 says the
 * message tells the operator what to do; a message nobody sees does not.
 *
 * `vat resources check` and `vat claude budget` warn on stderr beside the
 * document refusal; this pins the same for `validate`. The document is still
 * what gates — stderr is the human half of one statement.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runResourcesValidatePhase } from '../../../src/commands/resources/validate.js';
import { captureProcessExit } from '../../test-doubles.js';

describe('resources validate — the refusal message reaches stderr', () => {
  let root: string;

  beforeAll(() => {
    root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-rv-refusal-')));
    // An include that enumerates nothing: the project has no docs/ at all.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only temp path
    writeFileSync(
      safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
      'version: 1\nresources:\n  include:\n    - "docs/**/*.md"\n',
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('warns on stderr with the same message the document refuses with, in the default format', async () => {
    let outcome: Awaited<ReturnType<typeof runResourcesValidatePhase>> | undefined;
    const { stderr } = await captureProcessExit(async () => {
      outcome = await runResourcesValidatePhase(root, {});
    });
    const document = outcome?.document as { status: string; filesScanned: number };

    // The machine half, unchanged: refused, exit 1.
    expect(outcome?.exitCode).toBe(1);
    expect(document.status).toBe('error');
    expect(document.filesScanned).toBe(0);
    // The human half: the remedy text, on stderr, without `--verbose`.
    expect(stderr).toContain('No resource was scanned');
    expect(stderr).toContain('`vat resources scan`');
  });

  it('names the --collection filter that matched nothing', async () => {
    const { stderr } = await captureProcessExit(async () => {
      await runResourcesValidatePhase(root, { collection: 'no-such-collection' });
    });

    expect(stderr).toContain('--collection no-such-collection');
    expect(stderr).toContain('drop the filter');
  });

  it('does not double up under --format text, which already prints every reported row', async () => {
    const { stderr } = await captureProcessExit(async () => {
      await runResourcesValidatePhase(root, { format: 'text' });
    });

    expect(stderr.split('No resource was scanned')).toHaveLength(2);
  });
});
