/**
 * Parsed representation of a git URL accepted by `vat audit`.
 *
 * - `cloneUrl` is the URL passed to `git clone` (after stripping ref/subpath
 *   fragments and after expanding GitHub shorthand to a full HTTPS URL).
 * - `ref` is an optional branch or tag name (deep commit SHAs are not
 *   guaranteed to work with shallow clone — see design spec for details).
 * - `subpath` is an optional subdirectory within the cloned repo to audit.
 * - `inferredFromShorthand` records whether `cloneUrl` was *inferred* from bare
 *   `owner/repo` shorthand rather than supplied verbatim by the user.
 */
export interface ParsedGitUrl {
  cloneUrl: string;
  ref?: string;
  subpath?: string;
  /**
   * True when `cloneUrl` was synthesized from bare GitHub shorthand
   * (`owner/repo`), false when the user typed a URL we pass through.
   *
   * This has to travel with the value: an expanded shorthand URL is
   * byte-identical to a hand-typed one, so a consumer cannot recover the
   * distinction by inspecting `cloneUrl`. Consumers need it because the two
   * cases warrant opposite credential policies — see
   * {@link nonInteractiveGitOverrides}.
   */
  inferredFromShorthand: boolean;
}

/**
 * Environment and `git -c` overrides that make a clone non-interactive.
 * Both collections are empty when no override is warranted.
 */
export interface NonInteractiveGitOverrides {
  /** Overlay to merge over `process.env` when spawning git. */
  env: Record<string, string>;
  /** `git -c <name>=<value>` arguments to place *before* the subcommand. */
  configArgs: string[];
}

/**
 * Split a URL with an optional `#ref[:subpath]` fragment into the base URL
 * and fragment components. Keeps the fragment-handling logic local so the
 * per-form regexes can stay simple and anchored.
 */
function splitFragment(input: string): { base: string; ref?: string; subpath?: string } {
  const hashIndex = input.indexOf('#');
  if (hashIndex === -1) {
    return { base: input };
  }
  const base = input.slice(0, hashIndex);
  const fragment = input.slice(hashIndex + 1);
  const colonIndex = fragment.indexOf(':');
  if (colonIndex === -1) {
    return { base, ref: fragment };
  }
  return {
    base,
    ref: fragment.slice(0, colonIndex),
    subpath: fragment.slice(colonIndex + 1),
  };
}

/**
 * Parse a string into a {@link ParsedGitUrl}.
 *
 * Accepted forms:
 *  - `https://host/owner/repo.git`
 *  - `https://host/owner/repo.git#ref`
 *  - `https://host/owner/repo.git#ref:subpath`
 *  - `https://github.com/owner/repo/tree/<ref>/<subpath>` (GitHub web URL)
 *  - `owner/repo` (GitHub shorthand → expanded to HTTPS)
 *  - `git@host:owner/repo.git`
 *  - `ssh://git@host/owner/repo.git`
 *
 * Throws on malformed input.
 */
export function parseGitUrl(input: string): ParsedGitUrl {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error(`Invalid git URL or path: <empty>.`);
  }

  // file:// form: file:///path/to/repo[#ref[:subpath]] — used primarily by
  // integration tests that clone a local bare repo. `git clone` accepts
  // file:// natively.
  if (trimmed.startsWith('file://')) {
    const { base, ref, subpath } = splitFragment(trimmed);
    return buildParsed(base, ref, subpath, false);
  }

  // HTTPS .git form: https://host/path.git[#ref[:subpath]]
  if (/^https?:\/\//.test(trimmed)) {
    const { base, ref, subpath } = splitFragment(trimmed);
    if (base.endsWith('.git')) {
      return buildParsed(base, ref, subpath, false);
    }

    // GitHub web URL: https://github.com/owner/repo/tree/<ref>[/<subpath>]
    const ghWeb =
      // eslint-disable-next-line security/detect-unsafe-regex -- Anchored ^...$ with bounded character classes; the only variable-length group is the trailing subpath. Safe from ReDoS.
      /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tree\/([^/]+)(?:\/(.+))?$/.exec(
        trimmed
      );
    if (ghWeb) {
      const owner = ghWeb[1] ?? '';
      const repo = ghWeb[2] ?? '';
      const webRef = ghWeb[3];
      const webSubpath = ghWeb[4];
      // A GitHub web URL is still something the user typed in full — only bare
      // `owner/repo` counts as inferred.
      return buildParsed(`https://github.com/${owner}/${repo}.git`, webRef, webSubpath, false);
    }
  }

  // SSH ssh:// form: ssh://git@host/path[#ref[:subpath]]
  if (trimmed.startsWith('ssh://')) {
    const { base, ref, subpath } = splitFragment(trimmed);
    return buildParsed(base, ref, subpath, false);
  }

  // SSH scp-like form: git@host:owner/repo.git[#ref[:subpath]]
  // Anchored, no alternation with nested quantifiers — safe from ReDoS.
  if (/^[^@\s]+@[^:\s]+:[^#\s]+/.test(trimmed)) {
    const { base, ref, subpath } = splitFragment(trimmed);
    return buildParsed(base, ref, subpath, false);
  }

  // GitHub shorthand: owner/repo[#ref[:subpath]] (single slash in base).
  // NOTE: this pattern is deliberately a superset of the stricter one in
  // `isGitUrl` (it also admits `.` inside a segment). `isGitUrl` gates every
  // call site, so it is the effective definition of "shorthand" in practice;
  // the two must stay in the isGitUrl ⊆ parseGitUrl direction, or an input
  // routed here as a URL would fall through to the "Invalid git URL" throw.
  const { base, ref, subpath } = splitFragment(trimmed);
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(base);
  if (shorthand) {
    const owner = shorthand[1] ?? '';
    const repo = shorthand[2] ?? '';
    return buildParsed(`https://github.com/${owner}/${repo}.git`, ref, subpath, true);
  }

  throw new Error(
    `Invalid git URL or path: ${input}. Accepted forms: ` +
      `https://<host>/<owner>/<repo>.git, ` +
      `git@<host>:<owner>/<repo>.git, ` +
      `<owner>/<repo>, or a local filesystem path.`
  );
}

