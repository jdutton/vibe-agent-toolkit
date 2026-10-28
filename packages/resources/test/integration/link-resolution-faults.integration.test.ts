/**
 * Every resources site that resolves a link, or a path through links, answers "does it resolve?"
 * with the ONE predicate (`isUnresolvableLinkError`, through `linkResolutionFault`): a link that
 * resolves to nothing (`ENOENT`) keeps the site's own answer, and an OS that DECLINED or failed to
 * resolve it (`EACCES`, `EPERM`, `EIO`, and Windows' `UNKNOWN` — libuv `src/win/error.c:172` answers
 * it for a missing share AND for refused credentials) is that ONE target's row or finding, carrying
 * the errno and its class in a code and a column — never "the link leads nowhere", and never the end of
 * the run. These are read lanes: one bad target never rejects a batch or loses another target's
 * finding, and a target outside the tree is answered "outside" whatever refused beneath it. Only the
 * run's own root stops the run.
 *
 * A native realpath on a volume that cannot answer a final-path query (`EISDIR`, Windows'
 * `ERROR_INVALID_FUNCTION`) is asked again of the JS realpath before anything is classified.
 *
 * Real trees, with the refusal injected at the syscall (`installFaultFs` reaches
 * `realpathSync.native`, the callback `realpath` and a named import alike).
 */

import { writeFileSync } from 'node:fs';

