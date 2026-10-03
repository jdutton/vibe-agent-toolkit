import { describe, expect, it } from 'vitest';

import { relativeLocationOrRefuse } from '../../../src/commands/agent/validate.js';
import { refusalCodeOf } from '../../../src/utils/command-refusal.js';

/** What a call threw, or `undefined` when it did not throw. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('relativeLocationOrRefuse', () => {
  it('passes a project-relative location through unchanged', () => {
    expect(relativeLocationOrRefuse('agents/a/agent.yaml', '/work/repo')).toBe('agents/a/agent.yaml');
    expect(relativeLocationOrRefuse('../sibling/agent.yaml', '/work/repo')).toBe('../sibling/agent.yaml');
  });

  it.each([
    ['C:/Users/runner/Temp/agent.yaml', 'what path.relative returns for a manifest on another Windows drive'],
    ['/elsewhere/agent.yaml', 'a POSIX-absolute location'],
  ])('refuses %s as USAGE_INVALID — %s', (location) => {
    const refusal = thrownBy(() => relativeLocationOrRefuse(location, 'D:/a/repo'));

    expect(refusalCodeOf(refusal)).toBe('USAGE_INVALID');
    expect((refusal as Error).message).toContain(location);
  });
});
