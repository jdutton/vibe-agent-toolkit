/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { packageSkill } from '../../src/skill-packager.js';

const SCHEMA = {
  type: 'object',
  properties: {
    parent_spec: { type: 'string', format: 'uri-reference' },
    'adrs-cited': {
      type: 'array',
      items: { type: 'string', format: 'uri-reference' },
    },
  },
};

describe('packager rewrites frontmatter URI-refs with body parity (Gap 3)', () => {
  let projectRoot: string;

  beforeAll(() => {
    projectRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-packager-fmt-'));
    // Lay out:
    //   <root>/vibe-agent-toolkit.config.yaml
    //   <root>/schemas/spec.schema.json
    //   <root>/skills/example/SKILL.md      (frontmatter has uri-ref fields + comment)
    //   <root>/docs/specs/parent.md          (linked from frontmatter)
    //   <root>/docs/adrs/0007.md             (linked from frontmatter array)
    mkdirSyncReal(safePath.join(projectRoot, 'schemas'), { recursive: true });
    mkdirSyncReal(safePath.join(projectRoot, 'skills', 'example'), { recursive: true });
    mkdirSyncReal(safePath.join(projectRoot, 'docs', 'specs'), { recursive: true });
    mkdirSyncReal(safePath.join(projectRoot, 'docs', 'adrs'), { recursive: true });

    writeFileSync(
      safePath.join(projectRoot, 'vibe-agent-toolkit.config.yaml'),
      [
        'version: 1',
        'resources:',
        '  collections:',
        '    specs:',
        '      include: ["skills/**/SKILL.md"]',
        '      validation:',
        '        frontmatterSchema: schemas/spec.schema.json',
        '        mode: permissive',
        '',
      ].join('\n'),
    );
    writeFileSync(
      safePath.join(projectRoot, 'schemas', 'spec.schema.json'),
      JSON.stringify(SCHEMA, null, 2),
    );
    writeFileSync(
      safePath.join(projectRoot, 'skills', 'example', 'SKILL.md'),
      [
        '---',
        'name: example',
        'description: A test skill with frontmatter URI-refs exercising Gap 3 fix.',
        'parent_spec: ../../docs/specs/parent.md  # primary parent',
        'adrs-cited:',
        '  - ../../docs/adrs/0007.md  # storage decision',
        '---',
        '# Example',
        '',
        'See [parent](../../docs/specs/parent.md) and [adr](../../docs/adrs/0007.md).',
        '',
      ].join('\n'),
    );
    writeFileSync(safePath.join(projectRoot, 'docs', 'specs', 'parent.md'), '# Parent\n');
    writeFileSync(safePath.join(projectRoot, 'docs', 'adrs', '0007.md'), '# ADR 0007\n');
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rewrites frontmatter URI-refs to packaged output paths and preserves comments', async () => {
    const skillPath = safePath.join(projectRoot, 'skills', 'example', 'SKILL.md');
    const outputPath = safePath.join(projectRoot, 'dist', 'example');
    const result = await packageSkill(skillPath, { outputPath, formats: ['directory'] });
    expect(result.hasErrors).toBe(false);

    const builtSkill = readFileSync(safePath.join(outputPath, 'SKILL.md'), 'utf-8');

    // Body links got rewritten to packaged relative paths (existing behavior).
    expect(builtSkill).toMatch(/\[parent\]\([^)]+parent\.md\)/);
    expect(builtSkill).not.toContain('[parent](../../docs/specs/parent.md)');

    // Frontmatter URI-refs got rewritten to the SAME target paths.
    // (Frontmatter and body should agree per spec #2 §8.)
    expect(builtSkill).not.toContain('parent_spec: ../../docs/specs/parent.md');
    expect(builtSkill).toMatch(/parent_spec: [^\s#]+parent\.md/);
    expect(builtSkill).not.toContain('- ../../docs/adrs/0007.md');
    expect(builtSkill).toMatch(/- [^\s#]+0007\.md/);

    // Inline comments on the rewritten fields survived.
    expect(builtSkill).toContain('# primary parent');
    expect(builtSkill).toContain('# storage decision');
  });
});
