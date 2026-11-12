import { inMemoryContent, isParseLimitError, parseContentCached } from '@vibe-agent-toolkit/resources';
import { describe, it, expect } from 'vitest';

import { parseFrontmatter } from '../src/parsers/frontmatter-parser.js';
import { declaredSkillNameIn } from '../src/skill-identity.js';
import { detectorFrontmatter } from '../src/validators/compat-detectors.js';

import { createFrontmatter, createSkillContent, setupParseRoute } from './test-helpers.js';

/** Every parse in this file runs in the bounded worker, on one dispatcher. */
const ROUTE = setupParseRoute();

describe('parseFrontmatter', () => {
  it('should extract frontmatter from SKILL.md', async () => {
    const content = createSkillContent(
      { name: 'my-skill', description: 'Does something useful' },
      '# Content here',
    );

    const result = await parseFrontmatter(inMemoryContent(content), ROUTE);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.frontmatter.name).toBe('my-skill');
      expect(result.frontmatter.description).toBe('Does something useful');
      expect(result.body).toBe('# Content here');
    }
  });

  it('should handle frontmatter with no trailing content', async () => {
    const content = createFrontmatter({ name: 'my-skill', description: 'Test' });

    const result = await parseFrontmatter(inMemoryContent(content), ROUTE);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.body).toBe('');
    }
  });

  it('should handle frontmatter with metadata', async () => {
    const content = createFrontmatter({
      name: 'my-skill',
      description: 'Test',
      metadata: {
        version: '1.0.0',
        author: 'Jeff',
      },
    });

    const result = await parseFrontmatter(inMemoryContent(content), ROUTE);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.frontmatter.metadata).toEqual({
        version: '1.0.0',
        author: 'Jeff',
      });
    }
  });

  it('should return error if no frontmatter delimiters', async () => {
    const content = `# Just content, no frontmatter`;

    const result = await parseFrontmatter(inMemoryContent(content), ROUTE);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('No frontmatter found');
    }
  });

  it('should return error if frontmatter not at start', async () => {
    const content = `
Some text before
---
name: my-skill
description: Test
---`;

    const result = await parseFrontmatter(inMemoryContent(content), ROUTE);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('must start at beginning');
    }
  });

  it('should return error if only opening delimiter', async () => {
    const content = `---
name: my-skill
description: Test`;

    const result = await parseFrontmatter(inMemoryContent(content), ROUTE);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('closing delimiter');
    }
  });

  it('should return error if invalid YAML', async () => {
    const content = `---
name: my-skill
description: [unclosed array
---`;

    const result = await parseFrontmatter(inMemoryContent(content), ROUTE);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('YAML');
    }
  });

  it('should handle Windows line endings', async () => {
    const content = `---\r\nname: my-skill\r\ndescription: Test\r\n---\r\nBody`;

    const result = await parseFrontmatter(inMemoryContent(content), ROUTE);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.frontmatter.name).toBe('my-skill');
    }
  });
});

/**
 * A `---` block whose YAML is not a MAPPING is not frontmatter. `yaml.parse`
 * answers `null` for an empty document and `~`, a string for a bare scalar and
 * an array for a sequence — and the success arm's type says `Record<string,
 * unknown>`, so every consumer dereferenced it. `validateSkill` died with
 * `Cannot read properties of null (reading 'name')` and took the whole
 * `vat audit` run with it (exit 2, no per-file result for any plugin), while
 * two other consumers had grown private `null` guards that returned "nothing
 * declared" — three readers, three answers for one file. The seam now refuses
 * the shape once — by the parse worker's `isPlainMapping`, the rule every lane
 * reads — and says the block is not a mapping, so the message is not "no
 * frontmatter" over a file that plainly has a `---` block.
 */
/** The refusal of `block`, fenced as a document's frontmatter; fails the test if it was admitted. */
async function refusalOf(block: string): Promise<{ error: string; cause: unknown }> {
  const result = await parseFrontmatter(inMemoryContent(`---\n${block}\n---\n# body\n`), ROUTE);
  if (result.success) throw new Error(`expected a refusal, got ${JSON.stringify(result.frontmatter)}`);
  return result;
}

describe('parseFrontmatter — a block that is not a YAML mapping', () => {
  const NON_MAPPINGS: ReadonlyArray<readonly [label: string, block: string]> = [
    ['bare scalar', 'hello'],
    ['sequence', '- a\n- b'],
    ['!!set root', '!!set\n? a\n? b'],
    ['!!omap root', '!!omap\n- a: 1\n- b: 2'],
    ['!!timestamp root', '!!timestamp 2024-01-01'],
    ['!!binary root', '!!binary aGk='],
  ];

  for (const [label, block] of NON_MAPPINGS) {
    it(`refuses ${label} as not a mapping, never as absent or empty`, async () => {
      const { error, cause } = await refusalOf(block);
      expect(error).toContain('not a YAML mapping');
      expect(error).not.toContain('No frontmatter found');
      expect(error).not.toContain('empty');
      expect(cause).toBeUndefined();
    });
  }

  // A block that declares nothing is refused as EMPTY — never "not a mapping",
  // the crawl lane's rule (`parseFrontmatterSource`).
  const EMPTY_BLOCKS: ReadonlyArray<readonly [label: string, block: string]> = [
    ['empty', ''],
    ['blank line', '\n'],
    ['explicit null', '~'],
    ['comment only', '# later'],
  ];
  for (const [label, block] of EMPTY_BLOCKS) {
    it(`refuses ${label} as empty, not as a non-mapping`, async () => {
      const { error } = await refusalOf(block);
      expect(error).toContain('empty');
      expect(error).not.toContain('not a YAML mapping');
    });
  }

  // The control: a mapping with zero interesting keys is still a mapping.
  it('still accepts a mapping', async () => {
    const result = await parseFrontmatter(inMemoryContent('---\nname: x\n---\n'), ROUTE);
    expect(result.success).toBe(true);
  });
});

describe('content past the parse input cap', () => {
  // 20 MiB, past the default 8 MiB cap: a small block up front, so a lane that cut the block out
  // before holding the content to the cap would parse it and answer a name.
  const OVERSIZE = `${createFrontmatter({ name: 'oversize', description: 'Past the cap' })}\n${'a'.repeat(20 * 1024 * 1024)}`;

  it.each([
    ['parseFrontmatter', async (): Promise<unknown> => {
      const result = await parseFrontmatter(inMemoryContent(OVERSIZE), { dispatcher: undefined });
      if (result.success) return 'parsed';
      throw result.cause;
    }],
    ['detectorFrontmatter', async (): Promise<unknown> => detectorFrontmatter(inMemoryContent(OVERSIZE), { dispatcher: undefined })],
    ['declaredSkillNameIn', async (): Promise<unknown> => declaredSkillNameIn(inMemoryContent(OVERSIZE), { dispatcher: undefined })],
    ['parseContentCached', async (): Promise<unknown> => parseContentCached(OVERSIZE, 'markdown', { dispatcher: undefined })],
  ])('is refused whole by %s, never parsed in part', async (_name, run) => {
    const refusal = await run().then(() => undefined, (error: unknown) => error);

    expect(isParseLimitError(refusal) && refusal.limit).toBe('inputBytes');
  });
});
