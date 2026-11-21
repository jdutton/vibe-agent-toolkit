/**
 * The declared regexes are shared and unfrozen (a frozen regex runs on V8's
 * slow path), so the core must leave each one as it found it: a `lastIndex`
 * left non-zero on a global regex makes the next `matchAll` over it start
 * mid-text and drop matches. `local/skill-text-core-purity` refuses a
 * `lastIndex` reference in the core; this proves no call there moves one
 * either (an `exec` or `test` on a global regex would).
 */

import { type Dirent, readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { skillTextFactsOf } from '../../src/skill-text/core.js';
import { SKILL_TEXT_DECLARATION } from '../../src/skill-text/declaration.js';

/** The skills-phase golden corpus: every skill-text family has a document here. */
const GOLDEN_DIR = safePath.resolve(import.meta.dirname, '../../../agent-skills/test/fixtures/skill-text-golden');

/** Every regex reachable from the declaration. */
function declaredRegexes(value: unknown, found: RegExp[] = []): RegExp[] {
  if (value instanceof RegExp) found.push(value);
  else if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) declaredRegexes(child, found);
  return found;
}

describe('the declared regexes after a scan', () => {
  // Checked after EVERY document: a global `exec` that finds nothing resets `lastIndex` to 0, so a
  // check at the end alone passes whenever the last document happens to miss.
  it('all have lastIndex 0 after the core scans each golden corpus document', () => {
    const files: Dirent[] = [];
    for (const entry of readdirSync(GOLDEN_DIR, { recursive: true, withFileTypes: true })) {
      // The corpus is tracked plain files: a link in it is a broken fixture, refused by name.
      if (entry.isSymbolicLink()) throw new Error(`golden corpus holds a link: ${entry.name}`);
      if (entry.isFile()) files.push(entry);
    }
    expect(files.length).toBeGreaterThan(50);
    const regexes = declaredRegexes(SKILL_TEXT_DECLARATION);
    expect(regexes.some((regex) => regex.global)).toBe(true);
    let matches = 0;
    const moved: string[] = [];
    for (const file of files) {
      const path = safePath.join(file.parentPath, file.name);
      matches += skillTextFactsOf(readFileSync(path, 'utf8'), SKILL_TEXT_DECLARATION).matches.length;
      for (const regex of regexes) if (regex.lastIndex !== 0) moved.push(`${String(regex)} after ${path}`);
    }
    expect(matches).toBeGreaterThan(20);
    expect(moved).toEqual([]);
  });
});
