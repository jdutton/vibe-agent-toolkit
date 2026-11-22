/**
 * Every work counter the docs and the unreleased changelog fragments name exists in the register
 * (`WORK_COUNTER_NAMES`). A counter renamed or removed in code leaves its old name in prose, which
 * no other check reads; this one does.
 *
 * A mention is a backticked dotted name whose first segment is a register family (`store`, `fs`,
 * `parse`, ...): `` `store.reads.blob` ``. Two families share their first segment with an API the
 * docs also name, so a name whose second segment is a member of that API is code, not a counter:
 * `fs.readdir` (`node:fs`), `statement.columns` (`node:sqlite`'s `StatementSync`); the members are
 * read from the modules, never listed here. A counter whose name is also such a member (`fs.stat`)
 * is checked by the register alone. `CHANGELOG.md` is history and `docs/external/` is vendor text:
 * neither is read.
 */

import * as nodeFs from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import { StatementSync } from 'node:sqlite';

import { safePath, WORK_COUNTER_NAMES } from '@vibe-agent-toolkit/utils';
import { toForwardSlash } from '@vibe-agent-toolkit/utils/path';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';

const REGISTER: ReadonlySet<string> = new Set(WORK_COUNTER_NAMES);
const FAMILIES: ReadonlySet<string> = new Set(WORK_COUNTER_NAMES.map((name) => name.split('.')[0] ?? name));
/** A backticked run of letters and dots; {@link isDottedName} keeps the dotted names among them. */
const MENTION = /`([A-Za-z.]+)`/g;
/** Per family that shares its first segment with an API, that API's members. */
const API_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['fs', new Set(Object.keys(nodeFs))],
  ['statement', new Set(Object.getOwnPropertyNames(StatementSync.prototype))],
]);

/**
 * @param text - A backticked run of letters and dots
 * @returns Whether it is two or more non-empty segments
 */
function isDottedName(text: string): boolean {
  const segments = text.split('.');
  return segments.length > 1 && segments.every((segment) => segment !== '');
}

/**
 * @param name - A backticked dotted name
 * @returns Whether it names a member of the API its first segment shares
 */
function isApiMember(name: string): boolean {
  const [family = '', member = ''] = name.split('.');
  return API_MEMBERS.get(family)?.has(member) ?? false;
}

/**
 * @param directory - A repo-relative directory
 * @returns Every markdown file under it, repo-relative
 */
function markdownUnder(directory: string): string[] {
  return readdirSync(safePath.join(PROJECT_ROOT, directory), { recursive: true, encoding: 'utf-8' })
    .filter((name) => name.endsWith('.md'))
    .map((name) => safePath.join(directory, name));
}

/**
 * @param text - Markdown
 * @returns The counter-family names it mentions that the register does not hold
 */
export function unregisteredCounterMentions(text: string): string[] {
  return [...text.matchAll(MENTION)]
    .map((match) => match[1] ?? '')
    .filter((name) => isDottedName(name))
    .filter((name) => FAMILIES.has(name.split('.')[0] ?? '') && !REGISTER.has(name) && !isApiMember(name));
}

describe('work counter names in docs/ and .changes/', () => {
  it('flags a counter the register does not hold, and passes one it does', () => {
    expect(unregisteredCounterMentions('counts one `store.reads.persistent` and `store.reads.blob`')).toEqual(['store.reads.persistent']);
    expect(unregisteredCounterMentions('`fs.readdirSync` and `statement.columns` are code; `fs.lstats` is not')).toEqual(['fs.lstats']);
  });

  it('names only counters the register holds', () => {
    const files = [...markdownUnder('docs').filter((file) => !toForwardSlash(file).startsWith('docs/external/')), ...markdownUnder('.changes')];
    const stale = files.flatMap((file) =>
      unregisteredCounterMentions(readFileSync(safePath.join(PROJECT_ROOT, file), 'utf-8')).map((name) => `${file}: ${name}`),
    );
    expect(stale).toEqual([]);
  });
});
