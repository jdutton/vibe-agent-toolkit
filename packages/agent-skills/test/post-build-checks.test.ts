/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- Tests use non-null assertions after explicit length checks */
import { mkdir, writeFile } from 'node:fs/promises';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { applyFilesConfig } from '../src/files-config.js';
import { checkBrokenPackagedLinks, checkUnreferencedFiles } from '../src/post-build-checks.js';

import { setupTempDir } from './test-helpers.js';

const { getTempDir } = setupTempDir('post-build-checks-');

const SKILL_OUTPUT = 'skill-output';
const SKILL_MD = 'SKILL.md';
const RESOURCES = 'resources';
const SCRIPTS = 'scripts';
const SCRIPTS_CLI = 'scripts/cli.mjs';
const CLI_SCRIPT_BODY = 'console.log("hi");\n';
const GUIDE_LINK_BODY = ['# Skill', '', 'See [guide](resources/guide.md).'].join('\n');
const NO_LINKS_BODY = '# Skill\n\nNo links here.\n';
const BUILD_ARTIFACTS = 'build-artifacts';

/**
 * Create a skill-output directory inside the test tmp dir, along with any
 * requested subdirectories (e.g. 'resources', 'scripts'). If no subdirs are
 * requested the output dir itself is still created.
 */
async function setupOutputDir(subdirs: string[] = []): Promise<string> {
  const outputDir = safePath.join(getTempDir(), SKILL_OUTPUT);
  if (subdirs.length === 0) {
    await mkdir(outputDir, { recursive: true });
  } else {
    for (const sub of subdirs) {
      await mkdir(safePath.join(outputDir, sub), { recursive: true });
    }
  }
  return outputDir;
}

/** Write SKILL.md at the root of outputDir. */
async function writeSkillMd(outputDir: string, body: string): Promise<void> {
  await writeFile(safePath.join(outputDir, SKILL_MD), body);
}

/** Write a file at a relative path inside outputDir. */
async function writeResource(
  outputDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await writeFile(safePath.join(outputDir, relativePath), content);
}

/** Assert a single-issue result matches the expected code and message fragment. */
function expectSingleIssue(
  issues: Array<{ code: string; message: string; location?: string }>,
  code: string,
  messageContains: string,
): void {
  expect(issues).toHaveLength(1);
  expect(issues[0]!.code).toBe(code);
  expect(issues[0]!.message).toContain(messageContains);
}

