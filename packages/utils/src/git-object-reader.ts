/**
 * Read objects and their sizes from git's object store through long-lived `git cat-file` children,
 * at most {@link MAX_LIVE_READERS} live, each started on the first ask that needs it.
 *
 * - From git 2.36 ({@link BATCH_COMMAND_SINCE}) one `cat-file --batch-command` per repository root
 *   answers both: `info <oid>` for a size, `contents <oid>` for the bytes. Before it, a root has a
 *   `--batch-check` child for sizes and a `--batch` child for bytes, each started on its first ask.
 *
 * - Requests are object names only (after `info ` or `contents ` to `--batch-command`), so no
 *   path crosses the pipe (no path encoding, no Windows quoting). Answers are framed by byte count
 *   ({@link frameBatchRecord}), so an object's bytes come back exactly as git stores them, whatever
 *   they hold.
 * - Never `--filters` or `--textconv`: the bytes are the stored blob's, and its header size is the
 *   unfiltered size.
 * - The environment is the one a non-ambient `runGit` gets ({@link scrubbedGitEnv}), with
 *   `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1` and `GIT_NO_REPLACE_OBJECTS=1`; from git 2.45 the global `--no-lazy-fetch`
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
import { type BatchCheckFrame, type BatchFrame, frameBatchCheckRecord, frameBatchRecord } from './git-cat-file.js';
import { OBJECT_READ_ENV, runGit, scrubbedGitEnv } from './git-run.js';
import { shownName } from './shown-text.js';
import { spawnHardened } from './spawn-hardened.js';
import { decodeTextContent } from './text-content.js';
import { countGitSpawn, countWork } from './work-counters.js';

/** The most `cat-file` children a set keeps live; one more retires the least recently used. */
const MAX_LIVE_READERS = 4;

/** The first git (major, minor) that takes the global `--no-lazy-fetch`. */
const NO_LAZY_FETCH_SINCE: GitVersion = [2, 45];

/**
 * The first git (major, minor) whose `cat-file` takes `--batch-command` (`info` and `contents` over
 * one pipe): git 2.36.0, per its release notes (Documentation/RelNotes/2.36.0.txt).
 */
const BATCH_COMMAND_SINCE: GitVersion = [2, 36];

/** The `cat-file` batch mode a child runs. */
type BatchMode = '--batch-command' | '--batch' | '--batch-check';

/** What one ask wants: a size (`info`) or the bytes (`contents`). */
type AskKind = 'info' | 'contents';

/**
 * Over the scrubbed environment: never prompt, never fetch an object a partial clone lacks, never
 * answer a name with its replace ref's replacement ({@link OBJECT_READ_ENV}).
 */
const READER_ENV: Readonly<Record<string, string>> = { ...OBJECT_READ_ENV, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };

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

/** One ask the child still owes, in request order. */
type PendingAsk =
  | { readonly kind: 'info'; readonly oid: string; readonly resolve: (size: number) => void; readonly reject: (error: unknown) => void }
  | { readonly kind: 'contents'; readonly oid: string; readonly resolve: (bytes: Uint8Array) => void; readonly reject: (error: unknown) => void };

/** A frame that holds a whole answer, or a fault: anything but "wait for more bytes". */
type SettledFrame = Exclude<BatchFrame | BatchCheckFrame, { kind: 'header-incomplete' } | { kind: 'body-incomplete' }>;

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

/** One repository's `git cat-file` child, in one {@link BatchMode}. */
class BatchReader {
  /** Resolves once the child has exited (or never started). */
  readonly exited: Promise<void>;
  private readonly child: ChildProcess;
  private readonly pending: PendingAsk[] = [];
  private chunks: Buffer[] = [];
  private held = 0;
  private needed = 0;
  private stderr = Buffer.alloc(0);
  private failure: Error | undefined;

