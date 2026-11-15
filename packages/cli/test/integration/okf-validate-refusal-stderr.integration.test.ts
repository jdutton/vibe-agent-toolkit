/**
 * `vat okf validate` refused over one unreadable bundle root still says every OTHER bundle's
 * findings on stderr — once, through the shared reporter — as it publishes them in the document.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { okfValidateCommand } from '../../src/commands/okf/validate.js';
import { captureCommand } from '../helpers/stdout-capture.js';

const CONFIG = 'okf:\n  bundles:\n    knowledge:\n      root: ./bundles/knowledge\n    gone:\n      root: ./bundles/gone\n';

describe('vat okf validate with one unreadable bundle root', () => {
  let root: string;

  beforeAll(() => {
    root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-okf-refusal-stderr-')));
    writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), CONFIG, 'utf-8');
    mkdirSyncReal(safePath.join(root, 'bundles/knowledge/concepts'), { recursive: true });
    writeFileSync(safePath.join(root, 'bundles/knowledge/concepts/a.md'), '# A\n', 'utf-8');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses INPUT_UNREADABLE and says the readable bundle\'s findings on stderr once', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const captured = await captureCommand(() => okfValidateCommand(undefined, { format: 'json' }));
      const document = JSON.parse(captured.stdout) as { status: string; error: { code: string }; findings: Array<{ code: string; severity: string; message: string }> };

      expect(captured.exited, captured.stderr).toBe(2);
      expect(document.error.code).toBe('INPUT_UNREADABLE');
      expect(document.findings.length).toBeGreaterThan(0);
      for (const finding of document.findings) {
        expect(captured.stderr.split(`${finding.severity}: ${finding.message} [${finding.code}]\n`), captured.stderr).toHaveLength(2);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});
