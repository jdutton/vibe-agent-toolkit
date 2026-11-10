import { describe, expect, it } from 'vitest';

import { overOutputRowsMarkdown } from '../src/testing/parse-limit-fixtures.js';

describe('overOutputRowsMarkdown', () => {
  it('carries 20,000 frontmatter rows, one link to its target, and new bytes every call', () => {
    const document = overOutputRowsMarkdown('SKILL.md');
    const items = /^items: \[(.*)\]$/m.exec(document)?.[1]?.split(', ') ?? [];

    expect(items).toHaveLength(20_000);
    expect(document).toContain('[l](./SKILL.md)');
    expect(overOutputRowsMarkdown('SKILL.md')).not.toBe(document);
  });
});
