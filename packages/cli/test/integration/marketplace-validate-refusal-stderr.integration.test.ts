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
import { captureCommand } from '../helpers/stdout-capture.js';

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
    const captured = await captureCommand(async () => {
      await createMarketplaceValidateCommand().parseAsync([root], { from: 'user' });
    });
    const document = YAML.parse(captured.stdout) as Report<unknown>;
    const refusal = document.findings.find((finding) => finding.code === 'RESOURCE_CHECK_BROKEN');

    expect(captured.exited).toBe(1);
    expect(document.examined).toBe(0);
    expect(refusal).toBeDefined();
    expect(captured.stderr.split(refusal?.message ?? '<no refusal>')).toHaveLength(2);
  });
});
