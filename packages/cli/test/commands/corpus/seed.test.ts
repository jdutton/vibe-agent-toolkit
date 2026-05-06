import { mkdtempSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { loadSeedFile } from '../../../src/commands/corpus/seed.js';

function writeSeed(content: string): string {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-seed-'));
  const file = safePath.join(dir, 'seed.yaml');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only path under tmpdir
  writeFileSync(file, content, 'utf-8');
  return file;
}

describe('loadSeedFile', () => {
  it('parses a minimal seed with one entry', () => {
    const file = writeSeed(`
plugins:
  - source: .
    name: vibe-agent-toolkit
`);
    const seed = loadSeedFile(file);
    expect(seed.plugins).toHaveLength(1);
    expect(seed.plugins[0]).toEqual({ source: '.', name: 'vibe-agent-toolkit' });
  });

  it('parses an entry with a validation block', () => {
    const file = writeSeed(`
plugins:
  - source: https://github.com/foo/bar.git
    name: bar
    validation:
      severity:
        SKILL_DESCRIPTION_FILLER_OPENER: ignore
      allow:
        - code: LINK_TO_NAVIGATION_FILE
          reason: README link is intentional
`);
    const seed = loadSeedFile(file);
    expect(seed.plugins[0].validation?.severity).toEqual({
      SKILL_DESCRIPTION_FILLER_OPENER: 'ignore',
    });
    expect(seed.plugins[0].validation?.allow).toEqual([
      { code: 'LINK_TO_NAVIGATION_FILE', reason: 'README link is intentional' },
    ]);
  });

  it('rejects a seed with duplicate sources', () => {
    const file = writeSeed(`
plugins:
  - source: .
    name: a
  - source: .
    name: b
`);
    expect(() => loadSeedFile(file)).toThrow(/duplicate source/i);
  });

  it('rejects a seed with duplicate names', () => {
    const file = writeSeed(`
plugins:
  - source: a/b
    name: same
  - source: c/d
    name: same
`);
    expect(() => loadSeedFile(file)).toThrow(/duplicate name/i);
  });

  it('rejects a seed missing a required field', () => {
    const file = writeSeed(`
plugins:
  - source: .
`);
    expect(() => loadSeedFile(file)).toThrow(/name/i);
  });

  it('rejects a seed file that does not exist', () => {
    expect(() => loadSeedFile('/nonexistent/path/seed.yaml')).toThrow(/not found|ENOENT/i);
  });

  it('rejects a seed file with malformed YAML', () => {
    const file = writeSeed('not: valid: yaml: ::');
    expect(() => loadSeedFile(file)).toThrow();
  });
});