  constructor(
    private readonly root: string,
    globals: readonly string[],
    private readonly mode: BatchMode,
  ) {
    // eslint-disable-next-line local/no-text-git-object-read -- a long-lived child streams its bytes; they are framed by count in receive(), never decoded
    const args = [...globals, 'cat-file', mode];
    countGitSpawn({ via: 'objectReader', args, cwd: root });
    const child = spawnHardened('git', args, { cwd: root, env: scrubbedGitEnv(READER_ENV), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        this.fail(new GitObjectReadError(root, `git cat-file ${mode} ended (${exitOf(code, signal)})${this.said()}`));
        resolve();
      });
      child.once('error', (error) => {
        this.fail(new GitObjectReadError(root, `git cat-file ${mode} could not run (${error.message})`, { cause: error }));
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

  /** Whether this child can answer no more asks. */
  get stopped(): boolean {
    return this.failure !== undefined;
  }

  /** One object's bytes. */
  read(oid: string): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.ask({ kind: 'contents', oid, resolve, reject });
    });
  }

  /** One blob's size. */
  size(oid: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.ask({ kind: 'info', oid, resolve, reject });
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

  /** Queue one ask and write its request line: `<kind> <oid>` to `--batch-command`, the bare name otherwise. */
  private ask(request: PendingAsk): void {
    if (this.failure !== undefined) {
      request.reject(this.failure);
      return;
    }
    this.pending.push(request);
    this.child.stdin?.write(this.mode === '--batch-command' ? `${request.kind} ${request.oid}\n` : `${request.oid}\n`);
  }

  /** git's stderr tail, as a reason's suffix. */
  private said(): string {
    const said = decodeTextContent(this.stderr).text.trim();
    return said === '' ? '' : `. git said: ${said}`;
  }

  /** Stop answering: reject every ask owed, and every later one, with `error`. */
  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.splice(0)) request.reject(error);
  }

  /** The record at `at`, framed as the oldest ask owed expects it: a header alone for `info`. */
  private frameAt(bytes: Buffer, at: number): BatchFrame | BatchCheckFrame {
    return this.pending[0]?.kind === 'info' ? frameBatchCheckRecord(bytes, at) : frameBatchRecord(bytes, at);
  }

  /** Take stdout bytes in; settle every whole answer they complete. */
  private receive(chunk: Buffer): void {
    // A stopped child owes nothing: what it still writes is dropped, never buffered and re-framed.
    if (this.failure !== undefined) return;
    this.chunks.push(chunk);
    this.held += chunk.length;
    if (this.held < this.needed) return;
    const bytes = this.chunks.length === 1 && this.chunks[0] !== undefined ? this.chunks[0] : Buffer.concat(this.chunks, this.held);
    let at = 0;
    let frame = this.frameAt(bytes, at);
    while (frame.kind !== 'header-incomplete' && frame.kind !== 'body-incomplete') {
      const next = this.settle(frame);
      if (next === undefined) {
        this.chunks = [];
        this.held = 0;
        this.needed = 0;
        return;
      }
      at = next;
      frame = this.frameAt(bytes, at);
    }
    this.needed = frame.kind === 'body-incomplete' ? frame.needed - at : 0;
    const rest = bytes.subarray(at);
    this.chunks = rest.length === 0 ? [] : [rest];
    this.held = rest.length;
  }

  /**
   * Settle the oldest ask with one whole frame.
   *
   * @returns Where the next frame starts, or undefined when this one is out of step with the
   *   requests: then the child is killed
   */
  private settle(frame: SettledFrame): number | undefined {
    const request = this.pending.shift();
    if (frame.kind === 'malformed-header' || frame.kind === 'unterminated' || request?.oid !== frame.oid) {
      const answered = frame.kind === 'malformed-header' ? 'a header it cannot read' : `an answer for ${frame.oid}`;
      const error = new Error(`git cat-file ${this.mode} at ${shownName(this.root)} wrote ${answered} when ${request?.oid ?? 'nothing'} was owed`);
      request?.reject(error);
      this.fail(error);
      this.child.kill();
      return undefined;
    }
    if (frame.kind === 'missing') {
      request.reject(new GitObjectMissingError(this.root, request.oid));
    } else if (frame.type !== 'blob') {
      request.reject(new Error(`${request.oid} at ${shownName(this.root)} is a ${frame.type}, not a blob`));
    } else if (request.kind === 'info' && frame.kind === 'info') {
      request.resolve(frame.size);
    } else if (request.kind === 'contents' && frame.kind === 'object') {
      countWork('content.gitRead', 1);
      request.resolve(frame.body);
    } else {
      // frameAt framed this record as the ask owed expects, so the two always agree.
      request.reject(new Error(`git cat-file ${this.mode} at ${shownName(this.root)} answered ${request.kind} for ${request.oid} with a ${frame.kind} record`));
    }
    return frame.next;
  }
}

