import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

/**
 * Every code VAT emits must be documented in docs/validation-codes.md — not
 * only the overridable ones in CODE_REGISTRY.
 *
 * The registry ↔ doc tests beside this one hold the 95 overridable codes to
 * the doc. They cannot see a code that is emitted with a literal severity
 * from a lane with its own vocabulary (OKF conformance, the verify-time
 * consistency check, projection blob conditions, the QA-snapshot invariants):
 * such a code reaches an adopter's terminal with a reference to a doc that
 * never mentions it. This test closes that gap from the emit side: it
 * collects every `code: 'SCREAMING_CASE'` literal under `packages/＊/src` and
 * requires each to be a heading or a catalog-table row in the doc.
 *
 * Ratchet, both ways: a code listed in UNDOCUMENTED_EMITTED_CODES must still be
 * emitted (so a deletion removes its entry), and an emitted code outside the
 * list must be documented. The list may only shrink.
 *
 * ⚠️ The detector sees only the `code: '<LITERAL>'` property shape. A code
 * passed positionally to a helper (`createRegistryIssue('X', …)`,
 * `materializeIssue('X', …)`) is invisible to it; today every such code is a
 * registry code the sibling registry ↔ doc test covers, so nothing is missed.
 * A new positional helper that mints a NON-registry code would open a hole
 * here — add its call shape to the regex when you write one.
 */

const REPO_ROOT = safePath.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const DOC_PATH = safePath.join(REPO_ROOT, 'docs/validation-codes.md');
const PACKAGES_DIR = safePath.join(REPO_ROOT, 'packages');

/**
 * Emitted codes that the doc deliberately does not carry, each with the reason
 * and the condition under which its entry is removed.
 */
const UNDOCUMENTED_EMITTED_CODES: Record<string, string> = {
  // Empty today: every emitted code is documented. An entry here names a code
  // that is emitted but deliberately undocumented, with the reason and the
  // condition under which its entry is removed.
};

const CODE_LITERAL = /\bcode:\s*['"]([A-Z][A-Z0-9_]{4,})['"]/g;

function walkSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = safePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

function emittedCodes(): Map<string, string[]> {
  const files: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    // A linked package directory is not this repo's source; skip it as the walker does.
    if (pkg.isSymbolicLink() || !pkg.isDirectory()) continue;
    const src = safePath.join(PACKAGES_DIR, pkg.name, 'src');
    try {
      walkSourceFiles(src, files);
    } catch (error) {
      // A package without src/ (fixtures, manifests-only) has nothing to emit;
      // anything else — a refused directory — must not read as "no codes".
      if (!isPathAbsentError(error)) throw error;
    }
  }
  const sites = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(CODE_LITERAL)) {
      const code = match[1] ?? '';
      const list = sites.get(code) ?? [];
      list.push(safePath.relative(REPO_ROOT, file));
      sites.set(code, list);
    }
  }
  return sites;
}

/** Codes the doc documents: a `### \`CODE\`` heading, or the first cell of a table row. */
function documentedCodes(doc: string): Set<string> {
  const codes = new Set<string>();
  for (const match of doc.matchAll(/^### `([A-Z][A-Z0-9_]+)`/gm)) codes.add(match[1] ?? '');
  for (const match of doc.matchAll(/^\|\s*\[?`([A-Z][A-Z0-9_]+)`/gm)) codes.add(match[1] ?? '');
  return codes;
}

describe('every emitted code is documented in docs/validation-codes.md', () => {
  const emitted = emittedCodes();
  const documented = documentedCodes(readFileSync(DOC_PATH, 'utf8'));

  it('collects a non-empty emit set, so the assertions below cannot pass vacuously', () => {
    expect(emitted.size).toBeGreaterThan(50);
    expect(documented.size).toBeGreaterThan(50);
  });

  it('documents every emitted code that is not on the allowlist', () => {
    const missing = [...emitted.entries()]
      .filter(([code]) => !documented.has(code) && !(code in UNDOCUMENTED_EMITTED_CODES))
      .map(([code, files]) => `${code} (${[...new Set(files)].join(', ')})`)
      .sort((a, b) => a.localeCompare(b));
    expect(
      missing,
      'emitted but absent from docs/validation-codes.md — add a section or catalog row, or an allowlist entry with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlist honest: every listed code is still emitted and still undocumented', () => {
    const stale = Object.keys(UNDOCUMENTED_EMITTED_CODES).filter(
      (code) => !emitted.has(code) || documented.has(code),
    );
    expect(stale, 'no longer emitted, or now documented — remove from UNDOCUMENTED_EMITTED_CODES').toEqual([]);
  });
});
