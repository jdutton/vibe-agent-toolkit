/**
 * URL credential redaction for safe logging.
 *
 * Git remote URLs in VAT may carry embedded credentials — either because the
 * user configured a URL with userinfo, or because `resolveRemoteUrl()` injects
 * a CI token (e.g., `GH_TOKEN`) into HTTPS GitHub URLs for push authentication.
 * Those URLs must never reach stdout, stderr, or log files in raw form.
 *
 * Use `redactUrlCredentials()` on any URL immediately before logging it.
 * The tokenized URL can still be passed to child `git` processes — only the
 * logged copy is redacted.
 */

/**
 * Strip username and password from a URL string for safe logging.
 *
 * - URLs with userinfo (`https://user:pass@host/path`) → userinfo removed.
 * - URLs without userinfo → returned unchanged.
 * - Non-URL strings (short remote names like `origin`, SSH-style
 *   `git@github.com:owner/repo.git`, malformed input) → returned unchanged.
 *
 * This uses the standard `URL` constructor. SSH git URLs (`git@host:path`)
 * are not RFC 3986 URLs and will not parse — they pass through unchanged,
 * which is safe because they carry no URL-format userinfo anyway.
 *
 * @param url A URL string or short remote name.
 * @returns The input with any URL-format credentials removed.
 */
export function redactUrlCredentials(url: string): string {
  // Not a URL: nothing to redact. Asked as a question rather than caught as a
  // throw, so the only thing that reads as "not a URL" is exactly that.
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);

  if (parsed.username === '' && parsed.password === '') {
    return url;
  }

  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

/** A URL's `scheme://userinfo@` prefix inside free text; the userinfo stops at whitespace, a quote or a `/`. */
const URL_USERINFO_IN_TEXT = /\b([a-z][\d+.a-z-]*:\/\/)[^\s"'/@]+@/gi;

/**
 * Strip the userinfo of every URL embedded in free text — a git child's stderr, which echoes
 * the remote URL as it was given, injected CI token included.
 *
 * {@link redactUrlCredentials} takes one URL and returns any other string unchanged, so it
 * cannot be pointed at a message: `fatal: unable to access 'https://x-access-token:<t>@…'`
 * does not parse as a URL and passed through whole.
 */
export function redactUrlCredentialsInText(text: string): string {
  return text.replaceAll(URL_USERINFO_IN_TEXT, '$1');
}
