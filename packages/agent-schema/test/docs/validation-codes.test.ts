import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CODE_REGISTRY } from '../../src/validation-codes.js';

const docsPath = fileURLToPath(new URL('../../../../docs/validation-codes.md', import.meta.url));
// Path is derived from `import.meta.url`, not user input — points at the
// repo's docs/validation-codes.md, the source of truth for code reference anchors.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const docs = readFileSync(docsPath, 'utf8');

describe('CODE_REGISTRY ↔ docs/validation-codes.md coverage', () => {
  for (const code of Object.keys(CODE_REGISTRY)) {
    it(`${code}: docs/validation-codes.md has the matching ### heading`, () => {
      expect(docs).toContain(`### \`${code}\``);
    });

    it(`${code}: entry.reference is the lowercased code anchor`, () => {
      const entry = CODE_REGISTRY[code as keyof typeof CODE_REGISTRY];
      expect(entry.reference).toBe(`#${code.toLowerCase()}`);
    });
  }
});
