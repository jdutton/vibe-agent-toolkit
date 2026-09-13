/**
 * Tiny template renderer for linkAuth rewrite + header templates.
 *
 * Syntax (strict, no escapes, no nesting):
 *   - `${name}`              → context[name]
 *   - `${transform(name)}`   → applyTransform(transform, context[name])
 *
 * Anything else inside `${...}` throws `TemplateSyntaxError`. Missing context
 * keys throw `TemplateMissingVarError`. Unknown transform names propagate
 * `UnknownTransformError` from the transforms allowlist.
 *
 * Every one of those is a question about the TEMPLATE, which comes from config
 * an author wrote. Substituted VALUES — URL captures, resolved tokens — are
 * inert: they are never parsed, never re-scanned, and can contain `${` freely.
 * See `assertNoUnterminatedExpression` for why that distinction is load-bearing.
 *
 * This is NOT the package's general-purpose Handlebars renderer
 * (`../handlebars-template.ts`, exported as `renderHandlebarsTemplate`) — that
 * one is `{{...}}` and compiles arbitrary expressions. linkAuth needs different
 * syntax and a closed transform set, so a rule reaching the Handlebars renderer
 * by mistake would gain an expression language it is designed not to have. The
 * two carry different function names for that reason, not only different paths.
 */

import { applyTransform, assertKnownTransform } from './transforms.js';

const IDENTIFIER = /^[a-zA-Z_]\w*$/;
const TRANSFORM_CALL = /^(?<fn>[a-zA-Z_]\w*)\((?<arg>[a-zA-Z_]\w*)\)$/;
const EXPRESSION = /\$\{([^}]*)\}/g;

/**
 * Thrown when a template references a variable not present in the context.
 * Message names the missing variable and includes the full template for
 * caller-side debugging.
 */
export class TemplateMissingVarError extends Error {
  constructor(varName: string, template: string) {
    super(`Template variable "${varName}" not in context. Template: ${template}`);
    this.name = 'TemplateMissingVarError';
  }
}

/**
 * Thrown when a template contains syntactically invalid content inside `${...}`
 * (empty expression, whitespace, unrecognized form) or an unterminated `${`.
 */
export class TemplateSyntaxError extends Error {
  constructor(detail: string, template: string) {
    super(`Invalid template syntax — ${detail}. Template: ${template}`);
    this.name = 'TemplateSyntaxError';
  }
}

/**
 * Render a template by substituting `${...}` expressions from a context map.
 *
 * @throws {TemplateMissingVarError} if a referenced variable is absent
 * @throws {TemplateSyntaxError} for invalid expressions or unterminated `${`
 * @throws {UnknownTransformError} from a `${transform(name)}` call
 */
export function renderTemplate(template: string, context: Record<string, string>): string {
  assertNoUnterminatedExpression(template);

  return template.replaceAll(EXPRESSION, (_match, body: string) => {
    const { name, transform } = parseExpression(body, template);
    const value = lookupContextVar(context, name, template);
    return transform === undefined ? value : applyTransform(transform, value);
  });
}

/**
 * Check a template WITHOUT rendering it, and say which names it reads.
 *
 * Every question that is about the template rather than about a value is
 * answered here — an unterminated `${`, whitespace or an unrecognized form
 * inside the braces, a transform outside the allowlist — with exactly the
 * error {@link renderTemplate} would throw for it. What is left for render
 * time is only whether the names it returns are in the context.
 *
 * This is what lets `buildLinkAuthEngineConfig` refuse a mistyped provider
 * before any URL is seen: a template defect used to surface per link, as an
 * `unverified` outcome under a code whose remedy is "set to ignore".
 *
 * @returns The distinct variable names the template reads, in first-use order
 * @throws {TemplateSyntaxError} for invalid expressions or unterminated `${`
 * @throws {UnknownTransformError} from a `${transform(name)}` call
 */
export function templateReferences(template: string): string[] {
  assertNoUnterminatedExpression(template);

  const names = new Set<string>();
  for (const [, body] of template.matchAll(EXPRESSION)) {
    const { name, transform } = parseExpression(body ?? '', template);
    if (transform !== undefined) assertKnownTransform(transform);
    names.add(name);
  }
  return [...names];
}

/**
 * Refuse a template carrying a `${` with no closing `}` — the author wrote
 * `${FOO` and meant `${FOO}`.
 *
 * 🚨 **Asked of the TEMPLATE, never of the rendered output.** The guard used to
 * run on the rendered string, which silently changed the question from "is this
 * template malformed?" to "did the adopter's DATA contain two characters?". A
 * Backstage software-template URL answers yes —
 * `…/skeleton/${{values.name}}/README.md` is an ordinary path segment — so an
 * ordinary link threw a programming error out of `vat resources validate` and
 * `vat audit` for every adopter with `resources.linkAuth` configured.
 *
 * 🔑 Substituted values are therefore **inert**: `String.replaceAll` does not
 * re-scan what a replacer function returns, and nothing inspects the result
 * afterwards. A value may contain `${`, `${{…}}`, or even a well-formed-looking
 * `${base64url(x)}` and it stays literal text.
 *
 * Erasing every well-formed `${…}` first is what makes the leftover `${`
 * unambiguous: only an expression that never closes can survive the erase.
 */
function assertNoUnterminatedExpression(template: string): void {
  if (template.replaceAll(/\$\{[^}]*\}/g, '').includes('${')) {
    throw new TemplateSyntaxError('unterminated "${" with no matching "}"', template);
  }
}

/**
 * The two forms an expression body may take: `name`, or `transform(name)`.
 *
 * Shared by the renderer and the static check so the two cannot disagree about
 * what is well-formed — the transform's EXISTENCE is not judged here (the
 * renderer learns it from `applyTransform`, the check from
 * `assertKnownTransform`), only the shape.
 */
function parseExpression(
  body: string,
  template: string,
): { readonly name: string; readonly transform?: string } {
  if (body !== body.trim()) {
    throw new TemplateSyntaxError(`whitespace in "${body}"`, template);
  }

  if (IDENTIFIER.test(body)) {
    return { name: body };
  }

  const callMatch = TRANSFORM_CALL.exec(body);
  if (callMatch?.groups !== undefined) {
    const { fn, arg } = callMatch.groups;
    if (fn === undefined || arg === undefined) {
      throw new TemplateSyntaxError(`unexpected regex result for "${body}"`, template);
    }
    return { name: arg, transform: fn };
  }

  throw new TemplateSyntaxError(`unrecognized expression "${body}"`, template);
}

/**
 * Fetch a variable from the context map, blocking prototype-chain bypass.
 *
 * Without `Object.hasOwn`, `context["__proto__"]` would return `Object.prototype`
 * (a non-undefined object) and the renderer would substitute `[object Object]`
 * into the output. Mirrors the closed-allowlist discipline in `transforms.ts`.
 */
function lookupContextVar(
  context: Record<string, string>,
  key: string,
  template: string,
): string {
  if (!Object.hasOwn(context, key)) {
    throw new TemplateMissingVarError(key, template);
  }
  const value = context[key];
  if (value === undefined) {
    throw new TemplateMissingVarError(key, template);
  }
  return value;
}
