/**
 * Render auth-header templates, and the redaction helpers that keep the
 * rendered values out of anything VAT emits.
 *
 * `buildHeaders` renders each header value template against a context that
 * carries `${token}` plus any named captures / vars from the rewrite step.
 *
 * `sensitiveHeaderValues` + `redactSecretsInText` are how the design's §8
 * "tokens never leak" is actually enforced. One live call site:
 * `link-auth-transport.ts` runs them over anything `fetch` throws, which
 * reaches stdout through the validator. `link-auth/resolve.ts` deliberately
 * does NOT call them — its `provider-error` reason quotes a template, a
 * pattern or a name and never a substituted value, a property pinned by test
 * (see `describeProviderFailure` there); a scrub with no input that can carry
 * a token is a guard whose test passes with the call deleted.
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

import { inspect } from 'node:util';

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
 * 🔑 **A secret is matched in every form it commonly arrives in, not only
 * verbatim.** The JSON-escaped form matters most: a value carrying a NUL is
 * embedded by `JSON.stringify` as `\u0000`, so the exact header value no
 * longer occurs in the text while the token beside it does — and an exact
 * match let it through, measured. Percent-encoded, base64 and base64url
 * copies are one decode away from the credential, and a case-folded copy is
 * the same credential on a case-insensitive host. Each form is derived from
 * the secret, never from the text, so widening the net cannot shred unrelated
 * prose (see {@link secretForms}).
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
    .flatMap((secret) => secretForms(secret))
    .sort((a, b) => b.length - a.length);

  let out = text;
  for (const secret of usable) {
    out = replaceAllIgnoringCase(out, secret, REDACTED_VALUE);
  }
  return out;
}

/**
 * The spellings under which one secret can appear in a string: itself, its
 * JSON-escaped body, its `util.inspect`-escaped body, and its percent-, base64-
 * and base64url-encoded forms. Distinct, non-blank, and never shorter than
 * four characters — a three-character encoding of a short value would match
 * ordinary prose.
 *
 * The inspect form exists because `link-auth-transport.ts` probes a thrown
 * value with `util.inspect`, which quotes every string property and escapes
 * its control characters its own way (`\x00`, not JSON's `\u0000`) — so a
 * NUL-bearing credential on an own property matched neither the verbatim nor
 * the JSON form, measured.
 */
function secretForms(secret: string): string[] {
  const forms = new Set<string>([
    secret,
    JSON.stringify(secret).slice(1, -1),
    inspect(secret).slice(1, -1),
  ]);
  try {
    forms.add(encodeURIComponent(secret));
  } catch {
    // A lone surrogate cannot be percent-encoded; the other forms still apply.
  }
  const bytes = Buffer.from(secret, 'utf8');
  forms.add(bytes.toString('base64'));
  forms.add(bytes.toString('base64url'));
  return [...forms].filter((form) => form.trim().length >= MIN_FORM_LENGTH);
}

/** Below this an encoded form is too short to be a credential and long enough to shred prose. */
const MIN_FORM_LENGTH = 4;

/**
 * `text.replaceAll(needle, replacement)`, matching `needle` case-insensitively.
 *
 * Both sides are compared lower-cased; where lower-casing changes a length
 * (a handful of Unicode letters do) the offsets could not be trusted, so the
 * exact-case replacement is used instead — safe, if narrower.
 */
function replaceAllIgnoringCase(text: string, needle: string, replacement: string): string {
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  if (lowerText.length !== text.length || lowerNeedle.length !== needle.length) {
    return text.replaceAll(needle, replacement);
  }

  let out = '';
  let from = 0;
  for (let at = lowerText.indexOf(lowerNeedle); at !== -1; at = lowerText.indexOf(lowerNeedle, from)) {
    out += text.slice(from, at) + replacement;
    from = at + needle.length;
  }
  return out + text.slice(from);
}
