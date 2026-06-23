import { describe, expect, it } from 'vitest';

import { stripValidationAllowForDisplay } from '../../src/skill-resolution/packaging-config.js';

describe('stripValidationAllowForDisplay', () => {
  it('drops validation.allow but keeps validation.severity', () => {
    const out = stripValidationAllowForDisplay({
      linkFollowDepth: 2,
      validation: { severity: { SKILL_NAME_INVALID: 'warning' }, allow: [{ code: 'X', location: 'y' }] },
    } as never);
    expect(out).toEqual({ linkFollowDepth: 2, validation: { severity: { SKILL_NAME_INVALID: 'warning' } } });
  });

  it('drops validation entirely when no severity present', () => {
    const out = stripValidationAllowForDisplay({ validation: { allow: [{ code: 'X', location: 'y' }] } } as never);
    expect(out).toEqual({});
  });

  it('passes through configs with no validation key', () => {
    expect(stripValidationAllowForDisplay({ linkFollowDepth: 3 } as never)).toEqual({ linkFollowDepth: 3 });
  });
});
