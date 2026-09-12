import { describe, expect, it } from 'vitest';

import { parseEnvBoolean } from '../src/env-flag.js';

describe('parseEnvBoolean', () => {
  it.each(['1', 'true', 'TRUE', 'True', 'yes', 'Yes', 'y', 'on', 'ON', ' true ', '\t1\n'])(
    '%j reads as true',
    (raw) => {
      expect(parseEnvBoolean(raw)).toBe(true);
    },
  );

  it.each(['0', 'false', 'FALSE', 'False', 'no', 'No', 'n', 'off', 'OFF', ' 0', '0 '])(
    '%j reads as false',
    (raw) => {
      expect(parseEnvBoolean(raw)).toBe(false);
    },
  );

  it.each([undefined, '', '   ', '2', '-1', 'maybe', 'null', 'undefined', 'truthy', 'onward'])(
    '%j is not a boolean, so it reads as undefined rather than guessing',
    (raw) => {
      expect(parseEnvBoolean(raw)).toBeUndefined();
    },
  );

  it('never returns a truthy non-boolean — callers branch on `=== undefined`', () => {
    for (const raw of ['1', '0', 'nonsense', undefined]) {
      const parsed = parseEnvBoolean(raw);
      expect(parsed === undefined || typeof parsed === 'boolean').toBe(true);
    }
  });
});