function buildParsed(
  cloneUrl: string,
  ref: string | undefined,
  subpath: string | undefined,
  inferredFromShorthand: boolean
): ParsedGitUrl {
  const result: ParsedGitUrl = { cloneUrl, inferredFromShorthand };
  if (ref !== undefined && ref !== '') result.ref = ref;
  if (subpath !== undefined && subpath !== '') result.subpath = subpath;
  return result;
}

/**
 * Credential-prompt overrides for cloning `parsed`.
 *
 * **Only inferred shorthand gets them.** A user who typed a full
 * `https://…` URL for a private repo may legitimately intend to authenticate
 * interactively, and silently disabling that would break a real workflow. A
 * user who typed `owner/repo` and got it wrong should fail in milliseconds
 * instead of sitting on a credential prompt for a minute.
 *
 * Why this exact set (verified against git 2.50.1 with `git credential fill`):
 *
 * - `GIT_TERMINAL_PROMPT=0` — suppresses git's own TTY prompt. On its own it is
 *   **not** sufficient: `gitcredentials(7)` consults `GIT_ASKPASS`, then
 *   `core.askPass`, then `SSH_ASKPASS`, and only prompts on the terminal if all
 *   three are unset. Each askpass hook therefore bypasses this flag entirely —
 *   which is exactly the case inside VS Code's integrated terminal, where
 *   `GIT_ASKPASS` points at a GUI prompt.
 * - `GIT_ASKPASS=''` — `getenv()` returns a non-NULL empty string, so git stops
 *   walking the askpass chain *and* runs nothing, masking `core.askPass` and
 *   `SSH_ASKPASS` in one move.
 * - `SSH_ASKPASS=''` and `-c core.askPass=` — belt and braces for the same
 *   chain, because an empty-valued environment variable is not reliably
 *   distinguishable from an unset one on Windows. `-c` is used rather than
 *   `GIT_CONFIG_*` precisely because `-c` is additive: writing
 *   `GIT_CONFIG_COUNT` would silently clobber an overlay the caller supplied
 *   (VAT's own tests use `GIT_CONFIG_*` to rewrite remotes via `insteadOf`).
 * - `GCM_INTERACTIVE=never` — git's flags cannot reach a credential *helper*
 *   that opens its own UI. Git Credential Manager (the default on Git for
 *   Windows) is the common one; `never` still lets it serve a cached
 *   credential, it only forbids escalating to a prompt.
 *
 * What is deliberately **not** here: nothing resets `credential.helper` and
 * nothing sets `GIT_CONFIG_NOSYSTEM`. A helper holding a valid token is how a
 * private repo typed as shorthand still clones successfully; the goal is to
 * forbid *interaction*, not authentication.
 */
export function nonInteractiveGitOverrides(parsed: ParsedGitUrl): NonInteractiveGitOverrides {
  if (!parsed.inferredFromShorthand) {
    return { env: {}, configArgs: [] };
  }
  return {
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
    },
    configArgs: ['-c', 'core.askPass='],
  };
}

/**
 * Detect whether a string should be treated as a git URL (for the polymorphic
 * `[git-url-or-path]` audit argument). True for:
 *  - http(s):// URLs
 *  - ssh:// URLs
 *  - file:// URLs (used by integration tests against local bare repos)
 *  - git@host:path scp-style URLs
 *  - GitHub shorthand `owner/repo` (strict — no extensions, no extra slashes)
 *
 * Everything else (including relative paths like `./foo/bar`, absolute paths,
 * and multi-segment paths like `foo/bar/baz`) is treated as a filesystem path.
 */
export function isGitUrl(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed === '') return false;
  if (/^https?:\/\//.test(trimmed)) return true;
  if (trimmed.startsWith('ssh://')) return true;
  if (trimmed.startsWith('file://')) return true;
  // Match the same scp-style pattern parseGitUrl uses, including the
  // requirement of a non-empty path segment after the colon. Without the
  // trailing `[^#\s]+`, `isGitUrl` would accept inputs like `foo@host:`
  // that parseGitUrl then rejects with a less-helpful error.
  if (/^[^@\s]+@[^:\s]+:[^#\s]+/.test(trimmed)) return true;

  // Strict GitHub shorthand: exactly two segments, no extension on second,
  // no path separators beyond the single /. Strip any `#ref[:subpath]`
  // fragment first so `owner/repo#main` and `owner/repo#main:sub` are
  // recognized — `parseGitUrl` handles fragments uniformly across forms.
  const hashIndex = trimmed.indexOf('#');
  const base = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  return /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(base);
}
