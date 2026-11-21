/**
 * The declared regexes are public and unfrozen (a frozen regex runs on V8's
 * slow path), so any same-process holder can move a global regex's
 * `lastIndex` or `compile()` a pattern in place. The core must answer the same
 * either way, and must leave the public regexes as it found them.
 * `local/skill-text-core-purity` refuses a `lastIndex` reference in the core;
 * these prove no call there moves one, and that what a holder does to the
 * public objects never reaches the core's answer.
 */

import { type Dirent, readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import type { SkillTextFacts } from '../../src/schemas/skill-text-facts.js';
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

/** The corpus documents, path and text. */
function goldenDocuments(): Array<{ path: string; text: string }> {
  const files: Dirent[] = [];
  for (const entry of readdirSync(GOLDEN_DIR, { recursive: true, withFileTypes: true })) {
    // The corpus is tracked plain files: a link in it is a broken fixture, refused by name.
    if (entry.isSymbolicLink()) throw new Error(`golden corpus holds a link: ${entry.name}`);
    if (entry.isFile()) files.push(entry);
  }
  expect(files.length).toBeGreaterThan(50);
  return files.map((file) => {
    const path = safePath.join(file.parentPath, file.name);
    return { path, text: readFileSync(path, 'utf8') };
  });
}

const REGEXES = declaredRegexes(SKILL_TEXT_DECLARATION);
const ORIGINALS = REGEXES.map((regex) => ({ regex, source: regex.source, flags: regex.flags }));

/** Put every public regex back as declared, whatever a test did to it. */
function restorePublicRegexes(): void {
  for (const { regex, source, flags } of ORIGINALS) {
    // eslint-disable-next-line sonarjs/deprecation -- restoring a regex a test compile()d in place
    if (regex.source !== source || regex.flags !== flags) regex.compile(source, flags);
    regex.lastIndex = 0;
  }
}

/** The core's answer for every corpus document, taken before any test touches a public regex. */
const DOCUMENTS = goldenDocuments();
const BASELINE = new Map<string, SkillTextFacts>(
  DOCUMENTS.map(({ path, text }) => [path, skillTextFactsOf(text, SKILL_TEXT_DECLARATION)]),
);

/** The documents whose facts differ from the baseline after `before(text)` runs ahead of each scan. */
function changedDocuments(before: (text: string) => void): string[] {
  const changed: string[] = [];
  for (const { path, text } of DOCUMENTS) {
    before(text);
    if (JSON.stringify(skillTextFactsOf(text, SKILL_TEXT_DECLARATION)) !== JSON.stringify(BASELINE.get(path))) changed.push(path);
  }
  return changed;
}

describe('the declared regexes after a scan', () => {
  afterEach(restorePublicRegexes);

  // Checked after EVERY document: a global `exec` that finds nothing resets `lastIndex` to 0, so a
  // check at the end alone passes whenever the last document happens to miss.
  it('all have lastIndex 0 after the core scans each golden corpus document', () => {
    expect(REGEXES.some((regex) => regex.global)).toBe(true);
    let matches = 0;
    const moved: string[] = [];
    for (const { path, text } of DOCUMENTS) {
      matches += skillTextFactsOf(text, SKILL_TEXT_DECLARATION).matches.length;
      for (const regex of REGEXES) if (regex.lastIndex !== 0) moved.push(`${String(regex)} after ${path}`);
    }
    expect(matches).toBeGreaterThan(20);
    expect(moved).toEqual([]);
  });
});

describe('a holder of the public declaration', () => {
  afterEach(restorePublicRegexes);

  it('cannot change the core answer by moving lastIndex on a declared global or sticky regex', () => {
    const stateful = REGEXES.filter((regex) => regex.global || regex.sticky);
    expect(stateful.length).toBeGreaterThanOrEqual(5);
    // Past the end of the document: a scan that copies it from the public regex finds nothing.
    const changed = changedDocuments((text) => {
      for (const regex of stateful) regex.lastIndex = text.length;
    });
    expect(changed).toEqual([]);
  });

  it('cannot change the core answer by compile()-ing a declared regex in place', () => {
    for (const regex of REGEXES) {
      // A pattern that never matches, with the declared flags: every match it held is gone.
      // eslint-disable-next-line sonarjs/deprecation -- the in-place mutation under test
      regex.compile(String.raw`(?!)`, regex.flags);
    }
    expect(REGEXES.every((regex) => regex.source === String.raw`(?!)`)).toBe(true);
    expect(changedDocuments(() => undefined)).toEqual([]);
  });
});
