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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (parsed.username === '' && parsed.password === '') {
    return url;
  }

  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}
