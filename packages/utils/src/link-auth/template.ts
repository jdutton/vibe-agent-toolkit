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
 * This is NOT the project's general-purpose Handlebars renderer
 * (`utils/template.ts`) — that one is `{{...}}` and consumed widely. linkAuth
 * needs different syntax and a closed transform set; the two coexist by
 * namespace (`link-auth/template.ts`).
 */

import { applyTransform } from './transforms.js';

const IDENTIFIER = /^[a-zA-Z_]\w*$/;
const TRANSFORM_CALL = /^(?<fn>[a-zA-Z_]\w*)\((?<arg>[a-zA-Z_]\w*)\)$/;

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
  const rendered = template.replaceAll(/\$\{([^}]*)\}/g, (_match, body: string) =>
    resolveExpression(body, template, context),
  );

  if (rendered.includes('${')) {
    throw new TemplateSyntaxError('unterminated "${" with no matching "}"', template);
  }

  return rendered;
}

function resolveExpression(
  body: string,
  template: string,
  context: Record<string, string>,
): string {
  if (body !== body.trim()) {
    throw new TemplateSyntaxError(`whitespace in "${body}"`, template);
  }

  if (IDENTIFIER.test(body)) {
    return lookupContextVar(context, body, template);
  }

  const callMatch = TRANSFORM_CALL.exec(body);
  if (callMatch?.groups !== undefined) {
    const { fn, arg } = callMatch.groups;
    if (fn === undefined || arg === undefined) {
      throw new TemplateSyntaxError(`unexpected regex result for "${body}"`, template);
    }
    return applyTransform(fn, lookupContextVar(context, arg, template));
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
