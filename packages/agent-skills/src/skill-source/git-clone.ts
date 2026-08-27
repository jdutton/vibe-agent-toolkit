import { existsSync, readdirSync } from 'node:fs';

import {
  safePath,
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
): GitRunResult {
  const result = runGitSafely(args, {
    ...(cwd === undefined ? {} : { cwd }),
    env: envOverlay,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  const err = result.error as NodeJS.ErrnoException | undefined;
  if (err?.code === 'ETIMEDOUT') {
    throw new Error(
      `git ${args[0] ?? ''} timed out after ${(GIT_TIMEOUT_MS / 1000).toString()}s ` +
        `(possible unreachable remote or hang).`,
    );
  }
  return result;
}

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
  const ref = cloneShallow(parsed, targetTempdir);
  const commit = revParseHead(targetTempdir);
  const { subpath } = parsed;
  const targetDir = subpath ? safePath.join(targetTempdir, subpath) : targetTempdir;

  if (subpath !== undefined) {
    const resolvedTarget = safePath.resolve(targetDir);
    const resolvedTemp = safePath.resolve(targetTempdir);
    const inside =
      resolvedTarget === resolvedTemp || resolvedTarget.startsWith(`${resolvedTemp}/`);
    if (!inside) {
      throw new Error(
        `Subpath escapes the cloned repository: ${subpath}. ` +
          `Subpaths must be relative paths inside the repo (no \`..\` traversal).`,
      );
    }
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetDir = our tempdir + validated subpath
  if (!existsSync(targetDir)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own tempdir
    const topLevel = readdirSync(targetTempdir).join(', ');
    throw new Error(
      `Subpath not found in cloned repo: ${subpath ?? '(none)'}. Repo root contains: ${topLevel}.`,
    );
  }

  return { ref, commit, targetDir };
}

function cloneShallow(parsed: ParsedGitUrl, tempdir: string): string {
  // A shorthand-inferred URL clones non-interactively so a typo'd `owner/repo`
  // fails immediately instead of blocking on a credential prompt; an explicitly
  // typed URL keeps interactive auth, which may be exactly what the user wants.
  const { env, configArgs } = nonInteractiveGitOverrides(parsed);
  // `-c` overrides must precede the subcommand.
  const args = [...configArgs, 'clone', '--depth', '1', '--single-branch'];
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

/** Turn a non-zero `git clone` into the most specific error we can justify. */
function cloneFailure(parsed: ParsedGitUrl, stderr: string): Error {
  if (parsed.ref !== undefined && /not found|did not match/i.test(stderr)) {
    return new Error(
      `Reference not found in ${parsed.cloneUrl}: ${parsed.ref}. ` +
        `Hint: --depth 1 cloning cannot resolve arbitrary deep commit SHAs; try a branch or tag name.`,
    );
  }
  if (parsed.inferredFromShorthand) {
    // With prompts disabled, a nonexistent-or-private repo surfaces as an
    // authentication failure. Name the expansion, because the user never typed it.
    return new Error(
      `Clone failed:\n${stderr}\n` +
        `Hint: shorthand was expanded to ${parsed.cloneUrl}. Check the owner/repo spelling; ` +
        `if the repository is private, pass the full URL to authenticate interactively.`,
    );
  }
  return new Error(`Clone failed:\n${stderr}`);
}

function revParseHead(tempdir: string): string {
  // No overlay: this runs inside the finished clone and never touches a remote.
  const result = runGit(['rev-parse', 'HEAD'], {}, tempdir);
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error(`Failed to resolve HEAD commit in cloned repo: ${(result.stderr ?? '').trim()}`);
  }
  // Full 40-char SHA: the commit is the git cache key, so truncation risks cross-repo collisions.
  return (result.stdout ?? '').trim();
}
