/**
 * Fixture-tree helpers every fault-matrix case family writes its inputs and prior state with.
 *
 * Test code: raw `fs` is fine here.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

import { skillMdBytes } from '../../helpers/zip-fixtures.js';

/** One file of a fixture tree: its path relative to the tree root, and its text. */
export type TreeFile = readonly [path: string, body: string];

/** A SKILL.md named `name` whose body says `body` (a version, so two builds differ). */
export const skillMd = (name: string, body = 'new'): string => skillMdBytes(name, `\n# ${name}\n\n${body}\n`).toString('utf8');

/** Write each file under `dir`, making its parents. */
export function writeTree(dir: string, files: readonly TreeFile[]): void {
  for (const [path, body] of files) {
    const target = safePath.join(dir, path);
    mkdirSyncReal(safePath.join(target, '..'), { recursive: true });
    writeFileSync(target, body);
  }
}

/** The same files, one directory deeper. */
export const prefixed = (prefix: string, files: readonly TreeFile[]): TreeFile[] => files.map(([path, body]) => [`${prefix}/${path}`, body]);
