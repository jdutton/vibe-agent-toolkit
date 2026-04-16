/* eslint-disable security/detect-non-literal-fs-filename */
// Test file reads a fixture path computed from __dirname — not user input
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { CODE_REGISTRY } from '../../src/validators/code-registry.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// Repo root is 4 levels up: packages/agent-skills/test/docs -> repo root
const REPO_ROOT = safePath.resolve(__dirname, '../../../..');
const DOC_PATH = safePath.resolve(REPO_ROOT, 'docs/validation-codes.md');

describe('docs/validation-codes.md', () => {
  const doc = readFileSync(DOC_PATH, 'utf-8');
  const docLower = doc.toLowerCase();

  for (const [code, entry] of Object.entries(CODE_REGISTRY)) {
    it(`documents ${code} at anchor ${entry.reference}`, () => {
      // Heading uses the code name in backticks so GitHub slugifies to the anchor
      expect(docLower).toContain(`## \`${code.toLowerCase()}\``);
      // The anchor slug (minus '#') appears in the doc (heading auto-generates it)
      const headingSlug = entry.reference.slice(1);
      expect(docLower).toContain(headingSlug);
    });
  }

  it('includes the severity model section', () => {
    expect(doc).toMatch(/## Severity Model/i);
  });

  it('includes the migration table', () => {
    expect(doc).toMatch(/ignoreValidationErrors/);
    expect(doc).toMatch(/validation\.severity/);
    expect(doc).toMatch(/validation\.accept/);
  });
});