/** Whether `version` is at least `since`; an unknown version is not. */
function atLeast(version: GitVersion | undefined, since: GitVersion): boolean {
  if (version === undefined) return false;
  const [major, minor] = version;
  const [sinceMajor, sinceMinor] = since;
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

/** A set of object readers, long-lived `cat-file` children per repository root; see the module header. */
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
   * One blob's size, from the root's long-lived child: `info` to `--batch-command`, or a
   * `--batch-check` child on a git before 2.36.
   *
   * @returns The size; rejects as {@link read} does
   */
  size(repositoryRoot: string, oid: string): Promise<number>;
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
  /** Live children by mode and root, least recently used first. */
  private readonly live = new Map<string, BatchReader>();
  private readonly exits: Array<Promise<void>> = [];
  private closed = false;
  private version: { readonly version: GitVersion | undefined } | undefined;
  private readonly onAbort = (): void => {
    // close() only awaits exits, which never reject.
    this.close().catch(() => undefined);
  };

  constructor(private readonly options: GitObjectReadersOptions) {
    if (options.signal?.aborted === true) this.closed = true;
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  guardsLazyFetch(): boolean {
    return atLeast(this.gitVersion(), NO_LAZY_FETCH_SINCE);
  }

  async read(repositoryRoot: string, oid: string): Promise<Uint8Array> {
    assertObjectName(oid);
    return await this.readerFor(repositoryRoot, 'contents').read(oid);
  }

  async size(repositoryRoot: string, oid: string): Promise<number> {
    assertObjectName(oid);
    return await this.readerFor(repositoryRoot, 'info').size(oid);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.options.signal?.removeEventListener('abort', this.onAbort);
    const closing = [...this.live.values()].map((reader) => reader.close());
    this.live.clear();
    await Promise.all([...closing, ...this.exits]);
  }

  /** The git version this set assumes: the one it was given, else git's own, asked once. */
  private gitVersion(): GitVersion | undefined {
    this.version ??= { version: this.options.gitVersion ?? probeGitVersion() };
    return this.version.version;
  }

  /** The mode that answers `kind`: `--batch-command` for both from git 2.36, else one mode each. */
  private modeFor(kind: AskKind): BatchMode {
    if (atLeast(this.gitVersion(), BATCH_COMMAND_SINCE)) return '--batch-command';
    return kind === 'info' ? '--batch-check' : '--batch';
  }

  /** The global options every `cat-file` here starts with. */
  private globals(): string[] {
    return this.guardsLazyFetch() ? ['--no-lazy-fetch'] : [];
  }

  /** The live child that answers `kind` at the root, most recently used now; started (retiring the oldest past the cap) if none is. */
  private readerFor(repositoryRoot: string, kind: AskKind): BatchReader {
    if (this.closed) throw new GitObjectReadError(repositoryRoot, 'the reader set was closed');
    const mode = this.modeFor(kind);
    const slot = `${mode} ${repositoryRoot}`;
    const held = this.live.get(slot);
    this.live.delete(slot);
    if (held !== undefined && !held.stopped) {
      this.live.set(slot, held);
      return held;
    }
    const oldest = this.live.entries().next();
    if (this.live.size >= MAX_LIVE_READERS && oldest.done !== true) {
      const [oldestSlot, oldestReader] = oldest.value;
      this.live.delete(oldestSlot);
      oldestReader.retire();
    }
    let reader: BatchReader;
    try {
      reader = new BatchReader(repositoryRoot, this.globals(), mode);
    } catch (error) {
      throw new GitObjectReadError(repositoryRoot, `git cat-file ${mode} could not start (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
    this.exits.push(reader.exited);
    this.live.set(slot, reader);
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