describe('checkUnreferencedFiles', () => {
  it('should return no issues when all files are referenced', async () => {
    const outputDir = await setupOutputDir([RESOURCES]);
    await writeSkillMd(outputDir, GUIDE_LINK_BODY);
    await writeResource(outputDir, `${RESOURCES}/guide.md`, '# Guide\n');

    const issues = await checkUnreferencedFiles(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should report unreferenced non-markdown file', async () => {
    const outputDir = await setupOutputDir([SCRIPTS]);
    await writeSkillMd(outputDir, NO_LINKS_BODY);
    await writeResource(outputDir, SCRIPTS_CLI, CLI_SCRIPT_BODY);

    const issues = await checkUnreferencedFiles(outputDir);
    expectSingleIssue(issues, 'PACKAGED_UNREFERENCED_FILE', SCRIPTS_CLI);
  });

  it('should report unreferenced markdown file in subdirectory', async () => {
    const outputDir = await setupOutputDir([RESOURCES]);
    await writeSkillMd(outputDir, '# Skill\n\nNo links.\n');
    await writeResource(outputDir, `${RESOURCES}/orphan.md`, '# Orphan\n');

    const issues = await checkUnreferencedFiles(outputDir);
    expectSingleIssue(issues, 'PACKAGED_UNREFERENCED_FILE', 'resources/orphan.md');
  });

  it('should follow transitive links', async () => {
    const outputDir = await setupOutputDir([RESOURCES, SCRIPTS]);
    await writeSkillMd(outputDir, GUIDE_LINK_BODY);
    await writeResource(
      outputDir,
      `${RESOURCES}/guide.md`,
      ['# Guide', '', 'Uses [cli](../scripts/cli.mjs).'].join('\n'),
    );
    await writeResource(outputDir, SCRIPTS_CLI, CLI_SCRIPT_BODY);

    const issues = await checkUnreferencedFiles(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should count path mentions inside fenced code blocks as documented', async () => {
    // CLI scripts are typically documented by showing the invocation:
    // ```bash
    // node scripts/cli.mjs whoami
    // ```
    // That's a legitimate reference — the file is documented for the user —
    // even though it isn't wrapped in a markdown [text](href) link.
    const outputDir = await setupOutputDir([SCRIPTS]);
    await writeSkillMd(
      outputDir,
      [
        '# Skill',
        '',
        'Run the CLI:',
        '',
        '```bash',
        'node scripts/cli.mjs whoami',
        '```',
      ].join('\n'),
    );
    await writeResource(outputDir, SCRIPTS_CLI, CLI_SCRIPT_BODY);

    const issues = await checkUnreferencedFiles(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should count path mentions in inline code or prose as documented', async () => {
    const outputDir = await setupOutputDir([SCRIPTS]);
    await writeSkillMd(
      outputDir,
      ['# Skill', '', 'Invoke via `scripts/cli.mjs` for details.'].join('\n'),
    );
    await writeResource(outputDir, SCRIPTS_CLI, CLI_SCRIPT_BODY);

    const issues = await checkUnreferencedFiles(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should still flag packaged files not mentioned anywhere', async () => {
    const outputDir = await setupOutputDir([SCRIPTS]);
    await writeSkillMd(outputDir, '# Skill\n\nSome unrelated prose.\n');
    await writeResource(outputDir, SCRIPTS_CLI, CLI_SCRIPT_BODY);

    const issues = await checkUnreferencedFiles(outputDir);
    expectSingleIssue(issues, 'PACKAGED_UNREFERENCED_FILE', SCRIPTS_CLI);
  });
});

/**
 * A `files:` dest is a declaration of intent, on equal footing with a link or a
 * prose mention — you cannot "forget" a file you named twice in config. The rule
 * engine has always modeled this (`ctx.inFilesConfig`); this lane is where the
 * fact reaches it.
 *
 * The shape under test is the ordinary one: a skill shipping a vendored wasm
 * engine and generated schemas via `files:`, consumed by code doing runtime path
 * math, referenced by no markdown.
 */
describe('checkUnreferencedFiles - files: config dests', () => {
  const VENDOR_WASM = 'vendor/engine.wasm';

  it('does NOT flag a files:-declared dest that no packaged markdown references', async () => {
    const outputDir = await setupOutputDir(['vendor']);
    await writeSkillMd(outputDir, NO_LINKS_BODY);
    await writeResource(outputDir, VENDOR_WASM, '\0asm');

    const issues = await checkUnreferencedFiles(outputDir, [VENDOR_WASM]);
    expect(issues).toHaveLength(0);
  });

  it('still flags an orphan that is NOT a files:-declared dest (the fix is not a blanket mute)', async () => {
    const outputDir = await setupOutputDir(['vendor', SCRIPTS]);
    await writeSkillMd(outputDir, NO_LINKS_BODY);
    await writeResource(outputDir, VENDOR_WASM, '\0asm');
    await writeResource(outputDir, SCRIPTS_CLI, CLI_SCRIPT_BODY);

    // Only the wasm is declared; the stray script must still fail the build.
    const issues = await checkUnreferencedFiles(outputDir, [VENDOR_WASM]);
    expectSingleIssue(issues, 'PACKAGED_UNREFERENCED_FILE', SCRIPTS_CLI);
    expect(issues[0]!.location).toBe(SCRIPTS_CLI);
  });

  /**
   * Basis proof, not an assumption: the dests come from `applyFilesConfig` itself
   * (the producer the packager calls), and the `before` locations are the exact
   * `relativePath` strings this check computes. If the two normalizations ever
   * diverge — a leading `./`, a backslash, a different root — `before` and `after`
   * cannot both hold.
   */
  it('exempts exactly the dests applyFilesConfig returns, nested glob dests included', async () => {
    const projectRoot = safePath.join(getTempDir(), 'project');
    const genDir = safePath.join(projectRoot, BUILD_ARTIFACTS, 'schemas');
    await mkdir(genDir, { recursive: true });
    await writeFile(safePath.join(projectRoot, BUILD_ARTIFACTS, 'engine.wasm'), '\0asm');
    await writeFile(safePath.join(genDir, 'thing.schema.json'), '{}');

    const outputDir = await setupOutputDir();
    await writeSkillMd(outputDir, NO_LINKS_BODY);

    const dests = await applyFilesConfig({
      filesConfig: [
        { source: toForwardSlash(safePath.join(BUILD_ARTIFACTS, 'engine.wasm')), dest: VENDOR_WASM },
        { source: toForwardSlash(safePath.join(BUILD_ARTIFACTS, 'schemas', '*.json')), dest: 'schemas' },
      ],
      projectRoot,
      skillOutputDir: outputDir,
    });

    const expectedSchemaDest = toForwardSlash(safePath.join('schemas', 'thing.schema.json'));
    const sortFn = (a: string, b: string) => a.localeCompare(b);

    // Both land in the output and, uninformed, both are reported as orphans —
    // these locations ARE the relativePath basis.
    const before = await checkUnreferencedFiles(outputDir);
    expect(before.map(i => i.location).sort(sortFn)).toEqual([expectedSchemaDest, VENDOR_WASM].sort(sortFn));

    // Told what it copied, the check reports nothing.
    expect([...dests].sort(sortFn)).toEqual([expectedSchemaDest, VENDOR_WASM].sort(sortFn));
    const after = await checkUnreferencedFiles(outputDir, dests);
    expect(after).toEqual([]);
  });
});

describe('fix hints and reference anchors', () => {
  it('PACKAGED_UNREFERENCED_FILE fix points at files:, never at a waiver or the removed ignoreValidationErrors', async () => {
    const outputDir = await setupOutputDir([RESOURCES]);
    await writeSkillMd(outputDir, NO_LINKS_BODY);
    await writeResource(outputDir, `${RESOURCES}/orphan.json`, '{}');

    const issues = await checkUnreferencedFiles(outputDir);
    const unref = issues.find(i => i.code === 'PACKAGED_UNREFERENCED_FILE');
    expect(unref).toBeDefined();
    expect(unref?.fix).not.toMatch(/ignoreValidationErrors/);
    // A declared dest is exempt, so the remedy must not send readers to duplicate
    // their `files:` map into validation.allow — that was the old text's failure.
    expect(unref?.fix).toMatch(/\.files\b/);
    expect(unref?.fix).not.toMatch(/Allow via validation\.allow/i);
    expect(unref?.reference).toMatch(/^#packaged_unreferenced_file/);
  });

  it('PACKAGED_BROKEN_LINK fix does not reference ignoreValidationErrors', async () => {
    const outputDir = await setupOutputDir();
    await writeSkillMd(outputDir, GUIDE_LINK_BODY);

    const issues = await checkBrokenPackagedLinks(outputDir);
    const broken = issues.find(i => i.code === 'PACKAGED_BROKEN_LINK');
    expect(broken).toBeDefined();
    expect(broken?.fix).not.toMatch(/ignoreValidationErrors/);
    expect(broken?.reference).toMatch(/^#packaged_broken_link/);
  });
});

describe('checkBrokenPackagedLinks', () => {
  it('should return no issues when all links resolve', async () => {
    const outputDir = await setupOutputDir([RESOURCES]);
    await writeSkillMd(outputDir, GUIDE_LINK_BODY);
    await writeResource(outputDir, `${RESOURCES}/guide.md`, '# Guide\n');

    const issues = await checkBrokenPackagedLinks(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should report broken link in packaged SKILL.md', async () => {
    const outputDir = await setupOutputDir();
    await writeSkillMd(outputDir, GUIDE_LINK_BODY);

    const issues = await checkBrokenPackagedLinks(outputDir);
    expectSingleIssue(issues, 'PACKAGED_BROKEN_LINK', 'resources/guide.md');
  });

  // The never-package filter drops a glob's `README.md`/`CLAUDE.md` matches, so a
  // link to one is genuinely broken in the output and must still fail the build.
  // But the generic remediation blames a link-rewriter bug, which would send the
  // author hunting a VAT defect instead of naming the file explicitly.
  it('names the never-package cause instead of implying a VAT bug', async () => {
    const outputDir = await setupOutputDir([RESOURCES]);
    await writeSkillMd(outputDir, ['# Skill', '', 'See [readme](resources/README.md).'].join('\n'));

    const issues = await checkBrokenPackagedLinks(outputDir);
    const broken = issues.find((i) => i.code === 'PACKAGED_BROKEN_LINK');

    expect(broken).toBeDefined();
    expect(broken?.message ?? broken?.fix ?? '').toMatch(/never packaged/i);
  });

  it('should skip external URLs', async () => {
    const outputDir = await setupOutputDir();
    await writeSkillMd(
      outputDir,
      ['# Skill', '', 'See [docs](https://example.com).'].join('\n'),
    );

    const issues = await checkBrokenPackagedLinks(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should skip anchor-only links', async () => {
    const outputDir = await setupOutputDir();
    await writeSkillMd(
      outputDir,
      [
        '# Skill',
        '',
        'See [section](#details).',
        '',
        '## Details',
        '',
        'Content.',
      ].join('\n'),
    );

    const issues = await checkBrokenPackagedLinks(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should check links in nested markdown files', async () => {
    const outputDir = await setupOutputDir([RESOURCES]);
    await writeSkillMd(outputDir, GUIDE_LINK_BODY);
    await writeResource(
      outputDir,
      `${RESOURCES}/guide.md`,
      ['# Guide', '', 'See [missing](missing.md).'].join('\n'),
    );

    const issues = await checkBrokenPackagedLinks(outputDir);
    expectSingleIssue(issues, 'PACKAGED_BROKEN_LINK', 'missing.md');
    expect(issues[0]!.location).toContain('guide.md');
  });

  it('should skip link-like patterns inside fenced code blocks', async () => {
    const outputDir = await setupOutputDir();
    // Fenced code block with a link-like pattern and a Mustache placeholder —
    // neither should be treated as a real markdown link.
    await writeSkillMd(
      outputDir,
      [
        '# Skill',
        '',
        'Example usage:',
        '',
        '```markdown',
        'See [example]({{link.href}}) for details.',
        '[text](does-not-exist.md)',
        '```',
        '',
        'End of example.',
      ].join('\n'),
    );

    const issues = await checkBrokenPackagedLinks(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should skip link-like patterns inside inline code spans', async () => {
    const outputDir = await setupOutputDir();
    // Inline code span containing a link-like pattern — should be ignored.
    await writeSkillMd(
      outputDir,
      ['# Skill', '', 'Syntax: `[text](path.md)` is a markdown link.'].join('\n'),
    );

    const issues = await checkBrokenPackagedLinks(outputDir);
    expect(issues).toHaveLength(0);
  });

  // C1 fix (#126): directory links should NOT be flagged as broken when the
  // directory exists on disk (walkDir only tracks files, never directories).
  it('should NOT flag a navigational directory link when the target directory exists', async () => {
    const outputDir = await setupOutputDir(['refs']);
    await writeSkillMd(
      outputDir,
      ['# Skill', '', 'See [refs](refs/).'].join('\n'),
    );
    // Add a file inside refs/ so walkDir has something to find there
    await writeResource(outputDir, 'refs/overview.md', '# Refs\n');

    const issues = await checkBrokenPackagedLinks(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should still flag a navigational directory link when the target directory does not exist', async () => {
    const outputDir = await setupOutputDir();
    await writeSkillMd(
      outputDir,
      ['# Skill', '', 'See [gone](gone/).'].join('\n'),
    );

    const issues = await checkBrokenPackagedLinks(outputDir);
    expectSingleIssue(issues, 'PACKAGED_BROKEN_LINK', 'gone/');
  });
});
