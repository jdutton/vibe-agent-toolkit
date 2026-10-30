import { readdirSync } from 'node:fs';
import { posix } from 'node:path';

import {
  COPY_LINK_ESCAPES_SOURCE_CODE,
  HOST_PATH_FLAVOR,
  isTimedOutError,
  isWithinUnder,
  refuseEscapingLinks,
  safePath,
  toForwardSlashAnyPlatform,
  treeChain,
  treeContainment,
  untrustedLinkRefusal,
  VatError,
  withFsFaultSync,
} from '@vibe-agent-toolkit/utils';
import {
  nonInteractiveGitOverrides,
  runGit as runGitSafely,
  type GitRunResult,
  type ParsedGitUrl,
} from '@vibe-agent-toolkit/utils/git';

/** Hard wall-clock cap on any single git invocation (clone or rev-parse). */
const GIT_TIMEOUT_MS = 60_000;
/** Generous stdout/stderr cap (64 MiB) so large clones don't trip the default 1 MiB limit. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Result of a shallow git clone: the resolved ref, full commit SHA, and target dir. */
export interface GitCloneResult {
  /** The ref cloned (the requested `--branch <ref>`, or 'HEAD' for the default branch). */
  ref: string;
  /** Full 40-char resolved HEAD commit SHA. */
  commit: string;
  /** The (subpath-resolved) directory the caller should consume. */
  targetDir: string;
}

/**
 * Run git with a wall-clock timeout and a generous output buffer. On timeout,
 * spawnSync sets `.error` (code `ETIMEDOUT`) and kills the process — surface a
 * clear error instead of letting a generic non-zero-status message swallow it.
 *
 * `envOverlay` is merged over the inherited environment, *after* the inherited
 * `GIT_*` redirection is scrubbed — every invocation here targets the clone
 * destination, a caller-supplied path. Measured: the clone itself survives an
 * inherited `GIT_DIR`, but the `rev-parse HEAD` that follows reports the
 * *ambient* repository's commit, so a correctly-cloned source is stamped with a
 * provenance SHA from somewhere else. `envOverlay` is empty for every
 * invocation except the clone of a shorthand-inferred URL — see
 * `nonInteractiveGitOverrides`.
 */
