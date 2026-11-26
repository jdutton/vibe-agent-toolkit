/**
 * Read objects from git's object store: one long-lived `git cat-file --batch` per repository root,
 * at most {@link MAX_LIVE_READERS} live, each started on the first read asked of its root.
 *
 * - Requests are object names only, so no path crosses the pipe (no path encoding, no Windows
 *   quoting). Answers are framed by byte count ({@link frameBatchRecord}), so an object's bytes come
 *   back exactly as git stores them, whatever they hold.
 * - Never `--filters` or `--textconv`: the bytes are the stored blob's, and its header size is the
 *   unfiltered size.
 * - The environment is the one a non-ambient `runGit` gets ({@link scrubbedGitEnv}), with
 *   `GIT_TERMINAL_PROMPT=0` and `GIT_NO_LAZY_FETCH=1`; from git 2.45 the global `--no-lazy-fetch`
 *   too. A partial clone must never fetch inside a read: a missing object is an answer, not a
 *   download.
 * - A missing object rejects that one read with {@link GitObjectMissingError}; the child keeps
 *   answering. A child that exits rejects every read it still owed with {@link GitObjectReadError}.
 *   An answer out of step with the requests (another object's name, a frame that does not parse) is
 *   VAT's own fault: a plain `Error`, and the child is killed.
 *
 * Exactly one owner closes a set ({@link GitObjectReaders.close}, or its abort signal); close kills
 * each child and waits for it to exit, so a Windows git has released its pack handles before a
 * caller removes the directory.
 */

import type { ChildProcess } from 'node:child_process';

import { VatError } from './errors/vat-error.js';
import { type BatchFrame, type BatchHeader, batchCheckOf, frameBatchRecord } from './git-cat-file.js';
import { runGit, runGitBytes, scrubbedGitEnv } from './git-run.js';
import { shownName } from './shown-text.js';
import { spawnHardened } from './spawn-hardened.js';
import { decodeTextContent } from './text-content.js';
import { countGitSpawn, countWork } from './work-counters.js';

/** The most `cat-file --batch` children a set keeps live; a fifth root retires the least recently used. */
const MAX_LIVE_READERS = 4;

/** The first git (major, minor) that takes the global `--no-lazy-fetch`. */
const NO_LAZY_FETCH_SINCE: GitVersion = [2, 45];

/** Over the scrubbed environment: never prompt, never fetch an object a partial clone lacks. */
const READER_ENV: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };

/** A whole object name: 40 hex (SHA-1) or 64 hex (SHA-256), lowercase, as git writes them. */
const OBJECT_NAME = /^(?:[\da-f]{40}|[\da-f]{64})$/;

/** How much of a child's stderr a failure quotes: its tail. */
const STDERR_KEPT = 2048;

/** A git version, as far as VAT compares one: major and minor. */
export type GitVersion = readonly [major: number, minor: number];

/** An object git's store does not hold: a pruned loose object, or one a partial clone never fetched. */
export class GitObjectMissingError extends VatError {
  /** The code every instance carries, for `isVatError(error, GitObjectMissingError.code)`. */
  static readonly code = 'GIT_OBJECT_MISSING';

  /**
   * @param repositoryRoot - The repository asked
   * @param oid - The object it does not hold
   */
  constructor(
    readonly repositoryRoot: string,
    readonly oid: string,
  ) {
    super(
      GitObjectMissingError.code,
      `git's object store at ${shownName(repositoryRoot)} holds no object ${oid}: it was pruned, or this partial clone never`
        + ' fetched it. Fetch it (git fetch), or run git gc --prune=never next time.',
    );
  }
}

/** git gave no answer for an object: its reader exited, was closed, or could not start. */
export class GitObjectReadError extends VatError {
  /** The code every instance carries, for `isVatError(error, GitObjectReadError.code)`. */
  static readonly code = 'GIT_OBJECT_READ_FAILED';

  /**
   * @param repositoryRoot - The repository asked
   * @param why - What happened, as a sentence fragment
   * @param options - `cause`, when a spawn failure is being translated
   */
  constructor(
    readonly repositoryRoot: string,
    why: string,
    options?: ErrorOptions,
  ) {
    super(GitObjectReadError.code, `git could not read objects at ${shownName(repositoryRoot)}: ${why}`, options);
  }
}

