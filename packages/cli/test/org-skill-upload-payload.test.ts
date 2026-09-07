/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * What `vat claude org skills install` publishes, refuses, and reports.
 *
 * The command documents "a built skill directory" as its input, but nothing
 * stops an operator handing it the *source* tree — where the eval suite (the
 * answer key) lives. Publishing to an organization is the widest blast radius
 * in the lifecycle, so the exclusion is enforced here rather than assumed.
 *
 * Every assertion about the payload is on the COLLECTED FILE SET — "is the
 * answer key in the payload?" — never on a directory name. An earlier version of
 * this suite asserted `excludedDirs).toContain('evals')`, which is satisfied by a
 * hardcoded name match and therefore could not see the leak this suite now
 * covers: an adopter whose config declares its suite somewhere other than
 * `evals/`.
 *
 * The suite then covers the three other things this command can get wrong
 * without anyone noticing: an upload it should have refused before spending it,
 * a `<source>` argument resolved by a POSIX-only test, and a run in which every
 * upload failed that still reported `status: success`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { API_SKILL_MAX_UPLOAD_BYTES } from '@vibe-agent-toolkit/agent-skills';
import { ApiRequestError, ApiTransportError, buildMultipartFormData } from '@vibe-agent-toolkit/claude-marketplace';
import type { MultipartFile, OrgApiClient } from '@vibe-agent-toolkit/claude-marketplace';
import type { SymlinkCapability } from '@vibe-agent-toolkit/utils';
import {
  createSymlink,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  symlinkCapability,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildOrgCommandEnding } from '../src/commands/claude/org/helpers.js';
import type { SkillUploadResult } from '../src/commands/claude/org/skills.js';
import {
  buildUploadBodyOrRefuse,
  collectSkillUploadFiles,
  EXISTING_VERSIONS_REFUSAL,
  explainAnsweredNothing,
  findSkillsDir,
  installFromLocal,
  listNodeModulePackages,
  mergeDeleteReport,
  readCreateSkillResponse,
  readDeleteResponse,
  readSkillVersionResponse,
  reportDelete,
  resolveSourceArgument,
  SKILL_DELETED_TYPES,
  SKILL_VERSION_DELETED_TYPES,
  summarizeNpmInstall,
  VERSION_NAME_MISMATCH_REFUSAL,
  withRemedy,
} from '../src/commands/claude/org/skills.js';

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-org-upload-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** An eval suite's `expected_output` — the thing that must never be published. */
const ANSWER_KEY = '{"evals":[{"prompt":"2+2?","expected_output":"FAKE-ANSWER-KEY-4"}]}';

/** A stand-in `created_at`; nothing under test reads its value. */
const CREATED_AT = '2026-09-06T00:00:00Z';

/** Bytes standing in for a ZIP archive. Nothing in the uploader parses them. */
const ZIP_STAND_IN = 'stand-in for zip bytes';