function runGit(
  args: string[],
  envOverlay: Record<string, string>,
  cwd?: string,
  io: { readonly input?: string; readonly trim?: boolean } = {},
): GitRunResult {
  const result = runGitSafely(args, {
    ...(cwd === undefined ? {} : { cwd }),
    ...(io.input === undefined ? {} : { input: io.input }),
    ...(io.trim === undefined ? {} : { trim: io.trim }),
    env: envOverlay,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (result.error !== undefined && isTimedOutError(result.error)) {
    throw new GitCloneFailedError(
      `git ${args[0] ?? ''} timed out after ${(GIT_TIMEOUT_MS / 1000).toString()}s ` +
        `(possible unreachable remote or hang).`,
      { cause: result.error },
    );
  }
  return result;
}

/**
 * The code a clone that did not happen is thrown with: the remote would not hand the
 * repository over (unreachable, refused, a ref it does not have, a timeout). The source
 * the caller named could not be read — never a defect in VAT.
 */
export const GIT_CLONE_FAILED_CODE = 'GIT_CLONE_FAILED';

/** A git source that could not be cloned. Reason `preflight`: the operator fixes the URL, the ref or the network. */
export class GitCloneFailedError extends VatError {
  readonly reason = 'preflight' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(GIT_CLONE_FAILED_CODE, message, options);
  }
}

/**
 * The code a subpath the clone does not hold — absent, or escaping the repo —
 * is thrown with. The source WAS read; the subpath is the caller's argument, so
 * a caller maps it to a usage mistake by code, never by the message.
 */
export const GIT_SUBPATH_INVALID_CODE = 'GIT_SUBPATH_INVALID';

/**
 * Shallow-clone `parsed` into the caller-provided `targetTempdir`, validate any
 * subpath, and return the resolved ref/commit/targetDir.
 *
 * Neutral domain primitive: it does NOT create or clean the tempdir, and carries
 * no audit/provenance coupling. Callers (audit's withClonedRepo, the url skill
 * source) own tempdir lifecycle. Extracted verbatim from the original audit helper
 * so audit behavior is unchanged (spec §11c regression requirement).
 */
export function cloneGitSource(parsed: ParsedGitUrl, targetTempdir: string): GitCloneResult {
  // Cloned WITHOUT a checkout, so no link exists on disk until every committed link's text has
  // been read from the object store and judged: checking a link out is already a resolution on
  // Windows (Git for Windows opens a new link to decide whether it names a file or a directory),
  // and a link to `\\host\share` resolved there offers the operator's NTLM credentials to the host.
  const ref = cloneShallow(parsed, targetTempdir);
  const commit = revParseHead(targetTempdir);
  const { subpath } = parsed;
  refuseCommittedLinkTexts(targetTempdir, commit, subpath, HOST_PATH_FLAVOR);
  checkOut(targetTempdir, commit);
  const targetDir = subpath ? safePath.join(targetTempdir, subpath) : targetTempdir;

  // Containment is judged on REAL paths, after the chain to the subpath is read by its text: the
  // repository being cloned is untrusted, and a committed `skills -> /somewhere/outside` passes
  // any lexical check while every later read lands outside the clone.
  const placement = subpathPlacement(targetTempdir, targetDir);
  if (placement === 'outside') throw subpathEscapes(subpath);
  if (placement === 'absent') {
    const topLevel = readdirSync(targetTempdir).join(', ');
    throw new VatError(
      GIT_SUBPATH_INVALID_CODE,
      `Subpath not found in cloned repo: ${subpath ?? '(none)'}. Repo root contains: ${topLevel}.`,
    );
  }
  // Every consumer of `targetDir` (the audit walk, staging) follows links, so one committed
  // `docs/keys -> ~/.ssh` would read the operator's own files as the repository's content. The
  // second lock behind the object-store check: every link's chain is read before the kernel
  // resolves it. A probe the OS refuses is a fault on the input's side, as in the install lane.
  refuseEscapingLinks({
    root: targetTempdir,
    subtree: targetDir,
    skip: safePath.join(targetTempdir, '.git'),
    placement: 'in-place',
    side: 'source',
    flavor: HOST_PATH_FLAVOR,
    tree: 'the cloned repository',
    within: 'the clone',
    consequence: 'Every reader of the source follows links, so it would read files the repository does not hold',
  });

  return { ref, commit, targetDir };
}

/** One committed symbolic link: where it is in the tree, and its blob. */
interface CommittedLink {
  readonly path: string;
  readonly blob: string;
}

/** Every mode-`120000` entry of `commit`'s tree, from `ls-tree -r -z` (NUL-delimited, never trimmed). */
function committedLinks(cloneDir: string, commit: string): CommittedLink[] {
  const result = runGit(['ls-tree', '-r', '-z', '--full-tree', commit], {}, cloneDir, { trim: false });
  if ((result.status ?? 1) !== 0) throw new GitCloneFailedError(`Failed to list the cloned commit's tree: ${(result.stderr ?? '').trim()}`);
  const links: CommittedLink[] = [];
  for (const record of (result.stdout ?? '').split('\0')) {
    // `<mode> SP <type> SP <object> TAB <path>`
    const tab = record.indexOf('\t');
    const [mode, , blob] = record.slice(0, tab).split(' ');
    if (tab > 0 && mode === '120000' && blob !== undefined) links.push({ path: record.slice(tab + 1), blob });
  }
  return links;
}

/** U+FFFD: what a UTF-8 decode leaves in place of each byte sequence it could not read. */
const REPLACEMENT = String.fromCodePoint(0xff_fd);

/**
 * The text of each link's blob, byte for byte. `runGit` hands stdout back decoded as UTF-8, so
 * the bytes are recovered by re-encoding — exact only when the decode met no invalid sequence,
 * which is exactly when it left no U+FFFD. A blob that is not UTF-8 changes length in the decode,
 * and a stream framed by its declared sizes then reads a header the blob planted as the next
 * object (R12-SEC-C1); so a stream holding U+FFFD is never framed, and each blob is read alone.
 * Its U+FFFD then marks the link's own text, which is refused ({@link committedLinkRefusal}).
 */
function linkTexts(cloneDir: string, links: readonly CommittedLink[]): string[] {
  const stdout = readLinkObjects(['cat-file', '--batch'], cloneDir, links.map((link) => `${link.blob}\n`).join(''));
  if (!stdout.includes(REPLACEMENT)) return framedTexts(Buffer.from(stdout, 'utf8'), links);
  return links.map((link) => readLinkObjects(['cat-file', 'blob', link.blob], cloneDir));
}

/** One `cat-file` read of the clone's link objects, untrimmed: a text's own whitespace is data. */
function readLinkObjects(args: string[], cloneDir: string, input?: string): string {
  const result = runGit(args, {}, cloneDir, { ...(input === undefined ? {} : { input }), trim: false });
  if ((result.status ?? 1) !== 0) throw new GitCloneFailedError(`Failed to read the cloned repository's link texts: ${(result.stderr ?? '').trim()}`);
  return result.stdout ?? '';
}

/** A `cat-file --batch` header: the object, `blob`, its size in canonical decimal. */
const BLOB_HEADER = /^([\da-f]{40}|[\da-f]{64}) blob (0|[1-9]\d*)$/;

/**
 * `cat-file --batch` output, framed by its bytes: `<object> SP blob SP <size> LF`, `<size>` bytes,
 * LF — exactly one object per link, the one asked, in order, and nothing after. Anything else means
 * the texts are not the links': refuse rather than judge them.
 */
function framedTexts(bytes: Buffer, links: readonly CommittedLink[]): string[] {
  const refused = (why: string): GitCloneFailedError => new GitCloneFailedError(`Failed to read the cloned repository's link texts: ${why}.`);
  const texts: string[] = [];
  let at = 0;
  for (const link of links) {
    if (at >= bytes.length) throw refused(`git returned ${texts.length.toString()} of ${links.length.toString()} objects`);
    const headerEnd = bytes.indexOf(0x0a, at);
    const header = bytes.subarray(at, headerEnd < 0 ? bytes.length : headerEnd).toString('utf8');
    const size = BLOB_HEADER.exec(header);
    if (headerEnd < 0 || size?.[1] !== link.blob || size[2] === undefined) throw refused(`${link.path}: its header (${header}) is not \`${link.blob} blob <size>\``);
    const end = headerEnd + 1 + Number(size[2]);
    if (end >= bytes.length || bytes[end] !== 0x0a) throw refused(`${link.path}: its bytes do not end where its header says`);
    texts.push(bytes.subarray(headerEnd + 1, end).toString('utf8'));
    at = end + 1;
  }
  if (at < bytes.length) throw refused(`git wrote ${(bytes.length - at).toString()} bytes after the last link`);
  return texts;
}

/** Why a committed link is refused by its text alone. */
type CommittedLinkRefusal = NonNullable<ReturnType<typeof untrustedLinkRefusal>>;

/**
 * Why a committed link's text alone may not be checked out: the one untrusted-link rule
 * (`untrustedLinkRefusal`, shared with the link-chain walk), or `unportable` for a text holding
 * U+FFFD. That U+FFFD is a byte sequence that is not UTF-8 ({@link linkTexts}) — or, written
 * literally, indistinguishable from one. Such bytes are judged as bytes, and refused: POSIX creates
 * them verbatim while Git for Windows converts the text from UTF-8 to UTF-16 to create the link,
 * so no one string is what both kernels would be handed, and none can be judged for either.
 */
function committedLinkRefusal(path: string, text: string): CommittedLinkRefusal | undefined {
  return text.includes(REPLACEMENT) ? 'unportable' : untrustedLinkRefusal(path, text);
}

/** How each refusal reads in a refusal message, after "is a symbolic link ". */
const REFUSAL_TEXT: Readonly<Record<CommittedLinkRefusal, (text: string) => string>> = {
  network: (text) => `whose target leads through a network path (${text}), which names a place outside the clone`,
  absolute: (text) => `whose target leads through an absolute path (${text}), which names a place outside the clone`,
  'drive-relative': (text) => `whose target leads through a drive-relative path (${text}), which names a place outside the clone`,
  unportable: (text) =>
    `whose text is not portable (${JSON.stringify(text)}): it holds a NUL, a component ending in a dot or a space, ` +
    'or bytes that are not UTF-8, so the link the OS would create is not the text judged',
  'climbs-out': (text) => `to a path outside the clone (${text})`,
};

/** The subpath's escape refusal: the subpath is the caller's argument, so a usage mistake by code. */
function subpathEscapes(subpath: string | undefined): VatError {
  return new VatError(
    GIT_SUBPATH_INVALID_CODE,
    `Subpath escapes the cloned repository: ${subpath ?? '(none)'}. ` +
      `Subpaths must be relative paths inside the repo (no \`..\` traversal, no symbolic link out of it).`,
  );
}

/**
 * Refuse a commit holding a symbolic link whose TEXT leaves the repository — absolute, drive-relative
 * or a network path under either host's rules, a climb above its root, or a text the OS would not
 * create as written — read from the object store before any link exists on disk
 * ({@link cloneGitSource}). EVERY link of the commit, not only those under the subpath: the checkout
 * writes them all, and writing one is already resolving it on Windows. A link that IS the subpath,
 * or one of its directories, is the subpath's refusal — matched under `flavor`'s rules, so case-blind
 * (the ordinal fold) under win32, where `Skills` and `skills` are one directory.
 *
 * @throws VatError `GIT_SUBPATH_INVALID` for a link on the subpath; `COPY_LINK_ESCAPES_SOURCE` naming
 *   the first other such link; GitCloneFailedError when git cannot list or read the commit
 */
function refuseCommittedLinkTexts(cloneDir: string, commit: string, subpath: string | undefined, flavor: typeof HOST_PATH_FLAVOR): void {
  const links = committedLinks(cloneDir, commit);
  if (links.length === 0) return;
  const onSubpath = subpath === undefined ? undefined : posix.normalize(toForwardSlashAnyPlatform(subpath)).replace(/\/$/, '');
  for (const [index, text] of linkTexts(cloneDir, links).entries()) {
    const link = links[index];
    const refusal = link === undefined ? undefined : committedLinkRefusal(link.path, text);
    if (link !== undefined && refusal !== undefined) {
      if (onSubpath !== undefined && isWithinUnder(onSubpath, link.path, flavor)) throw subpathEscapes(subpath);
      throw new VatError(
        COPY_LINK_ESCAPES_SOURCE_CODE,
        `Refusing the cloned repository: ${link.path} is a symbolic link ${REFUSAL_TEXT[refusal](text)}. ` +
          'Every reader of the source follows links, so it would read files the repository does not hold — replace the link with the files, or point it inside with a relative target.',
      );
    }
  }
}

/** Write the commit's tree to disk — index and working tree — once its links' texts are judged. */
function checkOut(cloneDir: string, commit: string): void {
  const result = runGit(['read-tree', '--reset', '-u', commit], {}, cloneDir);
  if ((result.status ?? 1) !== 0) throw new GitCloneFailedError(`Failed to check out the cloned commit: ${(result.stderr ?? '').trim()}`);
}

/**
 * Where the subpath stands relative to the clone, decided by the one link-chain resolver
 * (`treeChain`) before the kernel is asked anything: a chain through an absolute, drive-relative
 * or network text, or above the clone's root, escapes; a chain that leads to nothing — absent, or
 * a cycle — names nothing, as a dangling link does in every lane. Only a chain read and shown local
 * is handed to the kernel, whose real path is the second lock. Every probe runs inside the
 * classifier: a refusal by the OS is the input's fault, as in the install lane.
 */
function subpathPlacement(cloneRoot: string, targetDir: string): 'inside' | 'outside' | 'absent' {
  return withFsFaultSync({ side: 'source', origin: 'content', action: 'examine the subpath of the cloned repository', path: targetDir }, () => {
    const chain = treeChain(cloneRoot, targetDir, HOST_PATH_FLAVOR);
    if (chain.kind === 'refused') return 'outside';
    if (chain.kind === 'nothing') return 'absent';
    return treeContainment(cloneRoot, targetDir) === 'outside' ? 'outside' : 'inside';
  });
}

function cloneShallow(parsed: ParsedGitUrl, tempdir: string): string {
  // A shorthand-inferred URL clones non-interactively so a typo'd `owner/repo`
  // fails immediately instead of blocking on a credential prompt; an explicitly
  // typed URL keeps interactive auth, which may be exactly what the user wants.
  const { env, configArgs } = nonInteractiveGitOverrides(parsed);
  // `-c` overrides must precede the subcommand.
  const args = [...configArgs, 'clone', '--no-checkout', '--depth', '1', '--single-branch'];
  if (parsed.ref !== undefined) args.push('--branch', parsed.ref);
  // `--` ends option parsing so a cloneUrl/tempdir that begins with `-` can never
  // be read as a git option (defense in depth — parseGitUrl already rejects such
  // URLs, but the separator makes the guarantee local to the spawn).
  args.push('--', parsed.cloneUrl, tempdir);

  const result = runGit(args, env);
  const status = result.status ?? 1;
  if (status !== 0) {
    throw cloneFailure(parsed, (result.stderr ?? '').trim());
  }
  return parsed.ref ?? 'HEAD';
}

/** Turn a non-zero `git clone` into the most specific refusal we can justify. */
function cloneFailure(parsed: ParsedGitUrl, stderr: string): GitCloneFailedError {
  if (parsed.ref !== undefined && /not found|did not match/i.test(stderr)) {
    return new GitCloneFailedError(
      `Reference not found in ${parsed.cloneUrl}: ${parsed.ref}. ` +
        `Hint: --depth 1 cloning cannot resolve arbitrary deep commit SHAs; try a branch or tag name.`,
    );
  }
  if (parsed.inferredFromShorthand) {
    // With prompts disabled, a nonexistent-or-private repo surfaces as an
    // authentication failure. Name the expansion, because the user never typed it.
    return new GitCloneFailedError(
      `Clone failed:\n${stderr}\n` +
        `Hint: shorthand was expanded to ${parsed.cloneUrl}. Check the owner/repo spelling; ` +
        `if the repository is private, pass the full URL to authenticate interactively.`,
    );
  }
  return new GitCloneFailedError(`Clone failed:\n${stderr}`);
}

function revParseHead(tempdir: string): string {
  // No overlay: this runs inside the finished clone and never touches a remote.
  const result = runGit(['rev-parse', 'HEAD'], {}, tempdir);
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new GitCloneFailedError(`Failed to resolve HEAD commit in cloned repo: ${(result.stderr ?? '').trim()}`);
  }
  // Full 40-char SHA: the commit is the git cache key, so truncation risks cross-repo collisions.
  return (result.stdout ?? '').trim();
}
