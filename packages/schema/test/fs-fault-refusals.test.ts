/**
 * The side × class → refusal table: total, made of registered refusal codes, exactly the grid the
 * owner approved, and equal to the grid `docs/validation-codes.md` publishes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FS_FAULT_REFUSALS, fsFaultRefusal, type FsFaultRefusalRow } from '../src/fs-fault-refusals.js';
import { CODE_REGISTRY } from '../src/validation-codes.js';

const CLASSES = ['absent', 'refused', 'wrong-type', 'occupied', 'unsupported', 'device', 'exhausted', 'busy'] as const;
const ORIGINS = ['argument', 'config', 'content'] as const;

/** One grid line per row of the table: the side (and the origin, for a source) and a refusal per class, in CLASSES order. */
type Grid = Record<string, readonly string[]>;

const READ_FAULT = ['INPUT_UNREADABLE', 'INPUT_UNREADABLE', 'INPUT_UNREADABLE', 'INPUT_UNREADABLE', 'INPUT_UNREADABLE'];
const MACHINE_FAULT = ['RUN_INCOMPLETE', 'RUN_INCOMPLETE'];

/**
 * The approved grid (plan Design, plus the owner's rulings): an absent source depends on who named
 * it; a machine fault (exhausted, busy) is never the input's; every destination fault stops the run.
 * A destination the user named that is already occupied is refused by the preflight upstream
 * (`TREE_DEST_OCCUPIED` → `USAGE_INVALID`), never by this table: an errno does not say what the user meant.
 */
const APPROVED: Grid = {
  'source, origin `argument`': ['USAGE_INVALID', ...READ_FAULT, ...MACHINE_FAULT],
  'source, origin `config`': ['CONFIG_INVALID', ...READ_FAULT, ...MACHINE_FAULT],
  'source, origin `content`': ['INPUT_UNREADABLE', ...READ_FAULT, ...MACHINE_FAULT],
  destination: ['RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE'],
  environment: ['RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE'],
};

const codesOf = (rows: Readonly<Record<string, FsFaultRefusalRow>>): string[] => CLASSES.map((c) => rows[c]?.refusal ?? '<missing>');

function schemaGrid(): Grid {
  return {
    ...Object.fromEntries(ORIGINS.map((origin) => [`source, origin \`${origin}\``, codesOf(FS_FAULT_REFUSALS.source[origin])])),
    destination: codesOf(FS_FAULT_REFUSALS.destination),
    environment: codesOf(FS_FAULT_REFUSALS.environment),
  };
}

const everyRow = (): Array<[string, FsFaultRefusalRow]> => [
  ...ORIGINS.flatMap((origin) => Object.entries(FS_FAULT_REFUSALS.source[origin]).map(([c, row]): [string, FsFaultRefusalRow] => [`source/${origin}/${c}`, row])),
  ...Object.entries(FS_FAULT_REFUSALS.destination).map(([c, row]): [string, FsFaultRefusalRow] => [`destination/${c}`, row]),
  ...Object.entries(FS_FAULT_REFUSALS.environment).map(([c, row]): [string, FsFaultRefusalRow] => [`environment/${c}`, row]),
];

const docsPath = fileURLToPath(new URL('../../../docs/validation-codes.md', import.meta.url));
const MARKER = '<!-- fs-fault-refusals -->';

/** The markdown grid under the marker: its header names the classes, each body line a side. */
function docsGrid(): Grid {
  const docs = readFileSync(docsPath, 'utf8');
  const start = docs.indexOf(MARKER);
  if (start === -1) throw new Error(`docs/validation-codes.md has no ${MARKER} marker`);
  const lines = docs.slice(start + MARKER.length).trimStart().split('\n');
  const table = lines.slice(0, lines.findIndex((line) => !line.startsWith('|')));
  const cells = (line: string): string[] => line.slice(1, -1).split('|').map((cell) => cell.trim());
  const [header, , ...body] = table;
  if (header === undefined) throw new Error(`no table under ${MARKER}`);
  const order = cells(header).slice(1);
  return Object.fromEntries(body.map((line) => {
    const [side = '', ...codes] = cells(line);
    const byClass = new Map(order.map((c, i) => [c, (codes[i] ?? '').replaceAll('`', '')]));
    return [side, CLASSES.map((c) => byClass.get(c) ?? '<missing>')];
  }));
}

describe('FS_FAULT_REFUSALS', () => {
  it('is total: every side (and every origin of a source) has a row for every class, and nothing else', () => {
    expect(new Set(Object.keys(FS_FAULT_REFUSALS))).toEqual(new Set(['destination', 'environment', 'source']));
    expect(new Set(Object.keys(FS_FAULT_REFUSALS.source))).toEqual(new Set(ORIGINS));
    for (const rows of [...ORIGINS.map((o) => FS_FAULT_REFUSALS.source[o]), FS_FAULT_REFUSALS.destination, FS_FAULT_REFUSALS.environment]) {
      expect(new Set(Object.keys(rows))).toEqual(new Set(CLASSES));
    }
  });

  it('is exactly the approved grid', () => {
    expect(schemaGrid()).toEqual(APPROVED);
  });

  it.each(everyRow())('%s: a registered refusal code, with a cause and a remedy', (_key, row) => {
    expect(CODE_REGISTRY[row.refusal].kind).toBe('refusal');
    for (const sentence of [row.cause, row.remedy]) {
      expect(sentence.length).toBeGreaterThan(1);
      expect(sentence.endsWith('.')).toBe(true);
    }
  });

  it('docs/validation-codes.md publishes the same grid under its marker', () => {
    expect(docsGrid()).toEqual(schemaGrid());
  });
});

describe('fsFaultRefusal', () => {
  it('reads a source fault by its origin', () => {
    expect(fsFaultRefusal('source', 'absent', 'argument').refusal).toBe('USAGE_INVALID');
    expect(fsFaultRefusal('source', 'absent', 'config').refusal).toBe('CONFIG_INVALID');
    expect(fsFaultRefusal('source', 'absent', 'content').refusal).toBe('INPUT_UNREADABLE');
  });

  it('ignores the origin on the other sides', () => {
    for (const origin of ORIGINS) {
      expect(fsFaultRefusal('destination', 'occupied', origin)).toBe(FS_FAULT_REFUSALS.destination.occupied);
      expect(fsFaultRefusal('environment', 'refused', origin)).toBe(FS_FAULT_REFUSALS.environment.refused);
    }
  });

  it('a machine fault while READING is the run stopping, not the input', () => {
    expect(fsFaultRefusal('source', 'exhausted', 'argument').refusal).toBe('RUN_INCOMPLETE');
  });
});
