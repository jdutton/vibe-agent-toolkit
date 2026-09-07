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

/**
 * The two-part silence assertion.
 *
 * Asserting only that no finding was reported would also pass for a document the
 * lexer never offered a candidate for — silence for the wrong reason. Pinning
 * BOTH says the path was seen and REJECTED, which is the claim each caller is
 * actually making.
 */
async function expectNoCandidateAndNoFinding(dir: string): Promise<void> {
  await expect(bundledPathCandidates(safePath.join(dir, 'SKILL.md'))).resolves.toEqual([]);
  await expect(detectMissingReferencedPaths(skillMdOf(dir), dir)).resolves.toEqual([]);
}

/**
 * Make `dir` a skill root — a mount point a bundle-relative path may resolve
 * against. Its SKILL.md is the whole marker; nothing reads the body.
 */
function markAsSkillRoot(dir: string, name: string): void {
  mkdirSyncReal(dir, { recursive: true });
  fs.writeFileSync(safePath.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: A ${name} skill.\n---\n`);
}

/**
 * The measured sibling case: a skill naming `resources/handling-review-comments.md`
 * that only a SIBLING skill under the same plugin root actually ships.
 */
function writeSkillPointingAtSibling(): { dir: string; pluginRoot: string } {
  const dir = writeSkill('See `resources/handling-review-comments.md` in the sibling skill.');
  const pluginRoot = safePath.join(root, 'plugin');
  const sibling = safePath.join(pluginRoot, 'skills', 'other');
  markAsSkillRoot(sibling, 'other');
  mkdirSyncReal(safePath.join(sibling, 'resources'), { recursive: true });
  fs.writeFileSync(safePath.join(sibling, 'resources', 'handling-review-comments.md'), '# ok\n');
  return { dir, pluginRoot };
}

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

  // The lexer admits `./x` unconditionally and a Windows-authored doc spells the
  // separator with a backslash. Both name a bundled subdirectory; neither used
  // to be ROOTED at one as far as this predicate could tell, because it read the
  // first segment of the RAW token — `.` for the first, the whole path for the
  // second. A build drop referenced as `./scripts/setup.mjs` is this module's
  // own headline case, and it was invisible.
  //
  // ⚠️ Only the `./` rows are reachable from the shipped LEXER. It emits a run
  // only when it contains one of `/ $ % @`, so a backslash-ONLY path never
  // becomes a candidate and never reaches this predicate. These rows pin the
  // predicate's own contract, not an end-to-end capability — the module comment
  // used to claim the latter.
  it.each([
    './scripts/run.mjs',
    './references/guide.md',
    String.raw`scripts\run.mjs`,
    String.raw`templates\brand\constants.json`,
  ])('accepts a bundled-subdir path written with ./ or backslashes: %s', token =>
    expect(isBundledSubdirPath(token)).toBe(true));

  // `..` leaves the bundle, so the token is not a claim about the bundle's
  // contents — and it is the segment that turns verbatim markdown content into
  // a traversal by the time it reaches `existsSync`.
  it.each([
    'scripts/../../../../etc/passwd',
    'scripts/../secrets.md',
    './scripts/../../x.mjs',
    '/scripts/run.mjs',
    'scripts//run.mjs',
    'scripts/./run.mjs',
  ])('rejects a path that leaves or re-enters the bundle: %s', token =>
    expect(isBundledSubdirPath(token)).toBe(false));

  // ⚠️ THE VACUITY GUARD for every assertion above.
  //
  // `bundledPathCandidates` used to re-derive this predicate's two steps inline
  // instead of calling it, so the block above pinned a COPY of the rule and the
  // shipped rule was unpinned: adding `.toLowerCase()` to the production lookup
  // left all eight cases green while changing what actually fires. This case runs
  // the SAME token through both, so any future re-inlining shows up as a
  // divergence rather than as silence. `Scripts/` is the discriminating input —
  // the two agree on it only while there is one rule.
  it.each([
    { token: 'scripts/build.mjs', admitted: true },
    { token: 'references/index.md', admitted: true },
    { token: 'Scripts/build.mjs', admitted: false },
    { token: 'RESOURCES/index.md', admitted: false },
    { token: 'docs/product/prd.md', admitted: false },
  ])('the SHIPPED route agrees with the predicate on $token', async ({ token, admitted }) => {
    const dir = writeSkill(`Open \`${token}\` first.`);

    expect(isBundledSubdirPath(token)).toBe(admitted);
    await expect(bundledPathCandidates(safePath.join(dir, 'SKILL.md')))
      .resolves.toEqual(admitted ? [token] : []);
  });
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

    // NEGATIVE CONTROL, without which this test is vacuous. Silence proves the
    // existence test cleared the path only if a candidate was produced at all —
    // a lexer change that stopped emitting `scripts/run.mjs` would otherwise
    // leave this green while silently killing the detector.
    await expect(bundledPathCandidates(safePath.join(dir, 'SKILL.md')))
      .resolves.toEqual(['scripts/run.mjs']);
    await expect(detectMissingReferencedPaths(skillMdOf(dir), dir)).resolves.toEqual([]);
  });

  // The ./-prefixed spelling, end to end: it must fire, and it must anchor on
  // the NORMALIZED path so one allow glob waives it and the bare spelling alike.
  it('flags a build drop referenced as ./scripts/setup.mjs', async () => {
    const dir = writeSkill('Run `./scripts/setup.mjs` first.');

    const issues = await detectMissingReferencedPaths(skillMdOf(dir), dir);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.link).toBe('scripts/setup.mjs');
  });

  // A SECOND DOCUMENTED LEXER RECALL LIMIT, sibling to the identifier-glued one
  // above. The tokenizer only emits a token that carries one of `/ $ % @`, so a
  // path whose only separator is a backslash never becomes a candidate at all.
  // `isBundledSubdirPath` accepts the spelling regardless — that keeps the limit
  // in ONE place (the shared lexer) instead of two, and means this check starts
  // reporting the moment the substrate does emit such a token.
  it('does NOT see a backslash-only path — documented lexer recall limit', async () => {
    const dir = writeSkill(String.raw`Run \`scripts\setup.mjs\` first.`);

    expect(isBundledSubdirPath(String.raw`scripts\setup.mjs`)).toBe(true);
    await expectNoCandidateAndNoFinding(dir);
  });

  it('stays silent on a ./-prefixed reference whose target IS shipped', async () => {
    const dir = writeSkill('Run `./scripts/run.mjs`.', { 'scripts/run.mjs': '// ok\n' });

    await expect(detectMissingReferencedPaths(skillMdOf(dir), dir)).resolves.toEqual([]);
  });

  // A `..` token is verbatim markdown content on its way to `existsSync`. It is
  // not a claim about the bundle, so it yields no candidate and no probe.
  it('produces no candidate and no finding for a traversal token', async () => {
    const dir = writeSkill('Nothing here: `scripts/../../../../etc/passwd`.');

    await expectNoCandidateAndNoFinding(dir);
  });

  // The existence test used to ask "does a file with this SUFFIX exist anywhere
  // under the root?", which a doc copy answers yes to — going silent on exactly
  // the build-drop class this check exists to catch.
  it('still fires when only a same-suffix copy exists deeper in the bundle', async () => {
    const dir = writeSkill('Run `scripts/setup.mjs` first.', {
      'references/scripts/setup.mjs': '// a doc copy, not the referenced path\n',
    });

    const issues = await detectMissingReferencedPaths(skillMdOf(dir), dir);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.link).toBe('scripts/setup.mjs');
  });

  // 🚨 VAT'S OWN PACKAGING used to manufacture this finding.
  //
  // `getTargetSubdir` routes a bundled file by EXTENSION, discarding the
  // subdirectory its author chose — `resources/setup.sh` ships as
  // `scripts/setup.sh`. The packager rewrites markdown LINKS to the routed
  // destination, so the link below resolves; a bare token inside a fence is
  // deliberately NOT rewritten, and bare tokens are exactly what this check
  // reads. The file DID ship, and the registered remedy names no action that
  // resolves it: writing the packaged spelling into the source breaks the source
  // repo, where the file really is under `resources/`.
  //
  // The `bundledPathCandidates` assertion is the negative control — silence has
  // to be the routed-path check clearing the candidate, not the lexer failing to
  // produce one.
  it.each([
    ['a shell script routed resources/ -> scripts/', 'resources/setup.sh', 'scripts/setup.sh'],
    ['a JSON file routed scripts/ -> templates/', 'scripts/config.json', 'templates/config.json'],
    ['a wasm blob routed assets/ -> resources/', 'assets/runtime.wasm', 'resources/runtime.wasm'],
    ['a markdown file routed templates/ -> resources/', 'templates/notes.md', 'resources/notes.md'],
  ])('does not fire on %s that content-type routing relocated', async (_label, authored, routed) => {
    const dir = writeSkill(
      [`See [the file](${authored}).`, '', '```bash', `bash ${authored}`, '```'].join('\n'),
      { [routed]: 'shipped\n' },
    );

    await expect(bundledPathCandidates(safePath.join(dir, 'SKILL.md'))).resolves.toEqual([authored]);
    await expect(detectMissingReferencedPaths(skillMdOf(dir), dir)).resolves.toEqual([]);
  });

  // …and the control that keeps the suppression above from being a blanket
  // amnesty: nothing ships at EITHER spelling, so the finding still fires.
  it('still fires when the routed spelling is absent too', async () => {
    const authored = 'resources/setup.sh';
    const dir = writeSkill(`\`\`\`bash\nbash ${authored}\n\`\`\``);

    await expect(bundledPathCandidates(safePath.join(dir, 'SKILL.md'))).resolves.toEqual([authored]);
    await expect(detectMissingReferencedPaths(skillMdOf(dir), dir))
      .resolves.toMatchObject([{ link: authored }]);
  });

  // The sibling population is REAL — a measured skill names a file only a
  // sibling under the same plugin root ships — and the check is deliberately
  // blind to it. A whole sibling-search subsystem existed for this case and had
  // no production caller, so it was deleted; this pins the behaviour that
  // remains, and it is the reason the SHIPPED fire rate is 3.8% and not 1.9%.
  it('still fires when only a SIBLING skill under the plugin root ships the file', async () => {
    const { dir } = writeSkillPointingAtSibling();

    const issues = await detectMissingReferencedPaths(skillMdOf(dir), dir);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.link).toBe('resources/handling-review-comments.md');
  });

  // No caveat clause survives anywhere in the message. The deleted walk could
  // report a truncated search, and its sentence must not linger as boilerplate.
  it('states absence plainly, with no incomplete-search caveat', async () => {
    const { dir } = writeSkillPointingAtSibling();

    const issues = await detectMissingReferencedPaths(skillMdOf(dir), dir);

    expect(issues[0]?.message).toBe(
      'References "resources/handling-review-comments.md", which is not in the packaged output',
    );
  });

  // LINK_BROKEN_FILE / PACKAGED_BROKEN_LINK already cover a markdown link with a
  // missing target, at ERROR severity. Double-reporting it here would downgrade
  // the same defect to a warning and duplicate the finding.
  //
  // The inline form passes on a LEXICAL ACCIDENT: the token lexes to
  // `guide](resources/guide.md` and `NON_LITERAL` rejects it on the `]`. So it
  // says nothing about whether markdown link targets are excluded. The
  // reference-style DEFINITION below lexes to a clean `resources/guide.md`,
  // rooted at a bundled subdirectory — that is the form that double-reported,
  // and it is what pins the exclusion to a real mechanism.
  it.each([
    ['See [the guide](resources/guide.md) for details.'],
    ['See [the guide][guide].\n\n[guide]: resources/guide.md'],
  ])('does not double-report a markdown link with a missing target: %s', async (body: string) => {
    const dir = writeSkill(body);

    await expectNoCandidateAndNoFinding(dir);
  });

  // …and the control that makes both cases above mean something: the SAME path,
  // named outside link syntax, still fires.
  it('flags the same path when it is named outside link syntax', async () => {
    const dir = writeSkill('Open `resources/guide.md` for details.');

    const issues = await detectMissingReferencedPaths(skillMdOf(dir), dir);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.link).toBe('resources/guide.md');
  });

  // What the `syntacticForm !== 'bare-token'` guard IS for. It is not the
  // markdown-link exclusion (the lexer does that); it is the only thing standing
  // between a variable-anchored path and the literal test, which would otherwise
  // accept it — first segment `scripts`, no glob character anywhere. Delete the
  // guard and this test goes red.
  it('does not treat a variable-anchored path under a bundled subdir as a literal', async () => {
    const dir = writeSkill('Run `scripts/$VARIANT/run.mjs`.');

    await expectNoCandidateAndNoFinding(dir);
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
