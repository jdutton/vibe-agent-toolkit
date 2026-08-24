/**
 * Unit tests for `checkCommandModules` — doctor's broken-install detector.
 *
 * This check exists because the CLI loads only the command named on the command
 * line: a `dist/` missing one module no longer fails at startup, so `vat rag`
 * dies with a raw `ERR_MODULE_NOT_FOUND` while every other doctor check (which
 * only compares version strings) still reports health. The check is therefore
 * the ONLY thing standing between a corrupt install and a green `vat doctor`,
 * and it can flip the exit code to 1 — so it gets its own tests.
 *
 * The loader table is mocked. Driving the real fourteen loaders would import the
 * whole CLI surface (the cost lazy loading was added to avoid), turning this
 * into an integration test, and could not produce a controlled failure anyway.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  assertCheck,
  assertCheckPassed,
} from '../helpers/vat-doctor-test-helpers.js';

/** A loader as the table stores it: called for its side effect of importing. */
type StubLoader = () => Promise<unknown>;

// Mutated per test rather than re-mocked: `checkCommandModules` reads
// `Object.entries(COMMAND_LOADERS)` on every call, so the live object is enough.
const { loaderTable } = vi.hoisted(() => ({
  loaderTable: {} as Record<string, () => Promise<unknown>>,
}));

vi.mock('../../src/command-loaders.js', () => ({
  COMMAND_LOADERS: loaderTable,
}));

const { checkCommandModules } = await import('../../src/commands/doctor.js');

const CHECK_COMMAND_MODULES = 'Command modules';
const RAG_MODULE = './rag/index.js';

/** Replace the whole table. `Reflect.deleteProperty` keeps the keys non-dynamic. */
function setLoaders(loaders: Record<string, StubLoader>): void {
  for (const key of Object.keys(loaderTable)) Reflect.deleteProperty(loaderTable, key);
  Object.assign(loaderTable, loaders);
}

const loads: StubLoader = async () => ({});

const rejectsWith =
  (error: unknown): StubLoader =>
  async () => {
    throw error;
  };

/** An `ERR_MODULE_NOT_FOUND` shaped like the one a half-extracted tarball produces. */
function moduleNotFound(specifier: string): Error {
  return Object.assign(
    new Error(`Cannot find module '${specifier}' imported from /opt/vat/dist/bin.js`),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );
}

/**
 * Everything the message says AFTER `<name>:` in the "First failure" clause.
 *
 * This is the assertion that survives rewording: whatever the sentence looks
 * like, a failure reported with its reason discarded renders as a dangling
 * `rag:` with nothing after it (or no `rag:` at all), and both are caught here.
 */
function reasonReportedFor(message: string, name: string): string {
  const marker = `${name}:`;
  const at = message.indexOf(marker);
  expect(at, `message never names "${marker}": ${message}`).toBeGreaterThanOrEqual(0);
  return message.slice(at + marker.length).trim();
}

describe('checkCommandModules', () => {
  it('passes and states the count when every module loads', async () => {
    setLoaders({ audit: loads, rag: loads, build: loads });

    const result = await checkCommandModules();

    assertCheckPassed(result, CHECK_COMMAND_MODULES, '3');
  });

  it('fails naming the broken command AND why it is broken', async () => {
    setLoaders({
      audit: loads,
      rag: rejectsWith(moduleNotFound(RAG_MODULE)),
      build: loads,
    });

    const result = await checkCommandModules();

    assertCheck(result, CHECK_COMMAND_MODULES, {
      outcome: 'fail',
      // The name answers "which command is broken"; the code and the specifier
      // answer "which file is missing" — the one fact the raw crash gave, and
      // the reason this check reports more than a list of names.
      messageContains: ['rag', 'ERR_MODULE_NOT_FOUND', 'Cannot find module', RAG_MODULE],
      suggestionContains: 'Reinstall',
    });
    expect(result.message).not.toContain('further failure');
  });

  it('lists every broken command but surfaces only the first reason', async () => {
    setLoaders({
      audit: rejectsWith(moduleNotFound('./audit.js')),
      rag: rejectsWith(moduleNotFound(RAG_MODULE)),
      build: loads,
      verify: rejectsWith(moduleNotFound('./verify.js')),
    });

    const result = await checkCommandModules();

    assertCheck(result, CHECK_COMMAND_MODULES, {
      outcome: 'fail',
      messageContains: ['audit', 'rag', 'verify', './audit.js', '2 further failures not shown'],
      suggestionContains: 'Reinstall',
    });
    // The later reasons are deliberately withheld — a half-extracted tree makes
    // every command fail, and fourteen near-identical messages bury the useful one.
    expect(result.message).not.toContain('./verify.js');
  });

  it('reports a reason for a loader that throws a non-Error', async () => {
    setLoaders({ skill: rejectsWith('dist/commands/skill is empty') });

    const result = await checkCommandModules();

    expect(result.outcome).toBe('fail');
    expect(result.message).toContain('dist/commands/skill is empty');
    expect(reasonReportedFor(result.message, 'skill')).not.toBe('');
  });

  it('reports a reason for a loader that throws an Error with no message', async () => {
    setLoaders({ cache: rejectsWith(new Error('')) });

    const result = await checkCommandModules();

    expect(result.outcome).toBe('fail');
    // Without the fallback this renders as "First failure — cache:" and reads
    // like the reporting itself is broken.
    expect(reasonReportedFor(result.message, 'cache')).not.toBe('');
    expect(result.message).toContain('no message');
  });
});
