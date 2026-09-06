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
import { ApiRequestError } from '@vibe-agent-toolkit/claude-marketplace';
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
  installFromLocal,
  readCreateSkillResponse,
  readDeleteResponse,
  readSkillVersionResponse,
  resolveSourceArgument,
  summarizeNpmInstall,
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

/** The one heavy file most of these fixtures are built around. */
const BLOB_PATH = 'big/blob.wasm';

/** The sum the OLD gate compared against the ceiling: file bytes, no framing. */
function fileBytes(files: readonly MultipartFile[]): number {
  return files.reduce((sum, f) => sum + f.content.length, 0);
}

describe('buildUploadBodyOrRefuse', () => {
  it('refuses a bundle of exactly the ceiling', () => {
    expect(() => buildUploadBodyOrRefuse({}, [sizedFile(BLOB_PATH,API_SKILL_MAX_UPLOAD_BYTES)]))
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

  it('refuses an over-ceiling directory before contacting the API', async () => {
    const skillDir = safePath.join(tempDir, 'over-ceiling-dir');
    writeSkillContent(skillDir, 'sample');
    writeFileSync(safePath.join(skillDir, 'runtime.wasm'), Buffer.alloc(API_SKILL_MAX_UPLOAD_BYTES));

    await expect(
      installFromLocal(skillDir, undefined, clientThatMustNotBeCalled(), recordingLogger()),
    ).rejects.toThrow(/upload ceiling/);
  });

  it('sends an under-ceiling ZIP', async () => {
    const zipPath = safePath.join(tempDir, 'small.zip');
    writeFileSync(zipPath, Buffer.from('stand-in for zip bytes; nothing here parses them'));
    const client = {
      uploadSkill: () => Promise.resolve({
        id: 'skill_1', type: 'skill', display_title: 'small',
        latest_version: '17', created_at: CREATED_AT,
      }),
    } as unknown as OrgApiClient;

    await expect(installFromLocal(zipPath, undefined, client, recordingLogger()))
      .resolves.toMatchObject({ id: 'skill_1', version: '17' });
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
    expect(readDeleteResponse(undefined, 'skill_abc', 'skill_deleted'))
      .toEqual({ id: 'skill_abc', deleted: true });
  });

  it('reports the id and type the API echoed', () => {
    expect(readDeleteResponse(
      { id: 'skill_abc', type: 'skill_deleted' }, 'skill_abc', 'skill_deleted',
    )).toEqual({ id: 'skill_abc', deleted: true });
  });

  it('does not claim a delete when the body names a different outcome', () => {
    expect(readDeleteResponse(
      { id: 'skill_abc', type: 'skill_archived' }, 'skill_abc', 'skill_deleted',
    )).toEqual({ id: 'skill_abc', deleted: false });
  });

  it('falls back to the id that was asked for when the body carries none', () => {
    expect(readDeleteResponse({ type: 'skill_deleted' }, 'skill_abc', 'skill_deleted'))
      .toEqual({ id: 'skill_abc', deleted: true });
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
