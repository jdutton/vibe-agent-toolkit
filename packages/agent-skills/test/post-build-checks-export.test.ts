import { describe, expect, it } from 'vitest';

import { checkBrokenPackagedLinks } from '../src/index.js';

describe('agent-skills package exports', () => {
  it('exports checkBrokenPackagedLinks from the package root', () => {
    expect(typeof checkBrokenPackagedLinks).toBe('function');
  });
});
