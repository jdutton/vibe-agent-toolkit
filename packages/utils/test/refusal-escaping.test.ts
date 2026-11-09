/**
 * The refusals that show a path or a link's text: each shows it through `shown-text`, never raw.
 * Every case plants an ESC and a right-to-left override, and asserts both halves: the escapes are
 * in the message, the raw characters are not. Escapes are spelled after a backslash built at run
 * time, never in `String.raw`, whose `\u` a transform may cook.
 */

import { describe, expect, it } from 'vitest';

import { FsFaultError } from '../src/errors/fs-fault.js';
import { CopyLinkEscapesSourceError, DirectoryWalkRevisitedError } from '../src/tree-change/followed-walk.js';
import { LinkChainRefusedError } from '../src/tree-change/host-chain.js';
import type { ChainRefusal } from '../src/tree-change/link-chain.js';

const bs = '\\';
const ESC = String.fromCodePoint(0x1b);
const RLO = String.fromCodePoint(0x20_2e);
/** A name holding both, and how a message spells it. */
const HOSTILE = `a${ESC}b${RLO}c`;
const SPELLED = `a${bs}u001bb${bs}u202ec`;

function expectEscaped(message: string): void {
  expect(message).toContain(SPELLED);
  expect(message).not.toContain(ESC);
  expect(message).not.toContain(RLO);
}

describe('a refusal shows a hostile name by its escapes', () => {
  it('FsFaultError, in its action and in its paths', () => {
    const fault = new FsFaultError({
      side: 'source',
      faultClass: 'refused',
      errno: 'EACCES',
      path: `/r/${HOSTILE}`,
      movedFrom: `/m/${HOSTILE}`,
      origin: 'content',
      action: `resolve the symbolic link /r/${HOSTILE}`,
      cause: undefined,
    });
    expectEscaped(fault.message);
    expect(fault.message).toBe(`Could not resolve the symbolic link /r/${SPELLED} (EACCES): /m/${SPELLED} -> /r/${SPELLED}`);
    // The fields stay as the OS spelled them: only the message is for a reader.
    expect(fault.path).toBe(`/r/${HOSTILE}`);
  });

  it('DirectoryWalkRevisitedError, both spellings', () => {
    const { message } = new DirectoryWalkRevisitedError(`/t/${HOSTILE}`, `/t/x${HOSTILE}`);
    expectEscaped(message);
    expect(message).toContain(`/t/${SPELLED}:`);
    expect(message).toContain(`/t/x${SPELLED} `);
  });

  it('CopyLinkEscapesSourceError, the link and the source', () => {
    const { message } = new CopyLinkEscapesSourceError(`/s/${HOSTILE}`, `/s${HOSTILE}`);
    expectEscaped(message);
    expect(message).toContain(`/s/${SPELLED}:`);
    expect(message).toContain(`outside /s${SPELLED}.`);
  });

  it.for<ChainRefusal['why']>(['network', 'absolute', 'drive-relative', 'climbs-out', 'unportable'])(
    'LinkChainRefusedError, its path, its link and a %s text',
    (why) => {
      const refusal = { why, link: `/t/l${HOSTILE}`, text: `../${HOSTILE}` } as ChainRefusal;
      const { message } = new LinkChainRefusedError(`/t/p${HOSTILE}`, refusal);
      expectEscaped(message);
      for (const spelled of [`/t/p${SPELLED}:`, `/t/l${SPELLED} `, `../${SPELLED}`]) expect(message).toContain(spelled);
    },
  );

  it('LinkChainRefusedError quotes an unportable text, so a trailing space shows', () => {
    const refusal: ChainRefusal = { why: 'unportable', link: '/t/l', text: 'x. ' };
    expect(new LinkChainRefusedError('/t/p', refusal).message).toContain('("x. ": a NUL');
  });
});
