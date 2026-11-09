/**
 * A finding's `column` coordinate has ONE home — `ValidationIssueSchema` — and every published
 * finding schema inherits that very schema object. A second declaration (a `.extend({ column })`
 * beside the inherited one) is a different object, so identity is what this file checks.
 */

import { FindingSchema, ValidationIssueSchema } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { CHECK_FINDING_SCHEMA } from '../../src/commands/resources/check-schema.js';

describe('the finding column coordinate', () => {
  it('is ValidationIssueSchema\'s own declaration in the shared finding schema', () => {
    expect(FindingSchema.shape.column).toBe(ValidationIssueSchema.shape.column);
  });

  it('is the same declaration in vat resources check\'s finding schema', () => {
    expect(CHECK_FINDING_SCHEMA.innerType().shape.column).toBe(ValidationIssueSchema.shape.column);
  });
});
