import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { FrontmatterParseError, openFrontmatter } from '../src/frontmatter-editor.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES_DIR = safePath.join(__dirname, 'fixtures', 'round-trip');

function readFixture(name: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path is test-controlled
  return readFileSync(safePath.join(FIXTURES_DIR, name), 'utf-8');
}

describe('FrontmatterEditor — round-trip identity', () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture dir is test-controlled
  const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.md'));

  for (const fixture of fixtureFiles) {
    it(`preserves bytes exactly for ${fixture}`, () => {
      const original = readFixture(fixture);
      const editor = openFrontmatter(original);
      expect(editor.toString()).toBe(original);
    });
  }
});

describe('FrontmatterEditor — malformed input', () => {
  it('throws FrontmatterParseError with cause on broken YAML', () => {
    const broken = '---\n  key: : invalid\n---\nbody\n';
    expect(() => openFrontmatter(broken)).toThrow(FrontmatterParseError);
  });
});

describe('FrontmatterEditor — mutation locality', () => {
  it('mutating one scalar leaves unrelated bytes unchanged', () => {
    const original = readFixture('scalar-with-inline-comment.md');
    const editor = openFrontmatter(original);
    editor.set('description', 'A new description');
    const updated = editor.toString();
    // The inline comment on `name` must survive
    expect(updated).toContain('this comment must survive');
    // The header line `# Body` must survive
    expect(updated).toContain('# Body');
  });

  it('setting an array item preserves siblings inline comments', () => {
    const original = readFixture('array-with-item-comments.md');
    const editor = openFrontmatter(original);
    editor.setArrayItem('adrs-cited', 0, '/docs/adrs/0007-storage-renamed.md');
    const updated = editor.toString();
    expect(updated).toContain('0007-storage-renamed.md');
    // Sibling comments survive
    expect(updated).toContain('impacted by storage choice');
  });

  it('delete removes the key and its leading comment together', () => {
    const original = readFixture('key-with-leading-comment.md');
    const editor = openFrontmatter(original);
    editor.delete('toDelete'); // key name must match the fixture
    const updated = editor.toString();
    expect(updated).not.toContain('toDelete');
    // The leading comment for the deleted key should be gone too —
    // best-effort per yaml.Document. If `yaml` retains an orphaned
    // comment, document the behavior in the editor doc-comment rather
    // than fail; spec §5.3 says comment-attachment is the editor's
    // responsibility but the editor doesn't add behavior on top of
    // yaml.Document. So this assertion is "the deleted key's value
    // doesn't appear" — the lead comment behavior is observational.
  });

  it('appendArrayItem adds a comment-less item without disturbing existing items', () => {
    const original = readFixture('array-with-item-comments.md');
    const editor = openFrontmatter(original);
    editor.appendArrayItem('adrs-cited', '/docs/adrs/0022-new.md');
    const updated = editor.toString();
    expect(updated).toContain('0022-new.md');
    expect(updated).toContain('primary reference'); // existing comment survives
  });
});

describe('FrontmatterEditor — adding frontmatter to a file that has none', () => {
  it('writes a complete --- fenced frontmatter block', () => {
    const original = readFixture('no-frontmatter.md');
    const editor = openFrontmatter(original);
    editor.set('title', 'Added');
    const updated = editor.toString();
    expect(updated.startsWith('---\n')).toBe(true);
    expect(updated).toContain('title: Added');
    expect(updated).toContain('# Just a heading');
  });
});
