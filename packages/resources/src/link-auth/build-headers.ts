/**
 * Render auth-header templates, and the redaction helpers that keep the
 * rendered values out of anything VAT emits.
 *
 * `buildHeaders` renders each header value template against a context that
 * carries `${token}` plus any named captures / vars from the rewrite step.
 *
 * `sensitiveHeaderValues` + `redactSecretsInText` are how the design's §8
 * "tokens never leak" is actually enforced. `link-auth-transport.ts` runs them
 * over anything `fetch` throws; `link-auth/resolve.ts` runs them over a
 * provider-config failure reason. Both of those reach stdout.
 *
 * 🚨 **They replaced a `redactHeaders(map) → map` helper that the docs named
 * as the §8 mechanism and that had ZERO production callers** — its only caller
 * was its own test, so §8 was a claim with a green suite behind it and nothing
 * else. It was also the wrong shape for the leak that was actually happening:
 * masking a header map VAT holds cannot touch a value undici has already
 * pasted verbatim into a `Headers.append` TypeError message.
 *
 * ⚠️ If a future caller does need to serialize a header MAP, reinstate a
 * structural masker — but wire it to a real call site in the same change.
 *
 * Per design issue #113 §4 (auth.headers vocabulary) and §8.
 */

import { renderTemplate } from './template.js';

export const REDACTED_VALUE = '<redacted>';

/**
 * Render a map of header templates into a map of concrete header values.
 *
 * @throws {TemplateMissingVarError} if a header template references an
 *   unknown context key
 * @throws {TemplateSyntaxError} from a malformed template expression
 * @throws {UnknownTransformError} from a template calling an unknown transform
 */
export function buildHeaders(
  templates: Record<string, string>,
  context: Record<string, string>,
): Record<string, string> {
  const headers = Object.create(null) as Record<string, string>;
  for (const [name, template] of Object.entries(templates)) {
    headers[name] = renderTemplate(template, context);
  }
  return headers;
}

/**
 * Collect every secret string that the given headers could leak, for
 * `redactSecretsInText`.
 *
 * 🔑 **Every value is a secret; the header NAME is not consulted.**
 * `auth.headers` / `fetch.headers` is an open record the adopter writes, and
 * each value is a rendered template that interpolates `${token}` — GitLab's
 * documented header is `PRIVATE-TOKEN`, API-key hosts use `X-API-Key`, and a
 * transform (`${base64(token)}`) can put the secret in a value that does not
 * contain the raw token at all. A name allowlist (`authorization` only, as v1
 * shipped) is the instance shape: whichever name it omits leaks verbatim
 * through the very undici `TypeError` this pair was measured on. Keying on
 * the rendered VALUE closes every name at once, and the cost is only that a
 * non-secret value such as `Accept: application/vnd.github+json` is masked
 * too if it ever appears in an error's text — a diagnostic blemish, never a
 * leak.
 *
 * Two strings per header, not one: the full value (`Bearer <tok>`, which is
 * what undici embeds in a `Headers.append` TypeError) **and** the credential
 * half of a `<scheme> <credential>` value (`<tok>`, which is what a
 * serializer that split the scheme off would print). Redacting only the full
 * value misses the second shape, and the second shape is the token itself.
 *
 * A blank value contributes nothing — replacing on `''` would splice the marker
 * between every character of the text, and replacing on whitespace would shred
 * it. Nothing is protected by either, so both are dropped.
 */
export function sensitiveHeaderValues(headers: Record<string, string>): readonly string[] {
  const secrets: string[] = [];
  for (const value of Object.values(headers)) {
    if (value.trim() === '') continue;
    secrets.push(value);
    const spaceIdx = value.indexOf(' ');
    const credential = spaceIdx === -1 ? '' : value.slice(spaceIdx + 1).trim();
    if (credential !== '') secrets.push(credential);
  }
  return secrets;
}

/**
 * Replace every occurrence of each secret in `text` with {@link REDACTED_VALUE}.
 *
 * This is the half of §8 a map masker (the deleted `redactHeaders`) could not
 * do: masking a header MAP is powerless once the value has already been
 * pasted into a string by something that never saw this module. The measured
 * instance is undici: `new Headers({ Authorization: 'Bearer <tok>\0' })` throws
 * `TypeError: Headers.append: "Bearer <tok>\0" is an invalid header value.` —
 * the token verbatim in `.message` and `.stack`, on its way to stdout via the
 * validator's `safeSerializeError`.
 *
 * Secrets are applied longest-first so an overlapping pair (`Bearer <tok>` and
 * `<tok>`) leaves one marker rather than `Bearer <redacted>`. Blank and
 * `undefined` entries are skipped — see {@link sensitiveHeaderValues}.
 */
export function redactSecretsInText(
  text: string,
  secrets: readonly (string | undefined)[],
): string {
  const usable = secrets
    .filter((s): s is string => s !== undefined && s.trim() !== '')
    .sort((a, b) => b.length - a.length);

  let out = text;
  for (const secret of usable) {
    out = out.replaceAll(secret, REDACTED_VALUE);
  }
  return out;
}