/** One read the child still owes, in request order. */
interface PendingRead {
  readonly oid: string;
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: unknown) => void;
}

/** A frame that holds a whole answer, or a fault: anything but "wait for more bytes". */
type SettledFrame = Exclude<BatchFrame, { kind: 'header-incomplete' } | { kind: 'body-incomplete' }>;

/**
 * Throw VAT's own fault for a name that is not a whole lowercase object name: it would be resolved
 * by git as a revision, or split into two requests on the pipe.
 */
function assertObjectName(oid: string): void {
  if (!OBJECT_NAME.test(oid)) throw new Error(`${JSON.stringify(oid)} is not a whole object name (40 or 64 lowercase hex)`);
}

/** How a child ended, for a reason. */
function exitOf(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null ? `exit ${String(code)}` : `signal ${signal}`;
}

/** One repository's `git cat-file --batch` child. */
class BatchReader {
  /** Resolves once the child has exited (or never started). */
  readonly exited: Promise<void>;
  private readonly child: ChildProcess;
  private readonly pending: PendingRead[] = [];
  private chunks: Buffer[] = [];
  private held = 0;
  private needed = 0;
  private stderr = Buffer.alloc(0);
  private failure: Error | undefined;

  constructor(
    private readonly root: string,
    globals: readonly string[],
  ) {
    // eslint-disable-next-line local/no-text-git-object-read -- a long-lived child streams its bytes; they are framed by count in receive(), never decoded
    const args = [...globals, 'cat-file', '--batch'];
    countGitSpawn({ via: 'objectReader', args, cwd: root });
    const child = spawnHardened('git', args, { cwd: root, env: scrubbedGitEnv(READER_ENV), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        this.fail(new GitObjectReadError(root, `git cat-file --batch ended (${exitOf(code, signal)})${this.said()}`));
        resolve();
      });
      child.once('error', (error) => {
        this.fail(new GitObjectReadError(root, `git cat-file --batch could not run (${error.message})`, { cause: error }));
        if (child.pid === undefined) resolve();
      });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      this.receive(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-STDERR_KEPT);
    });
    // A write to a child that has exited fails here; the exit itself rejects what was owed.
    child.stdin?.on('error', () => undefined);
  }

  /** Whether this child can answer no more reads. */
  get stopped(): boolean {
    return this.failure !== undefined;
  }

  /** One object's bytes. */
  read(oid: string): Promise<Uint8Array> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending.push({ oid, resolve, reject });
      this.child.stdin?.write(`${oid}\n`);
    });
  }

  /** Let the child answer what it owes, then exit (its stdin ends). */
  retire(): void {
    this.child.stdin?.end();
  }

  /** Reject what is owed, kill the child, and wait for it to exit. */
  async close(): Promise<void> {
    this.fail(new GitObjectReadError(this.root, 'the reader was closed'));
    this.child.kill();
    await this.exited;
  }

  /** git's stderr tail, as a reason's suffix. */
  private said(): string {
    const said = decodeTextContent(this.stderr).text.trim();
    return said === '' ? '' : `. git said: ${said}`;
  }

  /** Stop answering: reject every read owed, and every later one, with `error`. */
  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.splice(0)) request.reject(error);
  }

  /** Take stdout bytes in; settle every whole answer they complete. */
  private receive(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.held += chunk.length;
    if (this.held < this.needed) return;
    const bytes = this.chunks.length === 1 && this.chunks[0] !== undefined ? this.chunks[0] : Buffer.concat(this.chunks, this.held);
    let at = 0;
    let frame = frameBatchRecord(bytes, at);
    while (frame.kind !== 'header-incomplete' && frame.kind !== 'body-incomplete') {
      const next = this.settle(frame);
      if (next === undefined) return;
      at = next;
      frame = frameBatchRecord(bytes, at);
    }
    this.needed = frame.kind === 'body-incomplete' ? frame.needed - at : 0;
    const rest = bytes.subarray(at);
    this.chunks = rest.length === 0 ? [] : [rest];
    this.held = rest.length;
  }

  /**
   * Settle the oldest read with one whole frame.
   *
   * @returns Where the next frame starts, or undefined when this one is out of step with the
   *   requests: then the child is killed
   */
  private settle(frame: SettledFrame): number | undefined {
    const request = this.pending.shift();
    if (frame.kind === 'malformed-header' || frame.kind === 'unterminated' || request?.oid !== frame.oid) {
      const answered = frame.kind === 'malformed-header' ? 'a header it cannot read' : `an answer for ${frame.oid}`;
      const error = new Error(`git cat-file --batch at ${shownName(this.root)} wrote ${answered} when ${request?.oid ?? 'nothing'} was owed`);
      request?.reject(error);
      this.fail(error);
      this.child.kill();
      return undefined;
    }
    if (frame.kind === 'missing') {
      request.reject(new GitObjectMissingError(this.root, request.oid));
    } else if (frame.type === 'blob') {
      countWork('content.gitRead', 1);
      request.resolve(frame.body);
    } else {
      request.reject(new Error(`${request.oid} at ${shownName(this.root)} is a ${frame.type}, not a blob`));
    }
    return frame.next;
  }
}

