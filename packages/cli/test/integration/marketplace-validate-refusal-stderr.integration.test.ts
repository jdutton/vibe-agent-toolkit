/**
 * The writer's zero-examined refusal on `vat claude marketplace validate` must
 * reach the OPERATOR, not only the document — the same statement `vat
 * resources validate` makes (`test/commands/resources/validate-refusal-stderr.test.ts`).
 *
 * The phase hands back its report BEFORE the writer's run-integrity pass
 * (inside `vat verify`, zero examined is judged on the whole run), so the
 * refusal for a manifest with no plugin entry is ADDED by the writer — and the
 * command lane is the only place that can warn with it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type { Report } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as YAML from 'yaml';

import { createMarketplaceValidateCommand } from '../../src/commands/claude/marketplace/validate.js';
import { captureCommand, captureWriterRefusal } from '../helpers/stdout-capture.js';

describe('claude marketplace validate — the writer\'s refusal reaches stderr', () => {
  let root: string;

  beforeAll(() => {
    root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-mv-refusal-')));
    mkdirSyncReal(safePath.join(root, '.claude-plugin'));
    // A well-formed manifest that declares no plugin: nothing to examine.
    writeFileSync(
      safePath.join(root, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'empty-mp', owner: { name: 'Test Org' }, plugins: [] }),
    );
    for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md']) writeFileSync(safePath.join(root, file), 'x\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('warns on stderr, once, with the message the published refusal carries', async () => {
    const { captured, document, refusal, refusalLines } = await captureWriterRefusal(async () => {
      await createMarketplaceValidateCommand().parseAsync([root], { from: 'user' });
    });

    expect(captured.exited).toBe(1);
    expect(document.examined).toBe(0);
    expect(refusal).toBeDefined();
    // As the finding line every other finding prints as: once, never a bare `Warning:` beside it.
    expect(refusalLines).toBe(1);
    expect(captured.stderr.split(refusal?.message ?? '<no refusal>')).toHaveLength(2);
    expect(captured.stderr).not.toContain('Warning:');
    // The count line is the published document's, never the pre-refusal "0 error(s)" beside exit 1.
    expect(captured.stderr).not.toContain('0 error(s)');
    expect(captured.stderr).toContain(`${document.summary.errors} error(s)`);
    // The refusal first, then the count it produced — the count summarizes what was said above it.
    expect(captured.stderr.indexOf(refusal?.message ?? '<no refusal>')).toBeLessThan(captured.stderr.indexOf(`${document.summary.errors} error(s)`));
  });

  it('prints no count line for a REFUSED run: stderr never contradicts the exit code', async () => {
    const captured = await captureCommand(async () => {
      await createMarketplaceValidateCommand().parseAsync([safePath.join(root, 'no-such-dir')], { from: 'user' });
    });

    expect(captured.exited).toBe(2);
    expect((YAML.parse(captured.stdout) as Report<unknown>).status).toBe('error');
    expect(captured.stderr).not.toMatch(/error\(s\)/);
  });
});
