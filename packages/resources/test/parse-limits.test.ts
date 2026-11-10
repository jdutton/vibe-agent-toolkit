/**
 * The pure half of the parse limits: the defaults, how rows are counted, which
 * thrown values are a stack breach, the worker-death refusal, and the one heap
 * measure the pool's sampler compares against `heapMb`.
 */

import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import {
  appliedHeapLimitMb,
  countOutputRows,
  isParseLimitError,
  isParseWorkerDiedError,
  isPerRunParseRefusal,
  isStackOverflow,
  oldGenerationBytes,
  ParseLimitError,
  ParseWorkerDiedError,
  resolveParseLimits,
} from '../src/parse-limits.js';

const MIB = 1_048_576;

describe('the default parse limits', () => {
  it('allow 30 s of wall clock: the slowest realistic shape (10.6 s) plus a cold parser load under load', () => {
    expect(resolveParseLimits(undefined).timeMs).toBe(30_000);
  });
});

describe('countOutputRows', () => {
  it('counts nested arrays, so one heading over 20,000 subheadings is 20,001 rows', () => {
    const children = Array.from({ length: 20_000 }, (_, index) => ({ level: 2, text: `h${String(index)}`, children: [] }));
    const facts = { links: [], headings: [{ level: 1, text: 'top', children }] };

    expect(countOutputRows(facts)).toBe(20_001);
    expect(countOutputRows(facts)).toBeGreaterThan(resolveParseLimits(undefined).outputRows);
  });

  it('counts arrays inside objects inside arrays, and skips scalars', () => {
    expect(countOutputRows({ a: [{ b: [1, 2] }, 3], c: 'x', d: { e: [4] } })).toBe(5);
  });
});

describe('isStackOverflow', () => {
  it('recognises the engine overflow itself', () => {
    let error: unknown;
    const descend = (depth: number): number => descend(depth + 1) + 1;
    try {
      descend(0);
    } catch (thrown) {
      error = thrown;
    }

    expect(isStackOverflow(error)).toBe(true);
  });

  it("recognises yaml's wrapping of an overflow (a YAMLParseError coded RESOURCE_EXHAUSTION)", () => {
    // 8,000 levels overflow the main thread's stack inside yaml's composer,
    // which catches the RangeError and re-raises it as a YAMLParseError.
    const source = `a: ${'['.repeat(8000)}${']'.repeat(8000)}\n`;
    let error: unknown;
    try {
      yaml.parse(source);
    } catch (thrown) {
      error = thrown;
    }

    expect((error as { name?: unknown }).name).toBe('YAMLParseError');
    expect(isStackOverflow(error)).toBe(true);
  });

  it('does not take an ordinary YAML syntax error for an overflow', () => {
    let error: unknown;
    try {
      yaml.parse('a: [unclosed');
    } catch (thrown) {
      error = thrown;
    }

    expect(isStackOverflow(error)).toBe(false);
    expect(isStackOverflow(new RangeError('Invalid array length'))).toBe(false);
  });
});

describe('ParseWorkerDiedError', () => {
  it('is coded, names the exit, and is a per-run refusal beside a limit breach', () => {
    const died = new ParseWorkerDiedError({ exitCode: 1 });

    expect(died.code).toBe('PARSE_WORKER_DIED');
    expect(died.message).toContain('exited unexpectedly with code 1');
    expect(isParseWorkerDiedError(died)).toBe(true);
    expect(isParseLimitError(died)).toBe(false);
    expect(isPerRunParseRefusal(died)).toBe(true);
    expect(isPerRunParseRefusal(new ParseLimitError('timeMs', 1))).toBe(true);
    expect(isPerRunParseRefusal(new Error('a parser bug'))).toBe(false);
  });

  it('names the error a worker died of, and keeps it as the cause', () => {
    const cause = Object.assign(new Error('boom'), { code: 'ERR_SOMETHING' });
    const died = new ParseWorkerDiedError({ cause });

    expect(died.message).toContain('ERR_SOMETHING');
    expect(died.cause).toBe(cause);
  });

  it('survives the trip as plain data, by its code', () => {
    const plain = { ...new ParseWorkerDiedError({ exitCode: 3 }), code: 'PARSE_WORKER_DIED' };

    expect(isPerRunParseRefusal(plain)).toBe(true);
  });
});

describe('the heap measure', () => {
  it('is the old generation: used heap less the young generation the worker was given', () => {
    expect(oldGenerationBytes({ used_heap_size: 200 * MIB }, 96)).toBe(104 * MIB);
    expect(oldGenerationBytes({ used_heap_size: 10 * MIB }, 96)).toBe(0);
  });

  it('names the limit that applied, a lower process-wide --max-old-space-size included', () => {
    // heap_size_limit is the old generation's ceiling plus the young generation's.
    expect(appliedHeapLimitMb({ heap_size_limit: 1120 * MIB }, 96, 1024)).toBe(1024);
    expect(appliedHeapLimitMb({ heap_size_limit: 128 * MIB }, 96, 1024)).toBe(32);
    expect(appliedHeapLimitMb({ heap_size_limit: 4192 * MIB }, 96, 48)).toBe(48);
  });

  it('says in the refusal when a process-wide flag lowered the limit', () => {
    const lowered = ParseLimitError.heap(32, 1024);

    expect(lowered.limit).toBe('heapMb');
    expect(lowered.bound).toContain('32 MiB heap');
    expect(lowered.bound).toContain('--max-old-space-size');
    expect(ParseLimitError.heap(1024, 1024).bound).toBe('1024 MiB heap');
  });
});
