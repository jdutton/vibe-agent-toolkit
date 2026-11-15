/**
 * The one answer to "whose fault is this parse failure?" — an ALLOWLIST.
 *
 * Only three outcomes are a fact about the file or the run: a per-run refusal
 * (a limit, a dead worker), the parser's own branded throw over the bytes, and
 * a read the OS refused for the file itself. Everything else — a broken
 * install, a decode defect, an unbranded failure — is VAT's, and is rethrown
 * untouched. A blocklist (rethrow only `isParserUnavailable`) let every other
 * VAT defect through as a finding about an innocent file.
 */

import { describe, expect, it } from 'vitest';

import { ParserUnavailableError } from '../src/parse-cache.js';
import { classifyParseFailure } from '../src/parse-failure.js';
import { ParseDecodeDefectError, ParseLimitError, ParseWorkerDiedError, reviveParserThrow } from '../src/parse-limits.js';

/** An `open` the OS refused, as `node:fs` raises it. */
function refusedOpen(code: string): Error {
  return Object.assign(new Error(`${code}: open '/x/doc.md'`), { code, syscall: 'open', path: '/x/doc.md' });
}

describe('classifyParseFailure', () => {
  it('calls a limit breach and a dead worker the run\'s refusal', () => {
    expect(classifyParseFailure(new ParseLimitError('timeMs', 10))).toBe('refused');
    expect(classifyParseFailure(new ParseWorkerDiedError({ exitCode: 3 }))).toBe('refused');
  });

  it('calls only the parser\'s branded throw the document\'s', () => {
    expect(classifyParseFailure(reviveParserThrow({ name: 'Error', message: 'bad bytes' }, true))).toBe('document');
  });

  it('calls a read the OS refused for the file unreadable', () => {
    expect(classifyParseFailure(refusedOpen('EACCES'))).toBe('unreadable');
    expect(classifyParseFailure(refusedOpen('ENOENT'))).toBe('unreadable');
  });

  it.each([
    ['a broken install', new ParserUnavailableError('markdown', './parse-worker.js', refusedOpen('ENOENT'))],
    ['a decode defect', new ParseDecodeDefectError(new TypeError('seeded'))],
    ['an unbranded worker failure', reviveParserThrow({ name: 'Error', message: 'could not post the reply' }, false)],
    ['a plain error', new Error('unexpected token')],
    ['a machine out of descriptors', refusedOpen('EMFILE')],
  ])('rethrows %s untouched: VAT\'s fault, never the file\'s', (_label, error) => {
    expect(() => classifyParseFailure(error)).toThrow(error);
  });
});
