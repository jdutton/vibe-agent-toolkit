/* eslint-disable security/detect-non-literal-fs-filename -- fixture paths built from this test's own mkdtemp root, no external input */
import * as fs from 'node:fs';

import { applyAllowFilter } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bundledPathCandidates,
  detectMissingReferencedPaths,
  isBundledSubdirPath,
} from '../../src/validators/referenced-path-missing.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-refpath-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a packaged skill and return its directory. */
function writeSkill(body: string, files: Record<string, string> = {}): string {
  const skillDir = safePath.join(root, 'plugin', 'skills', 'demo');
  mkdirSyncReal(skillDir, { recursive: true });
  fs.writeFileSync(safePath.join(skillDir, 'SKILL.md'), `---\nname: demo\ndescription: A demo skill.\n---\n\n${body}\n`);
  for (const [rel, content] of Object.entries(files)) {
    const target = safePath.join(skillDir, rel);
    mkdirSyncReal(safePath.join(target, '..'), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return skillDir;
}

const skillMdOf = (dir: string) => [safePath.join(dir, 'SKILL.md')];

describe('isBundledSubdirPath — the rule that earns the precision', () => {
  it.each(['scripts/run.mjs', 'templates/a/b.json', 'references/guide.md', 'assets/x.png', 'resources/y.md'])(
    'accepts a literal path rooted at a bundled subdir: %s',
    token => expect(isBundledSubdirPath(token)).toBe(true),
  );

  // The lexer emits these as equal candidates; whether a token names the skill's
  // own bundle or the USER'S repository is the judgement this predicate makes.
  it.each(['docs/product/prd.md', 'dist/bin/arc-cli.mjs', 'test/a.test.ts', 'src/index.ts'])(
    'rejects a path that is not rooted at a bundled subdir: %s',
    token => expect(isBundledSubdirPath(token)).toBe(false),
  );

  // A glob or placeholder is not a claim that a file exists. Measured: this rule
  // alone took the fire rate from 65.4% to 46.2% on a 52-skill corpus.
  it.each([
    'scripts/**/*.mjs',
    'templates/<component>/prd.md',
    'resources/{a,b}.md',
    'assets/[id].png',
  ])('rejects a glob or placeholder: %s', token => expect(isBundledSubdirPath(token)).toBe(false));
});

describe('detectMissingReferencedPaths', () => {
  // The adopter's headline case: every reference lives in Python/JS code, NOT in
  // a markdown link, so LINK_BROKEN_FILE cannot see any of it.
  it('flags a code-block path when the skill ships no bundled dirs at all', async () => {
    const dir = writeSkill([
      '```python',
      "sys.path.insert(0, 'scripts/multi-template/resolver.py')",
      '```',
    ].join('\n'));

    const issues = await detectMissingReferencedPaths(skillMdOf(dir), dir);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PACKAGED_REFERENCED_PATH_MISSING');
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.message).toContain('scripts/multi-template/resolver.py');
    expect(issues[0]?.location).toBe('SKILL.md');
    // The missing path rides `link`, never `location` — that is what makes a
    // single reference waivable without silencing the file.
    expect(issues[0]?.link).toBe('scripts/multi-template/resolver.py');
  });

  // A KNOWN RECALL LIMIT, pinned so it is a decision rather than a surprise.
  //
  // The lexer tokenizes on whitespace, then strips leading DELIMITERS. In
  // `TemplateBuilder('templates/x.json')` the path is glued to an identifier, so
  // the whole call is one token whose lead is text, not a delimiter — and no
  // candidate is produced. The same path written with a space after a comma, or
  // in a code span, IS found.
  //
  // This is why the check still catches the real skills it was built from: they
  // reference the same missing files several ways, and only one needs to land.
  // Widening the lexer to scan inside identifiers is a change to the shared
  // reference substrate (it would add rows to `blob_references` for every
  // consumer) and is deliberately NOT made from inside this check.
  it('does NOT see a path glued to an identifier — documented lexer recall limit', async () => {
    const dir = writeSkill("```js\nconst b = TemplateBuilder('templates/brand/constants.json');\n```");

    await expect(detectMissingReferencedPaths(skillMdOf(dir), dir)).resolves.toEqual([]);
  });

  // The BUILD DROP — the class no human review of the source can catch, and the
  // reason this check earns its keep. Reference is correct; the file is absent.
  it('flags an inline code-span reference whose target did not survive the build', async () => {
    const dir = writeSkill('Install steps are in `references/whisper-setup.md`.');

    const issues = await detectMissingReferencedPaths(skillMdOf(dir), dir);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('references/whisper-setup.md');
  });

  it('stays silent when the referenced file is actually shipped', async () => {
    const dir = writeSkill('Run `node scripts/run.mjs` to start.', { 'scripts/run.mjs': '// ok\n' });

    await expect(detectMissingReferencedPaths(skillMdOf(dir), dir)).resolves.toEqual([]);
  });

  // A skill may legitimately point at a plugin-root file or a sibling skill's
  // resources. Both were false positives under a skill-local existence test.
  it('stays silent when the target exists elsewhere under the sibling search root', async () => {
    const dir = writeSkill('See `resources/handling-review-comments.md` in the sibling skill.');
    const pluginRoot = safePath.join(root, 'plugin');
    const sibling = safePath.join(pluginRoot, 'skills', 'other', 'resources');
    mkdirSyncReal(sibling, { recursive: true });
    fs.writeFileSync(safePath.join(sibling, 'handling-review-comments.md'), '# ok\n');

    await expect(detectMissingReferencedPaths(skillMdOf(dir), dir, pluginRoot)).resolves.toEqual([]);
    // …and the same input DOES fire when the caller scopes it to the skill only,
    // which is what makes the widened root load-bearing rather than decorative.
    const skillLocal = await detectMissingReferencedPaths(skillMdOf(dir), dir);
    expect(skillLocal).toHaveLength(1);
  });

  // LINK_BROKEN_FILE / PACKAGED_BROKEN_LINK already cover a markdown link with a
  // missing target, at ERROR severity. Double-reporting it here would downgrade
  // the same defect to a warning and duplicate the finding.
  it('does not double-report a markdown link with a missing target', async () => {
    const dir = writeSkill('See [the guide](resources/guide.md) for details.');

    await expect(detectMissingReferencedPaths(skillMdOf(dir), dir)).resolves.toEqual([]);
  });

  // One issue PER PATH, not per document. Emitting a single issue carrying a
  // joined list would make the coarse `location` waiver the only option, and a
  // waiver for one illustrative path would then silence every real finding in
  // that file for good.
  it('reports one issue per missing path, each anchored on its own link', async () => {
    const dir = writeSkill(['`references/a.md`', '`references/b.md`', '`references/c.md`'].join('\n\n'));

    const issues = await detectMissingReferencedPaths(skillMdOf(dir), dir);

    expect(issues).toHaveLength(3);
    expect(issues.map(i => i.link)).toEqual(['references/a.md', 'references/b.md', 'references/c.md']);
    expect(new Set(issues.map(i => i.location))).toEqual(new Set(['SKILL.md']));
  });

  // The whole point of the `link` anchor, exercised through the SHIPPED allow
  // filter rather than a restatement of its rules: waive one illustrative path
  // and the real finding beside it survives.
  it('lets an allow entry waive ONE path while a real finding in the same file still fires', async () => {
    const dir = writeSkill('Teaching example `resources/gates.md`, and a real one `references/setup.md`.');
    const issues = await detectMissingReferencedPaths(skillMdOf(dir), dir);
    expect(issues).toHaveLength(2);

    const { emitted } = applyAllowFilter(issues, {
      allow: {
        PACKAGED_REFERENCED_PATH_MISSING: [
          { paths: ['resources/gates.md'], reason: 'Illustrative path in a skill that teaches link syntax.' },
        ],
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.link).toBe('references/setup.md');
  });

  // …and the coarse form still works, for a file that is entirely illustrative.
  it('still supports waiving a whole document by location', async () => {
    const dir = writeSkill('`resources/gates.md` and `references/setup.md`.');
    const issues = await detectMissingReferencedPaths(skillMdOf(dir), dir);

    const { emitted } = applyAllowFilter(issues, {
      allow: {
        PACKAGED_REFERENCED_PATH_MISSING: [
          { paths: ['**/SKILL.md'], reason: 'This skill is documentation about skill authoring.' },
        ],
      },
    });

    expect(emitted).toEqual([]);
  });
});

describe('bundledPathCandidates', () => {
  it('de-duplicates a path referenced several times', async () => {
    const dir = writeSkill('`scripts/x.mjs` then `scripts/x.mjs` again.');

    await expect(bundledPathCandidates(safePath.join(dir, 'SKILL.md'))).resolves.toEqual(['scripts/x.mjs']);
  });

  it('ignores a bare filename with no slash', async () => {
    const dir = writeSkill('Open `SKILL.md` and `run.mjs`.');

    await expect(bundledPathCandidates(safePath.join(dir, 'SKILL.md'))).resolves.toEqual([]);
  });
});
