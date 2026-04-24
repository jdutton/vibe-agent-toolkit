/**
 * Parsed representation of a git URL accepted by `vat audit`.
 *
 * - `cloneUrl` is the URL passed to `git clone` (after stripping ref/subpath
 *   fragments and after expanding GitHub shorthand to a full HTTPS URL).
 * - `ref` is an optional branch or tag name (deep commit SHAs are not
 *   guaranteed to work with shallow clone — see design spec for details).
 * - `subpath` is an optional subdirectory within the cloned repo to audit.
 */
export interface ParsedGitUrl {
  cloneUrl: string;
  ref?: string;
  subpath?: string;
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
  if (/^file:\/\//.test(trimmed)) {
    const { base, ref, subpath } = splitFragment(trimmed);
    return buildParsed(base, ref, subpath);
  }

  // HTTPS .git form: https://host/path.git[#ref[:subpath]]
  if (/^https?:\/\//.test(trimmed)) {
    const { base, ref, subpath } = splitFragment(trimmed);
    if (base.endsWith('.git')) {
      return buildParsed(base, ref, subpath);
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
      return buildParsed(`https://github.com/${owner}/${repo}.git`, webRef, webSubpath);
    }
  }

  // SSH ssh:// form: ssh://git@host/path[#ref[:subpath]]
  if (/^ssh:\/\//.test(trimmed)) {
    const { base, ref, subpath } = splitFragment(trimmed);
    return buildParsed(base, ref, subpath);
  }

  // SSH scp-like form: git@host:owner/repo.git[#ref[:subpath]]
  // Anchored, no alternation with nested quantifiers — safe from ReDoS.
  if (/^[^@\s]+@[^:\s]+:[^#\s]+/.test(trimmed)) {
    const { base, ref, subpath } = splitFragment(trimmed);
    return buildParsed(base, ref, subpath);
  }

  // GitHub shorthand: owner/repo (no path separators beyond the single /)
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (shorthand) {
    const owner = shorthand[1] ?? '';
    const repo = shorthand[2] ?? '';
    return buildParsed(`https://github.com/${owner}/${repo}.git`);
  }

  throw new Error(
    `Invalid git URL or path: ${input}. Accepted forms: ` +
      `https://<host>/<owner>/<repo>.git, ` +
      `git@<host>:<owner>/<repo>.git, ` +
      `<owner>/<repo>, or a local filesystem path.`
  );
}

function buildParsed(cloneUrl: string, ref?: string, subpath?: string): ParsedGitUrl {
  const result: ParsedGitUrl = { cloneUrl };
  if (ref !== undefined && ref !== '') result.ref = ref;
  if (subpath !== undefined && subpath !== '') result.subpath = subpath;
  return result;
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
  if (/^ssh:\/\//.test(trimmed)) return true;
  if (/^file:\/\//.test(trimmed)) return true;
  if (/^[^@\s]+@[^:\s]+:/.test(trimmed)) return true;

  // Strict GitHub shorthand: exactly two segments, no extension on second,
  // no path separators beyond the single /.
  return /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(trimmed);
}