/** Whether a git of `version` takes the global `--no-lazy-fetch`; an unknown version does not. */
function takesNoLazyFetch(version: GitVersion | undefined): boolean {
  if (version === undefined) return false;
  const [major, minor] = version;
  const [sinceMajor, sinceMinor] = NO_LAZY_FETCH_SINCE;
  return major > sinceMajor || (major === sinceMajor && minor >= sinceMinor);
}

/** How `git --version` begins its answer. */
const GIT_VERSION_PREFIX = 'git version ';

/** This git's version, asked once per process; undefined when git does not say. */
let probedVersion: { readonly version: GitVersion | undefined } | undefined;

function probeGitVersion(): GitVersion | undefined {
  if (probedVersion === undefined) {
    const answer = runGit(['--version']);
    // `git version 2.54.0`, or `git version 2.39.5 (Apple Git-154)`: the first two dotted numbers.
    const [major, minor] = (answer.ok ? answer.stdout.slice(GIT_VERSION_PREFIX.length) : '').split('.').map(Number);
    const known = answer.ok && answer.stdout.startsWith(GIT_VERSION_PREFIX) && Number.isInteger(major) && Number.isInteger(minor);
    probedVersion = { version: known ? [major ?? 0, minor ?? 0] : undefined };
  }
  return probedVersion.version;
}

/**
 * Each present blob's size from a `--batch-check` listing; a name git does not hold is left out.
 *
 * @throws {Error} For a name the listing has no line for, or an object that is not a blob
 */
function blobSizesOf(root: string, checked: ReadonlyMap<string, BatchHeader>, oids: readonly string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const oid of oids) {
    const header = checked.get(oid);
    if (header === undefined) throw new Error(`git cat-file --batch-check at ${shownName(root)} gave no line for ${oid}`);
    if (header.kind === 'missing') continue;
    if (header.type !== 'blob') throw new Error(`${oid} at ${shownName(root)} is a ${header.type}, not a blob`);
    sizes.set(oid, header.size);
  }
  return sizes;
}

/** A set of object readers, one live `cat-file --batch` per repository root; see the module header. */
export interface GitObjectReaders {
  /**
   * One blob's bytes, exactly as git stores them.
   *
   * @param repositoryRoot - The repository's root (the reader runs there)
   * @param oid - A whole object name
   * @returns The bytes; rejects with {@link GitObjectMissingError} for an object git does not hold,
   *   {@link GitObjectReadError} when git gave no answer, a plain `Error` for a name that is not an
   *   object name, an object that is not a blob, or an answer out of step
   */
  read(repositoryRoot: string, oid: string): Promise<Uint8Array>;
  /**
   * Blob sizes, from one `git cat-file --batch-check` over every name given.
   *
   * @returns Each held blob's size by its name; a name git does not hold is absent from the map.
   *   Rejects as {@link read} does
   */
  sizes(repositoryRoot: string, oids: readonly string[]): Promise<ReadonlyMap<string, number>>;
  /** Whether this git takes `--no-lazy-fetch` (2.45 on), so a read cannot fetch in a partial clone. */
  guardsLazyFetch(): boolean;
  /** Kill every child and wait for each to exit; every later read rejects. */
  close(): Promise<void>;
}

