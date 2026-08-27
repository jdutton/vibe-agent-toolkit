/**
 * Render auth-header templates with rendered values, and a structural
 * redaction helper for serialization.
 *
 * `buildHeaders` renders each header value template against a context that
 * carries `${token}` plus any named captures / vars from the rewrite step.
 * `redactHeaders` masks `Authorization` values for any caller that needs to
 * serialize headers into logs, errors, or cache entries — the design's §8
 * "tokens never leak" claim depends on every such site routing through this.
 *
 * Per design issue #113 §4 (auth.headers vocabulary) and §8 (redaction is
 * structural; Authorization values never appear in serialized output).
 */

import { renderTemplate } from './template.js';

export const REDACTED_VALUE = '<redacted>';

/**
 * Header names whose values must be masked when serialized.
 *
 * v1 ships only `authorization` because that is the only secret-bearing
 * header the current macros emit. **Omission is the security risk** — any
 * future macro that emits a header carrying a secret (`Cookie`,
 * `Proxy-Authorization`, `X-API-Key`, custom bearer-style headers) must add
 * that name here, or the token will silently leak through serialization.
 * Extending the set is not the dangerous edit; forgetting to extend it is.
 */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set(['authorization']);

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
 * Return a copy of `headers` with sensitive values replaced by `REDACTED_VALUE`.
 * Header-name matching is case-insensitive but exact (no prefix matching) — a
 * header like `X-Authorization-Foo` is NOT considered sensitive.
 *
 * **Input must be a plain key-value object.** A `Headers` instance (Web Fetch
 * API) or a `Map` yields `[]` from `Object.entries` and would silently no-op
 * redaction — converting to a plain object is the caller's responsibility.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? REDACTED_VALUE : value;
  }
  return redacted;
}
