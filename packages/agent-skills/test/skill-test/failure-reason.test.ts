/**
 * `skillTestFailureReason` reads WHY a `vat skill test run` ended on `ERROR`
 * from the thrown error's own `reason` field — the answer that used to be three
 * exit codes (1 internal, 2 preflight, 3 bootstrap). Every VAT error class in
 * the feature declares one; a foreign error declares nothing and is the
 * harness's own fault, `internal`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyFsFault, isVatError, safePath } from '@vibe-agent-toolkit/utils';
import { AuthPreflightError } from '@vibe-agent-toolkit/utils/skill-test';
import { describe, expect, it } from 'vitest';

import { FETCH_CACHE_NOT_OWNED_CODE } from '../../src/skill-source/fetch-cache.js';
import { SkillSourceUnreadableError } from '../../src/skill-source/stage.js';
import { BuildHookError } from '../../src/skill-test/build-hook.js';
import { UnknownEnvTokenError, UnresolvableEnvTokenError } from '../../src/skill-test/declared-env.js';
import { EvalFragmentError } from '../../src/skill-test/eval-fragment.js';
import { EvalInputError } from '../../src/skill-test/eval-inputs.js';
import {
  BootstrapNeededError,
  DuplicateStagedSkillError,
  EvalsReferenceUnresolvedError,
  InternalHarnessError,
  SecurityAckError,
  SKILL_TEST_REFUSAL_BY_ERROR_CODE,
  SkillBuildError,
  skillTestFailureReason,
} from '../../src/skill-test/failure-reason.js';
import { GradingNonceError, GradingSkewError } from '../../src/skill-test/grading-adapter.js';
import { HarnessLocationError } from '../../src/skill-test/harness-location.js';
import { HarnessLockBusyError } from '../../src/skill-test/lock.js';
import { PromptInvariantError } from '../../src/skill-test/prompt-invariants.js';

describe('skillTestFailureReason', () => {
  /**
   * Every row is a live pin on the class's own `reason` field: delete the field
   * and the row falls through to `internal`.
   */
  it.each([
    ['BootstrapNeededError', new BootstrapNeededError('/p/evals/evals.json'), 'bootstrap'],
    ['AuthPreflightError', new AuthPreflightError('x'), 'preflight'],
    ['HarnessLocationError', new HarnessLocationError('x'), 'preflight'],
    // A filesystem refusal is the operator's environment, whichever side refused: classified, not a class of its own.
    ['FsFaultError (a harness root the OS will not let the run write)', classifyFsFault(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }), { side: 'destination', action: 'create the harness root' }), 'preflight'],
    ['FsFaultError (a --with source the OS will not read)', classifyFsFault(Object.assign(new Error('EACCES'), { code: 'EACCES' }), { side: 'source', action: 'read the skill source' }), 'preflight'],
    ['PromptInvariantError (a VAT-built prompt lost a safety directive)', new PromptInvariantError('x'), 'preflight'],
    ['SkillBuildError', new SkillBuildError('build blew up'), 'preflight'],
    ['SecurityAckError (missing ack before a build)', new SecurityAckError(), 'preflight'],
    ['DuplicateStagedSkillError (a staged name collides)', new DuplicateStagedSkillError('helper'), 'preflight'],
    ['HarnessLockBusyError (harness root held by another run)', new HarnessLockBusyError('/t/.lock'), 'preflight'],
    ['BuildHookError (the repo\'s own pre-stage build command failed)', new BuildHookError('hook failed', 1), 'preflight'],
    ['UnknownEnvTokenError (bad ${token} in a declared env value)', new UnknownEnvTokenError('nope', 'API_URL'), 'preflight'],
    ['EvalInputError (on EVERY route, not just the staging handler)', new EvalInputError('bad suite'), 'preflight'],
    ['GradingSkewError (parse failure surfaced, never success)', new GradingSkewError('x'), 'internal'],
    ['EvalFragmentError (per-eval fragment shape skew)', new EvalFragmentError('x'), 'internal'],
    ['GradingNonceError (forged/mismatched per-fragment grader nonce)', new GradingNonceError('nonce mismatch'), 'internal'],
    ['InternalHarnessError', new InternalHarnessError('x'), 'internal'],
  ] as const)('%s → %s', (_label, err, expected) => {
    expect(skillTestFailureReason(err)).toBe(expected);
    expect(isVatError(err)).toBe(true);
  });

  it('a foreign error is the harness\'s own fault: internal', () => {
    expect(skillTestFailureReason(new Error('boom'))).toBe('internal');
    expect(skillTestFailureReason('boom')).toBe('internal');
    expect(skillTestFailureReason({ reason: 'bootstrap' })).toBe('internal');
  });

  /**
   * The residual the old `exitCode` read left open, now closed: a FOREIGN error
   * carrying a plausible value is not opting in to anything. `commander`'s
   * `CommanderError` carries `exitCode: 2` and, under `exitOverride()`, exists
   * in-process; under the old read it reported "your environment is wrong" for
   * a crash. Only the VAT brand is consulted.
   */
  it.each(['preflight', 'bootstrap', 'internal'])(
    'ignores a foreign Error carrying reason %s — no VAT brand, no opt-in',
    (reason) => {
      expect(skillTestFailureReason(Object.assign(new Error('execa-shaped'), { reason }))).toBe('internal');
    },
  );

  it('ignores a VAT error whose reason is not one of the three', () => {
    const err = Object.assign(new InternalHarnessError('x'), { reason: 'sideways' });
    expect(skillTestFailureReason(err)).toBe('internal');
  });

  /**
   * Reading a property is not a total operation. Both call sites in
   * `packages/cli/src/commands/skill/test/run.ts` are inside `catch` blocks, so a
   * throw from the read escapes the handler entirely: no summary line, no chosen exit
   * code, a bare stack.
   */
  it('a throwing reason getter maps to internal instead of escaping the handler', () => {
    const err = new InternalHarnessError('getter');
    Object.defineProperty(err, 'reason', {
      get() { throw new Error('BOOM from getter'); },
    });
    expect(() => skillTestFailureReason(err)).not.toThrow();
    expect(skillTestFailureReason(err)).toBe('internal');
  });

  it('a Proxy that throws on get maps to internal instead of escaping the handler', () => {
    const err = new Proxy(new InternalHarnessError('proxy'), {
      get(target, key, receiver): unknown {
        if (key === 'reason') throw new Error('BOOM from proxy');
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(() => skillTestFailureReason(err)).not.toThrow();
    expect(skillTestFailureReason(err)).toBe('internal');
  });
});

/**
 * Every class under `src/skill-test/` (and `AuthPreflightError`, in utils) that
 * declares an operator-fixable `reason`, read from the SOURCE — so a new
 * preflight/bootstrap class that is missing from the map below reds this file,
 * rather than publishing as `INTERNAL_ERROR`. Constructing each class from its
 * barrel would need a fixture per constructor signature; the declaration is the
 * one shape they all share.
 */
function declaredOperatorFixableClasses(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs = [safePath.resolve(here, '../../src/skill-test'), safePath.resolve(here, '../../src/skill-source'), safePath.resolve(here, '../../../utils/src/skill-test')];
  const declaration = /export class (\w+) extends VatError \{\s*readonly reason = '(?:preflight|bootstrap)' as const;/g;
  return dirs
    .flatMap((dir) => readdirSync(dir).filter((file) => file.endsWith('.ts')).map((file) => readFileSync(safePath.join(dir, file), 'utf-8')))
    .flatMap((source) => [...source.matchAll(declaration)].map((match) => match[1] ?? ''))
    .toSorted((a, b) => a.localeCompare(b));
}

/**
 * Every error that says the harness could not run for a reason the operator can
 * fix names WHICH refusal it is, by its code — decided here, beside the classes,
 * and read by the CLI's one refusal lookup. A preflight or bootstrap error
 * missing from the map would publish as `INTERNAL_ERROR`, a VAT bug report for
 * the operator's own mistake.
 */
describe('SKILL_TEST_REFUSAL_BY_ERROR_CODE', () => {
  const ROWS = [
    ['BootstrapNeededError (no evals.json: the input is absent)', new BootstrapNeededError('/p/evals/evals.json'), 'INPUT_UNREADABLE'],
    ['EvalInputError (a suite or declared input that is not usable)', new EvalInputError('bad suite'), 'INPUT_UNREADABLE'],
    ['SkillSourceUnreadableError (a --with companion holding a symlink staging refuses)', new SkillSourceUnreadableError('x'), 'INPUT_UNREADABLE'],
    ['AuthPreflightError', new AuthPreflightError('x'), 'USAGE_INVALID'],
    ['HarnessLocationError', new HarnessLocationError('x'), 'USAGE_INVALID'],
    ['PromptInvariantError', new PromptInvariantError('x'), 'USAGE_INVALID'],
    ['SkillBuildError', new SkillBuildError('x'), 'USAGE_INVALID'],
    ['SecurityAckError', new SecurityAckError(), 'USAGE_INVALID'],
    ['DuplicateStagedSkillError', new DuplicateStagedSkillError('helper'), 'USAGE_INVALID'],
    ['EvalsReferenceUnresolvedError (a test.evals in the config that names nothing)', new EvalsReferenceUnresolvedError('x'), 'CONFIG_INVALID'],
    ['HarnessLockBusyError', new HarnessLockBusyError('/t/.lock'), 'USAGE_INVALID'],
    ['BuildHookError', new BuildHookError('hook failed', 1), 'USAGE_INVALID'],
    ['UnknownEnvTokenError', new UnknownEnvTokenError('nope', 'API_URL'), 'USAGE_INVALID'],
    ['UnresolvableEnvTokenError', new UnresolvableEnvTokenError('fixturesDir', 'API_URL'), 'USAGE_INVALID'],
  ] as const;

  it.each(ROWS)('%s → %s', (_label, err, expected) => {
    expect(skillTestFailureReason(err)).not.toBe('internal');
    expect(SKILL_TEST_REFUSAL_BY_ERROR_CODE[err.code as keyof typeof SKILL_TEST_REFUSAL_BY_ERROR_CODE]).toBe(expected);
  });

  it('covers every class that declares an operator-fixable reason, and no other', () => {
    const covered = ROWS.map(([, err]) => err.constructor.name).toSorted((a, b) => a.localeCompare(b));
    const declared = declaredOperatorFixableClasses();
    expect(declared.length).toBeGreaterThan(0);
    expect(covered).toStrictEqual(declared);
  });

  // The wrap keeps what it wrapped: the CLI publishes a coded cause's own refusal,
  // and a skill-content refusal as a finding at the skill's source.
  it('SkillBuildError keeps the cause it wraps and the skill source it names', () => {
    const cause = new TypeError('boom');
    const err = new SkillBuildError('Skill build failed for x: boom', { cause, sourcePath: '/p/skills/x/SKILL.md' });
    expect(err.cause).toBe(cause);
    expect(err.sourcePath).toBe('/p/skills/x/SKILL.md');
    expect(new SkillBuildError('no dist').sourcePath).toBeUndefined();
  });

  // A url source's fetch cache another user owns is VAT's own scratch it will not use: the run did not finish.
  it('maps FETCH_CACHE_NOT_OWNED to RUN_INCOMPLETE', () => {
    expect(SKILL_TEST_REFUSAL_BY_ERROR_CODE[FETCH_CACHE_NOT_OWNED_CODE]).toBe('RUN_INCOMPLETE');
  });

  it('maps no internal-reason error: an unmapped code is INTERNAL_ERROR, which is what those are', () => {
    for (const err of [new GradingSkewError('x'), new EvalFragmentError('x'), new GradingNonceError('x'), new InternalHarnessError('x')]) {
      expect(Object.hasOwn(SKILL_TEST_REFUSAL_BY_ERROR_CODE, err.code), err.code).toBe(false);
    }
  });
});


describe('BootstrapNeededError message', () => {
  const path = '/p/evals/evals.json';

  it('real run: states the template was written', () => {
    const err = new BootstrapNeededError(path);
    expect(err.expectedPath).toBe(path);
    expect(err.message).toContain('Wrote an evals.json template');
    expect(err.message).toContain(path);
  });

  it('dry run: states nothing was written and names where it would scaffold', () => {
    const err = new BootstrapNeededError(path, { dryRun: true });
    expect(err.expectedPath).toBe(path);
    expect(err.message).toContain('[dry-run]');
    expect(err.message).toContain('nothing was written');
    expect(err.message).toContain(path);
    expect(err.message).not.toContain('Wrote an evals.json template');
    // Same bootstrap-needed signal regardless of mode.
    expect(err.reason).toBe('bootstrap');
  });
});
