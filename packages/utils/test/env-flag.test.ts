import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseEnvBoolean } from '../src/env-flag.js';
import { resolveFromImportMeta } from '../src/fs.js';
import { safePath } from '../src/path.js';

describe('parseEnvBoolean', () => {
  it.each(['1', 'true', 'TRUE', 'True', 'yes', 'Yes', 'y', 'on', 'ON', ' true ', '\t1\n'])(
    '%j reads as true',
    (raw) => {
      expect(parseEnvBoolean(raw)).toBe(true);
    },
  );

  it.each(['0', 'false', 'FALSE', 'False', 'no', 'No', 'n', 'off', 'OFF', ' 0', '0 '])(
    '%j reads as false',
    (raw) => {
      expect(parseEnvBoolean(raw)).toBe(false);
    },
  );

  it.each([undefined, '', '   ', '2', '-1', 'maybe', 'null', 'undefined', 'truthy', 'onward'])(
    '%j is not a boolean, so it reads as undefined rather than guessing',
    (raw) => {
      expect(parseEnvBoolean(raw)).toBeUndefined();
    },
  );

  it('never returns a truthy non-boolean — callers branch on `=== undefined`', () => {
    for (const raw of ['1', '0', 'nonsense', undefined]) {
      const parsed = parseEnvBoolean(raw);
      expect(parsed === undefined || typeof parsed === 'boolean').toBe(true);
    }
  });
});

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => safePath.join(dir, entry));
}

/**
 * The caller table in `env-flag.ts`'s docblock is the record of which way each
 * call site reads `undefined` — the one decision this parser refuses to make. A
 * hand-kept table rots silently, so it is asserted BOTH ways against the source:
 * every file that calls `parseEnvBoolean(` has a row, and every row names a file
 * that still calls it.
 */
describe('parseEnvBoolean caller table', () => {
  const packagesDir = resolveFromImportMeta(import.meta.url, '..', '..');
  const TABLE_ROW = /^ \* \| `([^`]+)` \|/gmu;

  it('names every src file that calls parseEnvBoolean, and no other', () => {
    const callers = new Set<string>();
    for (const pkg of readdirSync(packagesDir)) {
      const srcDir = safePath.join(packagesDir, pkg, 'src');
      if (!existsSync(srcDir)) continue;
      for (const file of tsFilesUnder(srcDir)) {
        const relative = safePath.relative(srcDir, file);
        if (pkg === 'utils' && relative === 'env-flag.ts') continue;
        if (readFileSync(file, 'utf8').includes('parseEnvBoolean(')) {
          callers.add(`${pkg}/${relative}`);
        }
      }
    }
    const docblock = readFileSync(safePath.join(packagesDir, 'utils', 'src', 'env-flag.ts'), 'utf8');
    const rows = new Set([...docblock.matchAll(TABLE_ROW)].map((match) => match[1]));
    rows.delete('Caller');

    expect(callers.size).toBeGreaterThan(0);
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect([...rows].sort(byName)).toEqual([...callers].sort(byName));
  });
});