/** What a set of readers is opened with. */
export interface GitObjectReadersOptions {
  /** Closes the set when it aborts. */
  readonly signal?: AbortSignal;
  /** The git version to assume; asked of git (once per process) when not given. */
  readonly gitVersion?: GitVersion;
}

class ReaderSet implements GitObjectReaders {
  private readonly live = new Map<string, BatchReader>();
  private readonly exits: Array<Promise<void>> = [];
  private closed = false;
  private guards: boolean | undefined;
  private readonly onAbort = (): void => {
    // close() only awaits exits, which never reject.
    this.close().catch(() => undefined);
  };

  constructor(private readonly options: GitObjectReadersOptions) {
    if (options.signal?.aborted === true) this.closed = true;
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  guardsLazyFetch(): boolean {
    this.guards ??= takesNoLazyFetch(this.options.gitVersion ?? probeGitVersion());
    return this.guards;
  }

  async read(repositoryRoot: string, oid: string): Promise<Uint8Array> {
    assertObjectName(oid);
    return await this.readerFor(repositoryRoot).read(oid);
  }

  sizes(repositoryRoot: string, oids: readonly string[]): Promise<ReadonlyMap<string, number>> {
    // Run inside the chain, so every throw rejects instead, as a read's does.
    return Promise.resolve().then(() => this.sizesNow(repositoryRoot, oids));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.options.signal?.removeEventListener('abort', this.onAbort);
    const closing = [...this.live.values()].map((reader) => reader.close());
    this.live.clear();
    await Promise.all([...closing, ...this.exits]);
  }

  private sizesNow(repositoryRoot: string, oids: readonly string[]): ReadonlyMap<string, number> {
    for (const oid of oids) assertObjectName(oid);
    this.refuseClosed(repositoryRoot);
    if (oids.length === 0) return new Map();
    const listed = runGitBytes([...this.globals(), 'cat-file', '--batch-check'], {
      cwd: repositoryRoot,
      env: { ...READER_ENV },
      input: `${oids.join('\n')}\n`,
      maxBuffer: Number.MAX_SAFE_INTEGER,
    });
    if (!listed.ok) {
      const said = listed.stderr === '' ? '' : `. git said: ${listed.stderr}`;
      throw new GitObjectReadError(repositoryRoot, `git cat-file --batch-check failed (exit ${String(listed.status)})${said}`);
    }
    const checked = batchCheckOf(listed.stdout);
    if (checked === undefined) throw new Error(`git cat-file --batch-check at ${shownName(repositoryRoot)} wrote a listing VAT cannot read`);
    return blobSizesOf(repositoryRoot, checked, oids);
  }

  /** The global options every `cat-file` here starts with. */
  private globals(): string[] {
    return this.guardsLazyFetch() ? ['--no-lazy-fetch'] : [];
  }

  private refuseClosed(repositoryRoot: string): void {
    if (this.closed) throw new GitObjectReadError(repositoryRoot, 'the reader set was closed');
  }

  /** The root's live reader, most recently used now; started (retiring the oldest past the cap) if none is. */
  private readerFor(repositoryRoot: string): BatchReader {
    this.refuseClosed(repositoryRoot);
    const held = this.live.get(repositoryRoot);
    this.live.delete(repositoryRoot);
    if (held !== undefined && !held.stopped) {
      this.live.set(repositoryRoot, held);
      return held;
    }
    const oldest = this.live.entries().next();
    if (this.live.size >= MAX_LIVE_READERS && oldest.done !== true) {
      const [oldestRoot, oldestReader] = oldest.value;
      this.live.delete(oldestRoot);
      oldestReader.retire();
    }
    let reader: BatchReader;
    try {
      reader = new BatchReader(repositoryRoot, this.globals());
    } catch (error) {
      throw new GitObjectReadError(repositoryRoot, `git cat-file --batch could not start (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
    this.exits.push(reader.exited);
    this.live.set(repositoryRoot, reader);
    return reader;
  }
}

/**
 * Open a set of object readers; see the module header. The caller owns it and closes it.
 *
 * @param options - The abort signal that closes it, and the git version to assume
 * @returns The set; no git runs until the first read
 */
export function openGitObjectReaders(options: GitObjectReadersOptions): GitObjectReaders {
  return new ReaderSet(options);
}
