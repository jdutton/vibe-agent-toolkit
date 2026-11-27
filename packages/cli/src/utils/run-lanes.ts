/**
 * Where each verb's run reads a tracked file's bytes: the one table, so the choice is made once
 * per verb here and never as a literal at the code that opens the run.
 *
 * `'git'` for a cached validation lane: a run holding a store keys each member of the snapshot that
 * keys it by its object name and reads its bytes from git. `'disk'` for a build lane and for
 * `vat rag index`: every file is read from the working tree and keyed by its checksum, so what a
 * build ships, the link spans it rewrites, and the text an index embeds are the bytes on disk.
 * `vat audit` runs with no store, so it keys from disk either way; it is listed so that every verb
 * that opens a run names its lane here.
 *
 * `vat build` opens no run of its own for its skills lane: it runs `vat skills build`'s
 * (`'skills build'`).
 */

/** Where a run reads a tracked file's bytes. */
export type RunMemberBytes = 'git' | 'disk';

/** Every verb that opens a run, and where that run reads a tracked file's bytes. */
export const RUN_MEMBER_BYTES = {
  validate: 'git',
  verify: 'git',
  'resources validate': 'git',
  'resources scan': 'git',
  'resources query': 'git',
  'resources check': 'git',
  'skills validate': 'git',
  'skill review': 'git',
  'claude context': 'git',
  inventory: 'git',
  'skills build': 'disk',
  'skills package': 'disk',
  'claude plugin build': 'disk',
  'skill test run': 'disk',
  'rag index': 'disk',
  audit: 'disk',
} as const satisfies Readonly<Record<string, RunMemberBytes>>;

/** A verb that opens a run. */
export type RunVerb = keyof typeof RUN_MEMBER_BYTES;
