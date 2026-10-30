/**
 * Which operator notices the process running the checks prints — by who invoked it.
 *
 * A supervised child shares its supervisor's stderr and reads the same config, so it prints no
 * config warning; it prints the store notice only under a standalone `vat resources check`, whose
 * supervisor opens no store. `checks-notices.system.test.ts` pins the same split by the process that
 * actually printed each line.
 */

import { describe, expect, it } from 'vitest';

import type { SupervisedChild } from '../../src/commands/resources/check-supervisor.js';
import { __internal } from '../../src/commands/resources/check.js';
import { EVERY_NOTICE } from '../../src/utils/operator-notices.js';

const { noticeAudienceOf } = __internal;

/** A supervised child started by `invoker`. */
function childOf(invoker: SupervisedChild['invoker']): SupervisedChild {
  return { invoker, supervisorPid: 4242, progressLog: 'progress.jsonl' };
}

describe('noticeAudienceOf', () => {
  it.each([
    ['not a supervised child (the invoked process, or --budget 0)', undefined, EVERY_NOTICE],
    ['a child of a standalone vat resources check', childOf('standalone'), { config: false, store: true }],
    ['a child of vat validate\'s checks phase', childOf('phase'), { config: false, store: false }],
  ] as const)('%s', (_invoker, child, audience) => {
    expect(noticeAudienceOf(child)).toStrictEqual(audience);
  });
});
