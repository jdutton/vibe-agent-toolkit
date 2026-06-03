import { describe, expect, it } from 'vitest';

import { CODE_REGISTRY } from '../src/validation-codes.js';
import { createRegistryIssue } from '../src/validation-issue.js';

describe('MALFORMED_HTML code', () => {
  it('is registered as info', () => {
    expect(CODE_REGISTRY.MALFORMED_HTML.defaultSeverity).toBe('info');
    expect(CODE_REGISTRY.MALFORMED_HTML.reference).toBe('#malformed_html');
  });

  it('builds an info-severity issue', () => {
    const issue = createRegistryIssue('MALFORMED_HTML', 'Malformed HTML: missing-end-tag', { line: 3 });
    expect(issue.severity).toBe('info');
    expect(issue.line).toBe(3);
  });
});