import { createSymlink, FS_FAULT_CODE, FsLookupCache, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { installFaultFs, type FaultFsSession, type InjectedErrno } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { fillLinkFacts, fragmentIndex, judgeLink, judgeOptionsFrom, resolveLinkEntries } from '../../src/link-validator.js';
import {
  EXTENT_SYMLINK_NOT_REALIZED,
  EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT,
  EXTENT_SYMLINK_TARGET_UNREADABLE,
  EXTENT_SYMLINK_TARGET_UNRESOLVED,
  FilesystemExtentContributor,
} from '../../src/projection/contributors/filesystem-extent.js';
import { FilesystemCrawlSource } from '../../src/projection/crawl-source.js';
import { resolveRootPath } from '../../src/projection/identity.js';
import { resolveRealPath } from '../../src/projection/realizations.js';
import { canonicalizeSync } from '../../src/utils.js';
import { buildExtentContribution, createGitRepo, createLink, faultFsScratch } from '../test-helpers.js';

const CAPABILITY = symlinkCapability();

const scratch = faultFsScratch();

/** A corpus root holding `docs/plain.md`. */
function corpus(): string {
  const root = scratch.tempDir('vat-link-faults-');
  mkdirSyncReal(safePath.join(root, 'docs'));
  writeFileSync(safePath.join(root, 'docs', 'plain.md'), '# plain\n');
  return root;
}

/** Fail the `nth` `realpath` of a path `matches` accepts, under `within`, with `errno` — every retry too unless `once`; the session, to ask whether it fired. */
function refuseRealpath(within: string, matches: (path: string) => boolean, errno: InjectedErrno, { nth = 1, once = false } = {}): FaultFsSession {
  return scratch.watch(installFaultFs({ within, faults: [{ op: 'realpath', path: matches, errno, nth, everyTry: !once }] }));
}

/** What `work` threw; a return fails the test. */
async function thrownBy(work: () => unknown): Promise<unknown> {
  try {
    await work();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a throw');
}

/** The errnos with which the OS DECLINED or failed — a fault — and the one with which it found nothing. */
const FAULTS: ReadonlyArray<{ errno: InjectedErrno; faultClass: string }> = [
  { errno: 'EACCES', faultClass: 'refused' },
  { errno: 'EPERM', faultClass: 'refused' },
  { errno: 'EIO', faultClass: 'device' },
  { errno: 'UNKNOWN', faultClass: 'device' },
];

describe('resolveRootPath (identity): a spelling, never a link verdict', () => {
  it('answers a path that resolves to nothing from its nearest ancestor', () => {
    const root = corpus();
    const real = resolveRootPath(root);

    expect(resolveRootPath(safePath.join(root, 'docs', 'gone.md'))).toBe(`${real}/docs/gone.md`);
  });

  // A read lane that throws nothing for a filesystem errno: no side to pick, so identity minted
  // before the verb's `outputs` exist is no longer a reason to refuse the build's own `dist/`.
  it.each(FAULTS)('answers a path the OS refuses with $errno from its nearest ancestor too, and throws nothing', ({ errno }) => {
    const root = corpus();
    const real = resolveRootPath(root);
    const target = safePath.join(root, 'docs');
    const refused = refuseRealpath(root, (path) => path === target, errno);

    expect(resolveRootPath(target)).toBe(`${real}/docs`);
    expect(refused.fired.length).toBeGreaterThan(0);
  });
});

describe('resolveRealPath (realizations)', () => {
  it('is nowhere, with no fault, for a path that resolves to nothing (ENOENT)', () => {
    const root = corpus();
    const refused = refuseRealpath(root, (path) => path.endsWith('/plain.md'), 'ENOENT');

    expect(resolveRealPath(safePath.join(root, 'docs', 'plain.md'))).toEqual({ kind: 'nowhere', fault: null });
    expect(refused.fired.length).toBeGreaterThan(0);
  });

  it.each(FAULTS)('is nowhere carrying the fault when the OS refuses with $errno, and throws nothing', ({ errno, faultClass }) => {
    const root = corpus();
    const target = safePath.join(root, 'docs', 'plain.md');
    refuseRealpath(root, (path) => path === target, errno);

    expect(resolveRealPath(target)).toMatchObject({ kind: 'nowhere', fault: { errno, faultClass } });
  });

  it('asks the JS realpath again when the volume cannot answer a final-path query (EISDIR)', () => {
    const root = corpus();
    const target = safePath.join(root, 'docs', 'plain.md');
    const real = resolveRealPath(target);
    const refused = refuseRealpath(root, (path) => path === target, 'EISDIR', { once: true });

    expect(resolveRealPath(target)).toEqual(real);
    expect(refused.fired).toHaveLength(1);
  });
});

describe('canonicalizeSync', () => {
  it.each<InjectedErrno>(['ENOENT', ...FAULTS.map(({ errno }) => errno)])('answers a path whose realpath fails %s from its nearest ancestor, and throws nothing', (errno) => {
    const root = corpus();
    const docs = canonicalizeSync(safePath.join(root, 'docs'));
    const target = safePath.join(root, 'docs', 'plain.md');
    const refused = refuseRealpath(root, (path) => path === target, errno);

    expect(canonicalizeSync(target)).toBe(safePath.join(docs, 'plain.md'));
    // The real path is that answer too: only the refusal having fired makes this the ancestor's.
    expect(refused.fired.length).toBeGreaterThan(0);
  });
});

/**
 * A git project with `docs/a.md` linking five targets — one that resolves, one that is missing, one
 * whose realpath the OS refuses, one gitignored whose realpath the OS refuses, and one outside the
 * project whose realpath the OS refuses (a link into another user's 0700 home) — plus a gitignored
 * `docs/scratch.md` linking the refused one, filled in ONE batch and judged, as `vat resources
 * validate` does.
 */
async function judged(errno: InjectedErrno): Promise<{ issues: Map<string, { code: string; message: string } | null>; refused: FaultFsSession }> {
  const parent = scratch.tempDir('vat-link-faults-batch-');
  const root = safePath.join(parent, 'corpus');
  mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
  mkdirSyncReal(safePath.join(parent, 'away'));
  createGitRepo(root);
  const source = safePath.join(root, 'docs', 'a.md');
  writeFileSync(source, '# a\n');
  writeFileSync(safePath.join(root, 'docs', 'ok.md'), '# ok\n');
  writeFileSync(safePath.join(root, 'docs', 'locked.md'), '# locked\n');
  writeFileSync(safePath.join(parent, 'away', 'notes.md'), '# notes\n');
  writeFileSync(safePath.join(root, 'docs', 'secret.md'), '# secret\n');
  const ignoredSource = safePath.join(root, 'docs', 'scratch.md');
  writeFileSync(ignoredSource, '# scratch\n');
  writeFileSync(safePath.join(root, '.gitignore'), 'docs/secret.md\ndocs/scratch.md\n');
  const hrefs = ['./ok.md', './missing.md', './locked.md', './secret.md', '../../away/notes.md'];
  const resolved = resolveLinkEntries([
    ...hrefs.map((href) => ({ link: createLink('local_file', href), sourceFilePath: source })),
    { link: createLink('local_file', '../docs/locked.md'), sourceFilePath: ignoredSource },
  ], root);
  const refusedPaths = new Set([safePath.join(root, 'docs', 'locked.md'), safePath.join(root, 'docs', 'secret.md'), safePath.join(parent, 'away', 'notes.md')]);
  // One rule per refused path: a rule fails ONE matching call, so a shared rule would refuse only the first.
  const refused = scratch.watch(installFaultFs({ within: parent, faults: [...refusedPaths].map((refusedPath) => ({ op: 'realpath' as const, path: (path: string) => path === refusedPath, errno, nth: 1, everyTry: true })) }));
  const options = { projectRoot: root, skipGitIgnoreCheck: false };

  const tables = await fillLinkFacts(resolved, new FsLookupCache(), options);
  const judge = judgeOptionsFrom(options, tables);
  const issues = new Map(resolved.map((entry) => {
    const issue = judgeLink(entry, fragmentIndex(), judge);
    return [entry.link.href, issue === null ? null : { code: issue.code, message: issue.message }];
  }));
  return { issues, refused };
}

describe('link validation over a batch of targets, one of which the OS refuses to resolve', () => {
  it.each(FAULTS)('reports the refused target ($errno) as one finding naming the errno, and every other finding still', async ({ errno, faultClass }) => {
    const { issues, refused } = await judged(errno);

    expect(refused.fired.length).toBeGreaterThan(0);
    expect(issues.get('./ok.md')).toBeNull();
    expect(issues.get('./missing.md')).toMatchObject({ code: 'LINK_BROKEN_FILE' });
    expect(issues.get('./locked.md')).toMatchObject({ code: 'LINK_TARGET_UNREADABLE', message: expect.stringContaining(`(${errno}, ${faultClass})`) });
    // Outside the project whatever refused beneath it: the leak check never applies, nothing is charged.
    expect(issues.get('../../away/notes.md')).toBeNull();
  });

  // FAIL-CLOSED: git ignores the target AS WRITTEN, so the refused resolution cannot hide the leak
  // behind the overridable "not checked" finding — downgrading LINK_TARGET_UNREADABLE silences nothing here.
  it.each(FAULTS)('reports a gitignored target the OS refuses to resolve ($errno) as the leak itself, never as not checked', async ({ errno }) => {
    const { issues } = await judged(errno);

    expect(issues.get('./secret.md')).toMatchObject({ code: 'LINK_TO_GITIGNORED' });
  });

  // An ignored source leaks nothing whatever its target is, so a refused target is no gap in that check.
  it.each(FAULTS)('charges nothing to a gitignored source linking a target the OS refuses ($errno)', async ({ errno }) => {
    const { issues } = await judged(errno);

    expect(issues.get('../docs/locked.md')).toBeNull();
  });

  it('reads a target that resolves to nothing (ENOENT) as no fault: the target is judged from its ancestor', async () => {
    const { issues } = await judged('ENOENT');

    expect(issues.get('./locked.md')).toBeNull();
    expect(issues.get('./missing.md')).toMatchObject({ code: 'LINK_BROKEN_FILE' });
  });

  it('stops the run only for the project root, the namespace every target is compared in', async () => {
    const root = corpus();
    const source = safePath.join(root, 'docs', 'plain.md');
    const resolved = resolveLinkEntries([{ link: createLink('local_file', './plain.md'), sourceFilePath: source }], root);
    refuseRealpath(root, (path) => path === root, 'EACCES');

    expect(await thrownBy(() => fillLinkFacts(resolved, new FsLookupCache(), { projectRoot: root, skipGitIgnoreCheck: false })))
      .toMatchObject({ code: FS_FAULT_CODE, errno: 'EACCES', side: 'source', origin: 'argument', path: root });
  });
});

describe.skipIf(CAPABILITY === null)('the filesystem extent, resolving a link it declined to realize', () => {
  /** A corpus with `alias.md -> docs/plain.md` and `other.md -> docs/plain.md`, and the extent's condition rows over it. */
  async function linkedCorpus(refuse?: { readonly matches: (path: string) => boolean; readonly errno: InjectedErrno; readonly once?: boolean }): Promise<{ root: string; run: () => ReturnType<typeof buildExtentContribution> }> {
    if (CAPABILITY === null) throw new Error('unreachable — the suite is skipped without the capability');
    const root = corpus();
    createSymlink(CAPABILITY, 'docs/plain.md', safePath.join(root, 'alias.md'));
    createSymlink(CAPABILITY, 'docs/plain.md', safePath.join(root, 'other.md'));
    if (refuse !== undefined) refuseRealpath(root, refuse.matches, refuse.errno, { once: refuse.once ?? false });
    return { root, run: () => buildExtentContribution(root, new FilesystemExtentContributor((at) => new FilesystemCrawlSource(at, []))) };
  }

  // A link that resolves to nothing is the dangling-link code with no fault class; one the OS
  // refused or could not complete is its OWN code with the class in a column — never the dangling
  // code, whose remedy ("delete it") is wrong for a link the host may not follow. Either way it is
  // that one link's row, and every other row is still there.
  it('gives a link that resolves to nothing (ENOENT) the unresolved code and no fault class, and keeps every other row (hostResolution)', async () => {
    const { run } = await linkedCorpus({ matches: (path) => path.endsWith('/alias.md'), errno: 'ENOENT' });

    const { contribution } = await run();

    expect(contribution.conditions.find((condition) => condition.path === 'alias.md')).toMatchObject({ code: EXTENT_SYMLINK_TARGET_UNRESOLVED, targetFaultClass: null });
    expect(contribution.conditions.find((condition) => condition.path === 'other.md')?.code).toBe(EXTENT_SYMLINK_NOT_REALIZED);
  });

  it.each(FAULTS)('gives a link whose resolution the OS fails with $errno the unreadable code carrying class $faultClass, and keeps every other row (hostResolution)', async ({ errno, faultClass }) => {
    const { run } = await linkedCorpus({ matches: (path) => path.endsWith('/alias.md'), errno });

    const { contribution } = await run();

    expect(contribution.conditions.find((condition) => condition.path === 'alias.md')).toMatchObject({ code: EXTENT_SYMLINK_TARGET_UNREADABLE, targetFaultClass: faultClass });
    expect(contribution.conditions.find((condition) => condition.path === 'other.md')?.code).toBe(EXTENT_SYMLINK_NOT_REALIZED);
  });

  // The double fault: `readlink` refused the text AND the host could not resolve the link. The row
  // still names both errnos — the code's registry entry promises the errno in its message. On
  // Windows the realpath guard's own `readlink` is refused too, and leaves the answer to the kernel.
  it('names both errnos when the target text and the resolution both fail (readlink EACCES, realpath EIO)', async () => {
    const { root, run } = await linkedCorpus();
    const alias = (path: string): boolean => path.endsWith('/alias.md');
    scratch.watch(installFaultFs({
      within: root,
      faults: [
        { op: 'realpath', path: alias, errno: 'EIO', nth: 1, everyTry: true },
        { op: 'readlink', path: alias, errno: 'EACCES', nth: 1, everyTry: true },
      ],
    }));

    const { contribution } = await run();

    const row = contribution.conditions.find((condition) => condition.path === 'alias.md');
    expect(row).toMatchObject({ code: EXTENT_SYMLINK_TARGET_UNREADABLE, targetFaultClass: 'device' });
    expect(row?.message).toContain('could not be read (EACCES, refused)');
    expect(row?.message).toContain('(EIO, device)');
  });

  it('asks the JS realpath again when the volume cannot answer a final-path query (EISDIR, hostResolution)', async () => {
    const { run } = await linkedCorpus({ matches: (path) => path.endsWith('/alias.md'), errno: 'EISDIR', once: true });

    const { contribution } = await run();

    expect(contribution.conditions.find((condition) => condition.path === 'alias.md')?.code).toBe(EXTENT_SYMLINK_NOT_REALIZED);
  });

  it('is a source fault when the OS declines to resolve the corpus root (realRootOf): the root is no link target', async () => {
    const { root, run } = await linkedCorpus();
    // The SECOND resolution of the root: the first is the projection base's (`resolveRootPath`),
    // which answers from the ancestor; the second is the extent's own.
    const refused = refuseRealpath(root, (path) => path === root, 'EACCES', { nth: 2 });

    // The same origin the link validator's root refusal carries: one refused root, one cause sentence.
    expect(await thrownBy(run)).toMatchObject({ code: FS_FAULT_CODE, errno: 'EACCES', side: 'source', origin: 'argument', path: root });
    expect(refused.fired.length).toBeGreaterThan(0);
  });

  // The exact SEC-I1 scenario: a dangling link whose absolute target escapes the root lexically, into a
  // directory the user cannot resolve. Asked again with its nearest existing ancestor resolved — to
  // name it, never to choose its code — the refused ancestor cannot bring it back inside: outside, unnamed.
  it.each(FAULTS)('answers a dangling target whose nearest ancestor the OS refuses ($errno) as outside the root, and the run completes (realThroughNearestAncestor)', async ({ errno }) => {
    if (CAPABILITY === null) throw new Error('unreachable — the suite is skipped without the capability');
    const parent = scratch.tempDir('vat-link-faults-away-');
    const root = safePath.join(parent, 'corpus');
    const away = safePath.join(parent, 'away');
    mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
    mkdirSyncReal(away);
    writeFileSync(safePath.join(root, 'docs', 'plain.md'), '# plain\n');
    createSymlink(CAPABILITY, `${away}/gone.md`, safePath.join(root, 'abs.md'));
    createSymlink(CAPABILITY, 'docs/plain.md', safePath.join(root, 'other.md'));
    const refused = refuseRealpath(parent, (path) => path === away, errno);

    const { contribution } = await buildExtentContribution(root, new FilesystemExtentContributor((at) => new FilesystemCrawlSource(at, [])));

    expect(contribution.conditions.find((condition) => condition.path === 'abs.md')?.code).toBe(EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT);
    expect(contribution.conditions.find((condition) => condition.path === 'other.md')?.code).toBe(EXTENT_SYMLINK_NOT_REALIZED);
    expect(refused.fired.length).toBeGreaterThan(0);
  });
});
