/**
 * An orchestrator that examined nothing — `vat validate` in a project whose
 * config declares no surface — is refused by the WRITER, and the writer says
 * that refusal on stderr exactly once: no verb says it for it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createValidateTopLevelCommand } from '../../src/commands/validate.js';
import { captureWriterRefusal } from '../helpers/stdout-capture.js';

describe('vat validate with no surface configured — the refusal reaches stderr once', () => {
  let root: string;

  beforeAll(() => {
    root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-validate-no-surface-')));
    writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), '{}\n', 'utf-8');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('publishes RESOURCE_CHECK_BROKEN, exits 1, and prints its finding line exactly once', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const { captured, refusal, refusalLines } = await captureWriterRefusal(async () => {
        await createValidateTopLevelCommand().parseAsync([], { from: 'user' });
      });

      expect(captured.exited, captured.stderr).toBe(1);
      expect(refusal).toBeDefined();
      expect(refusalLines).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