/** Write a file, creating parent directories as needed. */
function writeAt(root: string, relPath: string, content: string): void {
  const abs = safePath.join(root, relPath);
  mkdirSyncReal(safePath.join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** The publishable content every fixture skill shares. */
function writeSkillContent(skillDir: string, name: string): void {
  mkdirSyncReal(skillDir, { recursive: true });
  writeAt(skillDir, 'SKILL.md', `---\nname: ${name}\ndescription: Sample.\n---\n\n# ${name}\n`);
  writeAt(skillDir, 'resources/guide.md', '# Guide\n');
}

/** A skill source tree with no VAT config: real content plus the conventional suite. */
function createSourceTree(name: string): string {
  const root = safePath.join(tempDir, name);
  writeSkillContent(root, 'sample');
  writeAt(root, 'evals/evals.json', ANSWER_KEY);
  writeAt(root, 'evals/fixtures/input.txt', 'fixture');
  writeAt(root, 'node_modules/dep/index.js', 'module.exports = {};');
  writeAt(root, '.git/config', '[core]\n');
  return root;
}

/**
 * An adopter project whose `vibe-agent-toolkit.config.yaml` declares its eval
 * suite at `evalsSubpath` (relative to the skill dir), with the answer key
 * actually written there. Returns the skill directory an operator would point
 * the uploader at.
 */
function createAdopterProject(dirName: string, evalsSubpath: string): string {
  const projectRoot = safePath.join(tempDir, dirName);
  mkdirSyncReal(projectRoot, { recursive: true });
  writeAt(projectRoot, 'vibe-agent-toolkit.config.yaml', [
    'version: 1',
    'skills:',
    '  include: ["skills/**/SKILL.md"]',
    '  config:',
    '    sample:',
    '      test:',
    `        evals: ${evalsSubpath}`,
    '',
  ].join('\n'));

  const skillDir = safePath.join(projectRoot, 'skills', 'sample');
  writeSkillContent(skillDir, 'sample');
  writeAt(skillDir, evalsSubpath, ANSWER_KEY);
  return skillDir;
}

/** Relative paths in the upload payload. */
async function uploadedPaths(skillDir: string): Promise<string[]> {
  const collected = await collectSkillUploadFiles(skillDir);
  return collected.files.map((f) => f.relativePath);
}

describe('collectSkillUploadFiles', () => {
  it('never uploads a declared eval suite that lives outside evals/', async () => {
    const skillDir = createAdopterProject('declared-elsewhere', 'fixtures/qa/evals.json');

    const paths = await uploadedPaths(skillDir);

    expect(paths).toContain('SKILL.md');
    expect(paths.some((p) => p.endsWith('evals.json'))).toBe(false);
    expect(paths.some((p) => p.includes('qa'))).toBe(false);
  });

  it('never uploads a suite declared as a bare file at the skill root', async () => {
    const skillDir = createAdopterProject('declared-at-root', 'answers.json');

    const paths = await uploadedPaths(skillDir);

    expect(paths).toContain('SKILL.md');
    expect(paths).not.toContain('answers.json');
  });

  it('never uploads the conventional eval suite, node_modules, or .git', async () => {
    const paths = await uploadedPaths(createSourceTree('source-tree'));

    expect(paths).toContain('SKILL.md');
    expect(paths).toContain(safePath.join('resources', 'guide.md'));
    expect(paths.some((p) => p.includes('evals'))).toBe(false);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
  });

  it('still withholds the conventional evals/ when no config is discoverable', async () => {
    // No vibe-agent-toolkit.config.yaml anywhere up the tree: the backstop must
    // fail SAFE rather than fall back to uploading everything.
    const collected = await collectSkillUploadFiles(createSourceTree('no-config'));

    expect(collected.files.some((f) => f.relativePath.includes('evals'))).toBe(false);
    expect(collected.excluded).toContain('evals');
  });

  it('reports every exclusion, so the skip is never silent', async () => {
    const conventional = await collectSkillUploadFiles(createSourceTree('reported'));
    expect(conventional.excluded).toContain('evals');
    expect(conventional.excluded).toContain('node_modules');
    expect(conventional.excluded).toContain('.git');

    const declared = await collectSkillUploadFiles(
      createAdopterProject('reported-declared', 'fixtures/qa/evals.json'),
    );
    expect(declared.excluded).toContain(safePath.join('fixtures', 'qa'));
  });

  it('excludes an eval suite nested below the skill root too', async () => {
    const root = safePath.join(tempDir, 'nested');
    mkdirSyncReal(root, { recursive: true });
    writeAt(root, 'SKILL.md', '---\nname: nested\ndescription: Nested.\n---\n\n# nested\n');
    writeAt(root, 'resources/evals/evals.json', ANSWER_KEY);

    const collected = await collectSkillUploadFiles(root);

    expect(collected.files.map((f) => f.relativePath)).toEqual(['SKILL.md']);
    expect(collected.excluded).toContain(safePath.join('resources', 'evals'));
  });

  it('leaves a correctly built skill directory untouched', async () => {
    const root = safePath.join(tempDir, 'built');
    writeSkillContent(root, 'built');

    const collected = await collectSkillUploadFiles(root);

    expect(collected.files).toHaveLength(2);
    expect(collected.excluded).toEqual([]);
  });
});

// ── Which tree `--from-npm` decides to publish ─────────────────────────

/** A package directory under `tempDir` with the given relative directories created. */
function packageWith(name: string, dirs: readonly string[]): string {
  const root = safePath.join(tempDir, name);
  mkdirSyncReal(root, { recursive: true });
  for (const dir of dirs) mkdirSyncReal(safePath.join(root, dir), { recursive: true });
  return root;
}

/**
 * `--from-npm` publishes to a shared org workspace, and NOTHING that decides
 * which directory it publishes had a test. `packages/cli/src/commands/**` is
 * coverage-excluded, so no report said so either.
 */
describe('finding the built skills inside a downloaded package', () => {
  it('prefers the package\'s own dist/skills over anything in node_modules', () => {
    const root = packageWith('own-dist', ['dist/skills', 'node_modules/dep/dist/skills']);

    expect(findSkillsDir(root)).toBe(safePath.join(root, 'dist', 'skills'));
  });

  it('falls back to a dependency that ships built skills', () => {
    const root = packageWith('via-dep', ['node_modules/dep/dist/skills']);

    expect(findSkillsDir(root)).toBe(safePath.join(root, 'node_modules', 'dep', 'dist', 'skills'));
  });

  it('finds a SCOPED dependency, which is one directory deeper', () => {
    const root = packageWith('via-scope', ['node_modules/@scope/pkg/dist/skills']);

    expect(findSkillsDir(root)).toBe(
      safePath.join(root, 'node_modules', '@scope', 'pkg', 'dist', 'skills'),
    );
  });

  it('returns undefined when the package ships no built skills at all', () => {
    expect(findSkillsDir(packageWith('no-skills', ['dist', 'src']))).toBeUndefined();
  });

  it('lists scoped and unscoped packages, and nothing when there is no node_modules', () => {
    const root = packageWith('listing', ['node_modules/plain', 'node_modules/@scope/inner']);
    const nodeModules = safePath.join(root, 'node_modules');

    const byCodePoint = (a: string, b: string): number => (a < b ? -1 : Number(a > b));
    expect(listNodeModulePackages(nodeModules).sort(byCodePoint)).toEqual([
      safePath.join(nodeModules, '@scope', 'inner'),
      safePath.join(nodeModules, 'plain'),
    ].sort(byCodePoint));
    expect(listNodeModulePackages(safePath.join(tempDir, 'nope', 'node_modules'))).toEqual([]);
  });
});

// ── A symlinked directory inside a bundle ──────────────────────────────

/**
 * Proof this process may create symlinks at all, or `null`.
 *
 * On Windows that is a privilege on the process token, not a property of the
 * OS, so it is probed rather than branched on `process.platform` — and the
 * whole suite is SKIPPED (visibly, in the report) rather than silently
 * no-opping into a green run for a property nobody exercised.
 */
const SYMLINK_CAP = symlinkCapability();

/** A skill directory containing `linkName` pointing at a real directory. */
function createTreeWithLinkedDir(
  cap: SymlinkCapability,
  dirName: string,
  linkName: string,
): string {
  const root = safePath.join(tempDir, dirName);
  writeSkillContent(root, 'sample');
  const target = safePath.join(tempDir, `${dirName}-target`);
  writeAt(target, 'inner.md', '# inner\n');
  createSymlink(cap, target, safePath.join(root, linkName), 'dir');
  return root;
}

describe.skipIf(SYMLINK_CAP === null)('a symlinked directory in the bundle', () => {
  // Non-null inside this block: the suite does not run when the probe said no.
  const cap = SYMLINK_CAP as SymlinkCapability;

  /**
   * `Dirent.isDirectory()` is lstat-based, so a link to a directory answers
   * `false` and used to fall into the FILE branch — where `readFileSync` threw a
   * raw `EISDIR` and the upload died on a Node error naming no path.
   */
  it('is refused by name, not left to crash the read', async () => {
    const root = createTreeWithLinkedDir(cap, 'linked-dir', 'shared');

    await expect(collectSkillUploadFiles(root)).rejects.toThrow(/shared/);
    await expect(collectSkillUploadFiles(root)).rejects.not.toThrow(/EISDIR/);
  });

  /**
   * The never-uploaded names are never published whatever their type, and the
   * build-time size walk weighs a linked directory as zero bytes either way — so
   * excluding it keeps both lanes on the same payload instead of blocking a
   * publish over a directory neither lane would have sent.
   */
  it('is excluded, and reported, when it carries a never-uploaded name', async () => {
    const collected = await collectSkillUploadFiles(
      createTreeWithLinkedDir(cap, 'linked-node-modules', 'node_modules'),
    );

    expect(collected.files.map((f) => f.relativePath)).toContain('SKILL.md');
    expect(collected.excluded).toContain('node_modules');
  });

  /** A dangling link cannot be read either, and must say so rather than ENOENT. */
  it('refuses a dangling link by name', async () => {
    const root = safePath.join(tempDir, 'dangling');
    writeSkillContent(root, 'sample');
    createSymlink(cap, safePath.join(tempDir, 'no-such-target'), safePath.join(root, 'gone'), 'dir');

    await expect(collectSkillUploadFiles(root)).rejects.toThrow(/gone/);
  });
});

// ── A symlinked FILE inside a bundle: the egress case ──────────────────

/**
 * 🚨 DATA EGRESS, found by an independent security review.
 *
 * The collector refused only a link resolving to a DIRECTORY. A link to a FILE
 * fell through both branches, was pushed as an ordinary file, and `readFileSync`
 * returned the TARGET's bytes — so `notes.md -> /etc/passwd` was posted under the
 * in-bundle name `notes.md` into a workspace every org member can read. Nothing
 * in the run said a link had been followed: the collector's "every withholding is
 * reported" guarantee covers exclusions, not dereferences.
 *
 * The vector is a directory extracted with system `tar` (which recreates an
 * absolute linkpath) or cloned from an untrusted repo, then handed to
 * `install <dir>`. node-tar 7 de-roots such a link, so a registry tarball cannot
 * plant one — the defence lived in a dependency's default and not in this code.
 */
describe.skipIf(SYMLINK_CAP === null)('a symlinked file in the bundle', () => {
  const cap = SYMLINK_CAP as SymlinkCapability;

  /** A skill directory whose `linkName` points at a real file OUTSIDE it. */
  function createTreeWithLinkedFile(dirName: string, linkName: string): string {
    const root = safePath.join(tempDir, dirName);
    writeSkillContent(root, 'sample');
    const outside = safePath.join(tempDir, `${dirName}-secret.txt`);
    writeFileSync(outside, 'SECRET-OUTSIDE-THE-BUNDLE\n', 'utf-8');
    createSymlink(cap, outside, safePath.join(root, linkName), 'file');
    return root;
  }

  it('refuses it rather than reading through it', async () => {
    const root = createTreeWithLinkedFile('linked-file', 'notes.md');

    await expect(collectSkillUploadFiles(root)).rejects.toThrow(/notes\.md/);
  });

  it('never places the link, or its target bytes, in the payload', async () => {
    const root = createTreeWithLinkedFile('linked-file-payload', 'notes.md');

    // The whole collection fails, so nothing is uploaded — which is the point:
    // a partial payload that silently dropped the link would be the "skipping"
    // outcome the collector's reporting guarantee rules out.
    await expect(collectSkillUploadFiles(root)).rejects.toThrow(/symbolic link/);
  });

  /** A link that stays inside the bundle is refused too — one rule, no exceptions. */
  it('refuses a link pointing at a file inside the same bundle', async () => {
    const root = safePath.join(tempDir, 'linked-file-internal');
    writeSkillContent(root, 'sample');
    createSymlink(
      cap,
      safePath.join(root, 'resources', 'guide.md'),
      safePath.join(root, 'alias.md'),
      'file',
    );

    await expect(collectSkillUploadFiles(root)).rejects.toThrow(/alias\.md/);
  });
});

// ── The pre-flight upload ceiling ──────────────────────────────────────

/** A multipart entry of exactly `bytes` bytes, for measuring the gate. */
function sizedFile(filename: string, bytes: number): MultipartFile {
  return { fieldName: 'files[]', filename, content: Buffer.alloc(bytes) };
}

/** An upload logger that keeps every line, so a test can assert on them. */
function recordingLogger(): { info: (msg: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    info: (msg: string) => {
      lines.push(msg);
    },
    lines,
  };
}

/**
 * A client that fails the test if the network is reached.
 *
 * The whole point of a PRE-flight check is that it spends nothing. An assertion
 * on the thrown message alone would pass just as happily if the refusal had
 * happened after the whole body went over the wire — which is the 11-second
 * round trip this check exists to avoid.
 */
function clientThatMustNotBeCalled(): OrgApiClient {
  const refuse = (): never => {
    throw new Error('NETWORK REACHED: the pre-flight check did not refuse first');
  };
  return { uploadSkill: refuse, uploadSkillVersion: refuse } as unknown as OrgApiClient;
}

/** A client whose create call succeeds, for the paths that get as far as sending. */
function clientReturningSkill(): OrgApiClient {
  return {
    uploadSkill: () => Promise.resolve({
      id: 'skill_1', type: 'skill', display_title: 'small',
      latest_version: '17', created_at: CREATED_AT,
    }),
  } as unknown as OrgApiClient;
}

/** The one heavy file most of these fixtures are built around. */
const BLOB_PATH = 'big/blob.wasm';

/** The sum the OLD gate compared against the ceiling: file bytes, no framing. */
function fileBytes(files: readonly MultipartFile[]): number {
  return files.reduce((sum, f) => sum + f.content.length, 0);
}

/**
 * The file-content bytes that make the multipart body EXACTLY `target` bytes.
 *
 * Derived by asking the SHIPPED builder how much framing it puts around this
 * exact part list, never by restating "156 bytes plus the filename" here: a
 * second copy of that arithmetic would agree with the builder only by
 * coincidence, and would keep agreeing right up until somebody changed a header.
 * The boundary is randomly generated but constant in LENGTH, so the overhead is
 * deterministic.
 */
function contentBytesForBodyOf(target: number, filename: string): number {
  return target - buildMultipartFormData({}, [sizedFile(filename, 0)]).body.length;
}

describe('buildUploadBodyOrRefuse', () => {
  /**
   * The ceiling is INCLUSIVE, and that is MEASURED against the live API rather
   * than reasoned about:
   *
   * | raw file bytes | + framing | = body   | API result |
   * |---|---|---|---|
   * | 31,456,735 | 545 | **31,457,280** | `status: success` |
   * | 31,456,736 | 545 | 31,457,281     | `413` |
   *
   * This pair used to assert the opposite — that the gate fires AT the ceiling —
   * on the argument that doing so was the conservative reading. It is not
   * conservative, it is wrong in the one direction that costs an operator an
   * upload the API would have taken, with no way to tell that VAT and not
   * Anthropic refused it.
   *
   * The BUILD-time lane keeps firing at its own ceiling and is right to: it
   * weighs FILE bytes, and files totalling exactly the limit always frame up into
   * a request LARGER than the limit. Two measures, two rules, on purpose.
   */
  it('accepts a body of EXACTLY the ceiling — the boundary is measured, not assumed', () => {
    const content = contentBytesForBodyOf(API_SKILL_MAX_UPLOAD_BYTES, BLOB_PATH);
    const multipart = buildUploadBodyOrRefuse({}, [sizedFile(BLOB_PATH, content)]);

    expect(multipart.body).toHaveLength(API_SKILL_MAX_UPLOAD_BYTES);
  });

  it('refuses a body ONE BYTE over the ceiling', () => {
    const content = contentBytesForBodyOf(API_SKILL_MAX_UPLOAD_BYTES, BLOB_PATH) + 1;

    expect(() => buildUploadBodyOrRefuse({}, [sizedFile(BLOB_PATH, content)]))
      .toThrow(/upload ceiling/);
  });

  /**
   * THE fix. The API weighs the REQUEST; this gate used to weigh the sum of
   * `file.content.length`. A bundle one byte under the ceiling in file bytes is
   * over it as a request — so it passed the pre-flight and then earned the 413
   * the check exists to prevent, after the whole body went over the wire (11s
   * for 30 MB, measured).
   */
  it('refuses a bundle whose FILE BYTES are under the ceiling but whose BODY is over', () => {
    const files = [sizedFile(BLOB_PATH,API_SKILL_MAX_UPLOAD_BYTES - 1)];
    expect(fileBytes(files)).toBeLessThan(API_SKILL_MAX_UPLOAD_BYTES);

    expect(() => buildUploadBodyOrRefuse({ display_title: 'big' }, files))
      .toThrow(/upload ceiling/);
  });

  /**
   * The same defect at the shape that makes it large rather than marginal: the
   * framing is ~156 bytes plus the filename PER PART, so a 1,000-file bundle
   * carries ~180 KiB of boundaries and headers. Here the file bytes are a
   * comfortable 100 kB under the ceiling and the request is still over it —
   * which no "few hundred bytes" reading of the framing would predict.
   */
  it('refuses when per-part framing across many files is what crosses the ceiling', () => {
    const each = Math.floor((API_SKILL_MAX_UPLOAD_BYTES - 100_000) / 1000);
    const files = Array.from({ length: 1000 }, (_, i) =>
      sizedFile(`my-skill/resources/file${String(i)}.md`, each));
    expect(API_SKILL_MAX_UPLOAD_BYTES - fileBytes(files)).toBeGreaterThan(100_000);

    expect(() => buildUploadBodyOrRefuse({ display_title: 'my-skill' }, files))
      .toThrow(/upload ceiling/);
  });

  it('reports the request size AND the file bytes, so the framing is legible', () => {
    expect(() => buildUploadBodyOrRefuse({}, [sizedFile(BLOB_PATH,API_SKILL_MAX_UPLOAD_BYTES)]))
      .toThrow(/Upload request body is .* of file content across 1 file, plus per-part multipart framing/);
  });

  /**
   * The gate returns the very buffer it weighed, so nothing can be measured and
   * then something else sent. A gate that only inspected its inputs would be one
   * refactor away from weighing a body the caller then rebuilt differently.
   */
  it('returns the body it measured, so what was weighed is what is sent', () => {
    const multipart = buildUploadBodyOrRefuse({ display_title: 'a' }, [sizedFile('a/one.bin', 10)]);

    expect(multipart.body.length).toBeGreaterThan(10);
    expect(multipart.body.includes(Buffer.from('a/one.bin'))).toBe(true);
    expect(multipart.contentType).toContain(multipart.boundary);
  });

  it('measures the whole bundle, not the largest file in it', () => {
    const half = Math.ceil(API_SKILL_MAX_UPLOAD_BYTES / 2);
    expect(() => buildUploadBodyOrRefuse({}, [
      sizedFile('a/one.bin', half),
      sizedFile('a/two.bin', half),
    ])).toThrow(/upload ceiling/);
  });

  it('names the largest file, so the operator knows what to remove', () => {
    expect(() => buildUploadBodyOrRefuse({}, [
      sizedFile('a/tiny.md', 10),
      sizedFile('a/runtime.wasm', API_SKILL_MAX_UPLOAD_BYTES),
    ])).toThrow(/runtime\.wasm/);
  });

  it('lets a bundle comfortably under the ceiling through', () => {
    expect(() => buildUploadBodyOrRefuse({ display_title: 'small' }, [sizedFile('a/one.bin', 1024)]))
      .not.toThrow();
  });

  /**
   * The refusal names files in the SAME namespace `PACKAGED_SIZE_EXCEEDS_API_LIMIT`
   * does, so a path copied out of one message matches a `validation.allow` entry
   * written from the other.
   *
   * A directory's parts are keyed `<declared-name>/<bundle-relative-path>` because
   * that is how the API roots them; the build-time finding is bundle-relative. The
   * uploader printed the keyed spelling, so the two never matched.
   */
  it('names files bundle-relative, stripping the root the API keys them under', () => {
    const message = (() => {
      try {
        buildUploadBodyOrRefuse({}, [
          sizedFile('my-skill/scripts/runtime.wasm', API_SKILL_MAX_UPLOAD_BYTES),
        ], 'my-skill');
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();

    expect(message).toContain('scripts/runtime.wasm');
    expect(message).not.toContain('my-skill/scripts/runtime.wasm');
  });

  it('leaves a ZIP part alone — one part named for the archive, with no root to strip', () => {
    // No `bundleRoot`, because a ZIP has none. Stripping a leading segment here
    // would eat the filename itself.
    expect(() => buildUploadBodyOrRefuse({}, [sizedFile('big.zip', API_SKILL_MAX_UPLOAD_BYTES)]))
      .toThrow(/big\.zip/);
  });
});

describe('installFromLocal ceiling enforcement', () => {
  /**
   * The ZIP branch is the one input that is by construction a single large
   * binary, and it reached the wire unmeasured while the check lived only in the
   * directory-packaging path. It runs through the SAME gate as the directory
   * path now — and this fixture's file bytes are one byte UNDER the ceiling, so
   * only a gate that weighs the multipart body refuses it.
   */
  it('refuses a ZIP whose body — not its file bytes — crosses the ceiling', async () => {
    const zipPath = safePath.join(tempDir, 'over-ceiling.zip');
    writeFileSync(zipPath, Buffer.alloc(API_SKILL_MAX_UPLOAD_BYTES - 1));

    await expect(
      installFromLocal(zipPath, undefined, clientThatMustNotBeCalled(), recordingLogger()),
    ).rejects.toThrow(/upload ceiling/);
  });

  /**
   * Doubles as the F7 pin: this run refuses LOCALLY, so no line printed before
   * the refusal may claim an upload started. The measured complaint was a log
   * reading `Uploading skill directory: …` immediately above a local size
   * refusal — the operator was told about work that never happened.
   */
  it('refuses an over-ceiling directory before contacting the API, and never claims it uploaded', async () => {
    const skillDir = safePath.join(tempDir, 'over-ceiling-dir');
    writeSkillContent(skillDir, 'sample');
    writeFileSync(safePath.join(skillDir, 'runtime.wasm'), Buffer.alloc(API_SKILL_MAX_UPLOAD_BYTES));
    const logger = recordingLogger();

    await expect(
      installFromLocal(skillDir, undefined, clientThatMustNotBeCalled(), logger),
    ).rejects.toThrow(/upload ceiling/);

    const log = logger.lines.join('\n');
    expect(log).toContain('Packaging skill directory:');
    expect(log).not.toMatch(/Uploading/);
  });

  it('sends an under-ceiling ZIP', async () => {
    const zipPath = safePath.join(tempDir, 'small.zip');
    writeFileSync(zipPath, Buffer.from('stand-in for zip bytes; nothing here parses them'));

    await expect(installFromLocal(zipPath, undefined, clientReturningSkill(), recordingLogger()))
      .resolves.toMatchObject({ id: 'skill_1', version: '17' });
  });

  /**
   * `endsWith('.zip')` is case-SENSITIVE, so `MySkill.ZIP` — a file both Windows
   * and macOS treat as a zip archive — was refused as "not a directory or .zip
   * file", a message an operator has no way to read as being about
   * capitalisation.
   */
  it('accepts an uppercase .ZIP, and titles it without the extension', async () => {
    const zipPath = safePath.join(tempDir, 'Loud.ZIP');
    writeFileSync(zipPath, Buffer.from(ZIP_STAND_IN));
    const logger = recordingLogger();

    await expect(installFromLocal(zipPath, undefined, clientReturningSkill(), logger)).resolves.toBeDefined();
    // `basename(path, '.zip')` matches the extension exactly, so the literal
    // would have left `.ZIP` glued to the title.
    expect(logger.lines.join('\n')).toContain('Display title: "Loud"');
  });
});

// ── What the progress log claims, and when ─────────────────────────────

describe('the upload progress log', () => {
  /**
   * A ZIP's display title is the FILENAME — nothing reads the SKILL.md inside
   * the archive — so `wiki-lint-v2.zip` publishes a skill titled `wiki-lint-v2`,
   * a different skill from `wiki-lint`, and the API does not refuse it because
   * display_title uniqueness is enforced only when the field is sent. VAT cannot
   * cheaply read the declared name out of the archive (Node ships no ZIP
   * reader), so the provenance is DISCLOSED rather than fixed, and this pins the
   * disclosure.
   */
  it('says a ZIP took its display title from the filename', async () => {
    const zipPath = safePath.join(tempDir, 'wiki-lint-v2.zip');
    writeFileSync(zipPath, Buffer.from(ZIP_STAND_IN));
    const logger = recordingLogger();

    await installFromLocal(zipPath, undefined, clientReturningSkill(), logger);

    const log = logger.lines.join('\n');
    expect(log).toContain('Display title: "wiki-lint-v2" (from the ZIP filename');
    expect(log).toContain('NOT from the SKILL.md inside it');
    // Nothing had been sent when this printed, so it must not say "Uploading".
    expect(log).toContain('Preparing ZIP:');
  });

  it('attributes an overridden title to --title', async () => {
    const zipPath = safePath.join(tempDir, 'wiki-lint-v3.zip');
    writeFileSync(zipPath, Buffer.from(ZIP_STAND_IN));
    const logger = recordingLogger();

    await installFromLocal(zipPath, 'Wiki Lint', clientReturningSkill(), logger);

    expect(logger.lines.join('\n')).toContain('Display title: "Wiki Lint" (from --title)');
  });

  /** `1 files` was shipped. Every count this line prints is regular. */
  it('counts one file as "1 file"', async () => {
    const dir = safePath.join(tempDir, 'one-file-skill');
    mkdirSyncReal(dir, { recursive: true });
    writeAt(dir, 'SKILL.md', '---\nname: solo\ndescription: Sample.\n---\n\n# solo\n');
    const logger = recordingLogger();

    await installFromLocal(dir, undefined, clientReturningSkill(), logger);

    expect(logger.lines.join('\n')).toContain('solo: 1 file,');
  });

  it('counts two files as "2 files"', async () => {
    const dir = safePath.join(tempDir, 'two-file-skill');
    writeSkillContent(dir, 'duo');
    const logger = recordingLogger();

    await installFromLocal(dir, undefined, clientReturningSkill(), logger);

    expect(logger.lines.join('\n')).toContain('duo: 2 files,');
  });
});

// ── A vendor refusal that has a specific next command ──────────────────

/** A client whose create call fails the way the live API does. */
function clientRejectingWith(error: unknown): OrgApiClient {
  return { uploadSkill: () => Promise.reject(error) } as unknown as OrgApiClient;
}

/** A minimal built skill directory, for tests that get as far as the request. */
function smallSkillDir(name: string): string {
  const dir = safePath.join(tempDir, name);
  writeSkillContent(dir, 'sample');
  return dir;
}

describe('a display_title already taken', () => {
  /**
   * Measured against the live API: a multipart POST carrying
   * `display_title: "wiki-lint"` when a skill of that title exists answers
   * `400 Skill cannot reuse an existing display_title`. That is the exact moment
   * the operator wants `versions add`, and the vendor's sentence does not
   * mention it.
   */
  const vendor400 = new ApiRequestError(
    'API error 400: Skill cannot reuse an existing display_title',
    400,
    undefined,
  );

  it('points at versions add, and at how to find the id', async () => {
    const failing = (): Promise<object> => installFromLocal(
      smallSkillDir('dup-title'), undefined, clientRejectingWith(vendor400), recordingLogger(),
    );

    await expect(failing()).rejects.toThrow(/skills versions add/);
    await expect(failing()).rejects.toThrow(/skills list/);
    // The vendor's own words survive; the remedy is added, never substituted.
    await expect(failing()).rejects.toThrow(/cannot reuse an existing display_title/);
  });

  it('never claims VAT can turn the title into an id', async () => {
    // `display_title` is unique only when the field is SENT, so a workspace can
    // hold several skills of one title: a title resolves to none, one, or
    // several, and picking wrong appends a version to somebody else's skill.
    await expect(installFromLocal(
      smallSkillDir('dup-title-2'), undefined, clientRejectingWith(vendor400), recordingLogger(),
    )).rejects.not.toThrow(/automatically|will find|resolved the/);
  });

  it('leaves an unrelated 400 exactly as the API worded it', async () => {
    const unrelated = new ApiRequestError(
      'API error 400: invalid_request_error: files[] is required', 400, undefined,
    );
    const failing = (): Promise<object> => installFromLocal(
      smallSkillDir('other-400'), undefined, clientRejectingWith(unrelated), recordingLogger(),
    );

    await expect(failing()).rejects.toThrow(/files\[] is required/);
    await expect(failing()).rejects.not.toThrow(/versions add/);
  });

  it('leaves a non-400 failure alone, even one that mentions the title', async () => {
    const notFour = new ApiRequestError(
      'API error 500: display_title handler crashed', 500, undefined,
    );

    await expect(installFromLocal(
      smallSkillDir('five-hundred'), undefined, clientRejectingWith(notFour), recordingLogger(),
    )).rejects.not.toThrow(/versions add/);
  });
});

// ── A delete refusal that has a specific next command ──────────────────

describe('a skill that still has versions', () => {
  /**
   * Measured live, and the other half of a fix that only ever landed on the
   * create path:
   *
   *   $ vat claude org skills delete skill_01YE6TZqhCcfnCeEcT3tFzH3
   *   OrgSkillsDelete failed: API error 400: Cannot delete skill with existing
   *   versions. Delete all versions first.
   *
   * The vendor's sentence is correct and names no VAT command. `--all` is the
   * one that does both steps, and this command already implements it.
   */
  const vendor400 = new ApiRequestError(
    'API error 400: Cannot delete skill with existing versions. Delete all versions first.',
    400,
    undefined,
  );

  /** What a `delete` run without `--all` carries. */
  const remedies = [EXISTING_VERSIONS_REFUSAL];

  it('names --all as the one-step path, and the by-hand commands after it', () => {
    const message = (withRemedy(vendor400, remedies) as Error).message;

    expect(message).toContain('--all');
    expect(message).toContain('vat claude org skills versions delete');
    expect(message).toContain('vat claude org skills versions list');
    // The vendor's own words survive; the remedy is appended, never substituted.
    expect(message).toContain('Cannot delete skill with existing versions');
  });

  it('adds nothing when this run already deleted the versions', () => {
    // A `--all` run carries NO remedies, because pointing an operator who just
    // watched --all delete every version back at --all is the loop this remedy
    // exists to break. A refusal after it means something the version listing did
    // not show, and the vendor's sentence is then the honest whole of it.
    expect(withRemedy(vendor400, [])).toBe(vendor400);
  });

  it('leaves an unrelated 400 exactly as the API worded it', () => {
    const unrelated = new ApiRequestError('API error 400: skill_id is malformed', 400, undefined);

    expect(withRemedy(unrelated, remedies)).toBe(unrelated);
  });

  it('leaves a non-400 alone, even one that mentions versions', () => {
    const notFound = new ApiRequestError(
      'API error 404: no such skill, so it has no versions', 404, undefined,
    );

    expect(withRemedy(notFound, remedies)).toBe(notFound);
  });

  /**
   * The conjunction its docstring calls load-bearing, pinned.
   *
   * `matches` are ALL required precisely because a single word like `version`
   * turns up in refusals that have nothing to do with this case. Every negative
   * fixture above fails BOTH patterns, so `every` → `some` survived all of them
   * — and under `some`, this message would collect a confidently wrong remedy
   * telling the operator to re-run with `--all`.
   */
  it('requires EVERY pattern, not just one — a 400 matching half gets no remedy', () => {
    const halfMatch = new ApiRequestError(
      'API error 400: this skill has 3 versions, and the latest is malformed', 400, undefined,
    );

    // Matches /versions?/i and nothing in the verdict alternation.
    expect(withRemedy(halfMatch, remedies)).toBe(halfMatch);
  });
});

// ── A version published from a renamed tree ────────────────────────────

/**
 * The server enforces SKILL.md name consistency per `skill_id`, so publishing a
 * version from a tree whose frontmatter `name` changed is a loud 400 — not the
 * "silently re-roots the file tree" the code and help used to warn about. That
 * makes it the ONE refusal `versions add` can earn, and it had no remedy at all:
 * the call site passed `error => error`.
 */
describe('a versions-add name refusal', () => {
  const renamed = new ApiRequestError(
    'API error 400: skill name must match the existing skill', 400, undefined,
  );

  it('offers both fixes: restore the name, or publish it as a new skill', () => {
    const message = (withRemedy(renamed, [VERSION_NAME_MISMATCH_REFUSAL]) as Error).message;

    expect(message).toContain('SKILL.md');
    expect(message).toContain('vat claude org skills install');
    // The vendor's own words survive.
    expect(message).toContain('skill name must match');
  });

  it('leaves an unrelated 400 alone', () => {
    const unrelated = new ApiRequestError('API error 400: files[] is required', 400, undefined);

    expect(withRemedy(unrelated, [VERSION_NAME_MISMATCH_REFUSAL])).toBe(unrelated);
  });
});

// ── A request the server never answered ────────────────────────────────

describe('a transport failure on an upload', () => {
  /**
   * Observed once at the ceiling: `OrgSkillsInstall failed: socket hang up`,
   * with the same input returning a clean 413 twice afterwards. The server drop
   * is not ours to fix; what the client can add is the size it actually sent and
   * the fact that a POST which failed with no status may still have created
   * something. No threshold constant for "near the ceiling" — the two numbers
   * are printed and the reader draws the conclusion.
   */
  it('reports what it sent, the ceiling, and the duplicate risk', () => {
    const hangup = new ApiTransportError('socket hang up', 30_900_000);

    const explained = explainAnsweredNothing(hangup, 31_000_000) as Error;

    expect(explained.message).toContain('socket hang up');
    // The bytes that LEFT THE SOCKET, then the body they were part of.
    expect(explained.message).toContain('29.5 MiB');
    expect(explained.message).toContain('29.6 MiB');
    expect(explained.message).toContain('30.0 MiB');
    expect(explained.message).toContain('never replays a POST');
    expect(explained.message).toContain('vat claude org skills list');
    expect(explained.cause).toBe(hangup);
  });

  it('leaves a completed exchange alone — a 413 is a verdict, not a lost connection', () => {
    const refused = new ApiRequestError('API error 413: requests up to 30MBs', 413, undefined);

    expect(explainAnsweredNothing(refused, 31_457_281)).toBe(refused);
  });

  /**
   * 🚨 The regression this suite existed to have caught and did not.
   *
   * The gate used to be `if (error instanceof ApiRequestError) return error;` —
   * "anything that is not a completed exchange must be a dropped connection".
   * `buildSkillsHeaders()` throws a plain Error BEFORE a socket is opened, so
   * `ANTHROPIC_API_KEY= vat claude org skills install <dir>` told a first-time
   * operator that a connection had closed, that VAT had sent 6.8 KiB, and that
   * the outcome was unknown — then sent them to a recovery command that fails
   * with the same missing-key error. Three false claims and a loop.
   *
   * The old tests pinned a plain `Error('socket hang up')` and a real
   * `ApiRequestError`, and BOTH still pass under the broken gate. Only an error
   * from neither class distinguishes them.
   */
  it('leaves a failure that never reached the transport completely alone', () => {
    const noKey = new Error('ANTHROPIC_API_KEY is required for workspace skills commands.');

    const result = explainAnsweredNothing(noKey, 6_900);

    expect(result).toBe(noKey);
    expect((result as Error).message).not.toContain('connection closed');
  });

  it('says nothing was sent — not "unknown" — when no byte left the socket', () => {
    // A DNS blackhole or a refused connection. The outcome is not unknown here,
    // it is KNOWN: nothing happened. Sending the operator to `skills list` to
    // check for a skill that was never sent is advice about a fiction.
    const dead = new ApiTransportError('getaddrinfo ENOTFOUND api.anthropic.com', 0);

    const explained = explainAnsweredNothing(dead, 6_900) as Error;

    expect(explained.message).toContain('ENOTFOUND');
    expect(explained.message).toContain('No byte of the request left this machine');
    expect(explained.message).not.toContain('unknown');
    expect(explained.message).not.toContain('vat claude org skills list');
  });
});

// ── Where a <source> argument resolves ─────────────────────────────────

describe('resolveSourceArgument', () => {
  it('treats a Windows drive-letter path as absolute on every host', () => {
    // `startsWith('/')` said no and joined it onto cwd, so a Windows operator
    // was told `Source not found: <cwd>/D:/builds/skill`.
    expect(resolveSourceArgument(String.raw`D:\builds\skill`)).toBe('D:/builds/skill');
  });

  it('treats a POSIX absolute path as absolute', () => {
    expect(resolveSourceArgument('/builds/skill')).toBe('/builds/skill');
  });

  it('resolves a relative path against the working directory', () => {
    expect(resolveSourceArgument(safePath.join('dist', 'skills', 'sample')))
      .toBe(safePath.resolve(process.cwd(), 'dist/skills/sample'));
  });
});

// ── What the API said, versus what the output promises ─────────────────

describe('skill upload response readers', () => {
  it('reads the measured create-skill shape', () => {
    expect(readCreateSkillResponse({
      id: 'skill_1', type: 'skill', display_title: 'Sample',
      latest_version: '1775007400733130', created_at: CREATED_AT,
    })).toEqual({
      id: 'skill_1', displayTitle: 'Sample',
      version: '1775007400733130', createdAt: CREATED_AT,
    });
  });

  it('refuses a version response missing the identifier the operator needs', () => {
    // `version` is the value a later `versions delete` takes. Printing
    // `status: success` beside `version: null` is worse than failing.
    expect(() => readSkillVersionResponse({
      type: 'skill_version', skill_id: 'skill_1', id: 'v_1', created_at: CREATED_AT,
    })).toThrow(/version/);
  });

  it('names the keys the endpoint actually returned, so drift is diagnosable', () => {
    expect(() => readSkillVersionResponse({ unexpected_shape: true }))
      .toThrow(/unexpected_shape/);
  });

  it('refuses a body that is not an object at all', () => {
    expect(() => readSkillVersionResponse('OK')).toThrow(/skill_id/);
  });
});

// ── What a DELETE that answered with nothing means ─────────────────────

describe('readDeleteResponse', () => {
  /**
   * The API client now resolves a 2xx carrying an EMPTY body (it used to reject
   * with a parse error, so a 204 DELETE that SUCCEEDED was reported as a
   * failure). That left the command reading `.id` off `undefined`. Measured live
   * behaviour today is a JSON body, so this path is latent — but it is reachable
   * the moment the endpoint answers 204, and a TypeError is not a report.
   */
  it('reports the delete when the API answers with no body at all', () => {
    expect(readDeleteResponse(undefined, 'skill_abc', SKILL_DELETED_TYPES))
      .toEqual({ id: 'skill_abc', deleted: true });
  });

  it('reports the id and type the API echoed', () => {
    expect(readDeleteResponse(
      { id: 'skill_abc', type: 'skill_deleted' }, 'skill_abc', SKILL_DELETED_TYPES,
    )).toEqual({ id: 'skill_abc', deleted: true });
  });

  it('does not claim a delete when the body names a different outcome', () => {
    expect(readDeleteResponse(
      { id: 'skill_abc', type: 'skill_archived' }, 'skill_abc', SKILL_DELETED_TYPES,
    )).toEqual({ id: 'skill_abc', deleted: false });
  });

  it('falls back to the id that was asked for when the body carries none', () => {
    expect(readDeleteResponse({ type: 'skill_deleted' }, 'skill_abc', SKILL_DELETED_TYPES))
      .toEqual({ id: 'skill_abc', deleted: true });
  });

  /**
   * The version endpoint's success `type` has never been measured — only
   * `skill_deleted`, from the SKILL endpoint. A single guessed string would make
   * every `versions delete` report `deleted: false`, and now exit 1, if the
   * vendor spells it differently by one character. Accepting either keeps the
   * check honest about what it knows.
   */
  it('accepts both plausible spellings on the version lane, and only those', () => {
    expect(readDeleteResponse({ type: 'skill_version_deleted' }, 'skill_abc', SKILL_VERSION_DELETED_TYPES).deleted)
      .toBe(true);
    expect(readDeleteResponse({ type: 'skill_deleted' }, 'skill_abc', SKILL_VERSION_DELETED_TYPES).deleted)
      .toBe(true);
    expect(readDeleteResponse({ type: 'skill_version_archived' }, 'skill_abc', SKILL_VERSION_DELETED_TYPES).deleted)
      .toBe(false);
  });
});

// ── A delete the API says did not happen is not a successful run ───────

/**
 * 🚨 `deleted: false` was computed, printed under `status: success`, and exited
 * 0 — the exact "the run completed, its outcome is wrong" shape
 * `orgCommandFailure` was built for, in the one branch nobody wired to it. A CI
 * wrapper spelled `vat claude org skills delete X || fail` reported green while
 * the skill was still there. Two independent reviewers found it.
 */
describe('reportDelete', () => {
  it('exits 0 with status success when the API confirms the delete', () => {
    const result = ending(reportDelete({ id: 'skill_abc', type: 'skill_deleted' }, 'skill_abc', SKILL_DELETED_TYPES));

    expect(result.exitCode).toBe(0);
    expect(result.document['status']).toBe('success');
    expect(result.document['deleted']).toBe(true);
  });

  it('exits 1 with status error when the API names a different outcome', () => {
    const result = ending(reportDelete({ id: 'skill_abc', type: 'skill_archived' }, 'skill_abc', SKILL_DELETED_TYPES));

    expect(result.exitCode).toBe(1);
    expect(result.document['status']).toBe('error');
    // The document is still published: the verdict is what the operator needs.
    expect(result.document['id']).toBe('skill_abc');
    expect(result.document['deleted']).toBe(false);
  });
});

describe('mergeDeleteReport', () => {
  it('adds the versions a --all run destroyed without changing a success', () => {
    const result = ending(mergeDeleteReport({ id: 'skill_abc', deleted: true }, ['v1', 'v2']));

    expect(result.exitCode).toBe(0);
    expect(result.document['deletedVersions']).toEqual(['v1', 'v2']);
  });

  it('keeps the failure tag OUT of the document while preserving the non-zero exit', () => {
    // A naive `{ ...result, deletedVersions }` on a tagged failure publishes
    // `orgCommandFailed` as if it were one of the skill's own fields.
    const failed = reportDelete({ id: 'skill_abc', type: 'skill_archived' }, 'skill_abc', SKILL_DELETED_TYPES);

    const result = ending(mergeDeleteReport(failed, ['v1']));

    expect(result.exitCode).toBe(1);
    expect(result.document['deletedVersions']).toEqual(['v1']);
    expect(result.document).not.toHaveProperty('orgCommandFailed');
    expect(result.document).not.toHaveProperty('document');
  });
});

// ── A run in which uploads failed is not a successful run ──────────────

/** One skill that published, for a batch summary. */
function uploaded(id: string): SkillUploadResult {
  return { id, displayTitle: id, version: '1', createdAt: CREATED_AT };
}

/** The document and exit code `executeOrgCommand` would actually publish. */
function ending(outcome: object): { document: Record<string, unknown>; exitCode: number } {
  return buildOrgCommandEnding(outcome, 5);
}

describe('summarizeNpmInstall', () => {
  it('exits 0 with status success when every skill uploaded', () => {
    const result = ending(summarizeNpmInstall('pkg@1.0.0', [uploaded('a')], []));

    expect(result.exitCode).toBe(0);
    expect(result.document['status']).toBe('success');
    expect(result.document['skillsUploaded']).toBe(1);
  });

  it('does not report success when EVERY skill failed', () => {
    const errors = [
      { skill: 'a', error: '403 forbidden' },
      { skill: 'b', error: 'over the upload ceiling' },
      { skill: 'c', error: 'SKILL.md has no usable frontmatter "name" field' },
    ];
    const result = ending(summarizeNpmInstall('pkg@1.0.0', [], errors));

    expect(result.exitCode).toBe(1);
    expect(result.document['status']).toBe('error');
    expect(result.document['skillsUploaded']).toBe(0);
    expect(result.document['skillsFailed']).toBe(3);
    expect(result.document['errors']).toEqual(errors);
  });

  it('does not report success when SOME skills failed', () => {
    const result = ending(summarizeNpmInstall(
      'pkg@1.0.0',
      [uploaded('a')],
      [{ skill: 'b', error: '413 payload too large' }],
    ));

    expect(result.exitCode).toBe(1);
    expect(result.document['status']).toBe('error');
    // What DID land still has to be readable — the workspace is now mixed.
    expect(result.document['skillsUploaded']).toBe(1);
    expect(result.document['skills']).toHaveLength(1);
  });
});
