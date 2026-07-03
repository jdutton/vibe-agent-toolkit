import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { packagingConfigToPackageOptions } from '../src/skill-packager.js';

describe('packagingConfigToPackageOptions', () => {
  const anchors = { skillPath: '/repo/skills/x/SKILL.md', outputPath: '/repo/dist/skills/x' };

  it('sets the deterministic base options', () => {
    const out = packagingConfigToPackageOptions({}, anchors);
    expect(out).toMatchObject({
      outputPath: '/repo/dist/skills/x',
      formats: ['directory'],
      rewriteLinks: true,
      basePath: dirname(anchors.skillPath),
    });
  });

  it('forwards only the present optional packaging fields', () => {
    const out = packagingConfigToPackageOptions(
      { linkFollowDepth: 'full', files: [{ source: 'a', dest: 'b' }] } as never,
      anchors,
    );
    expect(out.linkFollowDepth).toBe('full');
    expect(out.files).toEqual([{ source: 'a', dest: 'b' }]);
    expect('validation' in out).toBe(false);
  });
});
