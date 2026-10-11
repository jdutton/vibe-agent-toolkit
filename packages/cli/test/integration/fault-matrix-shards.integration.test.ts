/**
 * The fault-matrix shard tables and the matrix files agree: every slice of every case has its
 * file, and no file runs a slice a table no longer has. A shard without a file is
 * injections that silently never run.
 */
import { readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import { shardFileName, type MatrixShard } from '../fault-matrix/matrix.js';

const here = import.meta.dirname;
const TABLES: Readonly<Record<string, Readonly<Record<string, MatrixShard>>>> = { INSTALL_FAMILY_SHARDS, BUILD_FAMILY_SHARDS };
const expected = Object.entries(TABLES).flatMap(([table, shards]) => Object.entries(shards).flatMap(([name, shard]) =>
  Array.from({ length: shard.files }, (_, index) => ({ table, name, index, file: shardFileName(name, index, shard.files) }))));

describe('fault-matrix shards', () => {
  it.each(expected)('$file runs slice $index of $table $name', ({ table, name, index, file }) => {
    // The whole line, so a comment quoting another slice's call cannot stand in for the statement.
    expect(readFileSync(safePath.join(here, file), 'utf8').split('\n')).toContain(`const tests = await planMatrixShard(${table}['${name}'], ${index});`);
  });

  it('no two cases share a shard file name', () => {
    const files = expected.map(({ file }) => file);
    expect(files.filter((file, index) => files.indexOf(file) !== index)).toEqual([]);
  });

  it('no shard file is left over from a table entry that is gone', () => {
    const wanted = new Set(expected.map(({ file }) => file));
    const onDisk = readdirSync(here).filter((file) => /^fault-matrix-.+-\d+of\d+\.integration\.test\.ts$/.test(file));
    expect(onDisk.filter((file) => !wanted.has(file))).toEqual([]);
  });
});
