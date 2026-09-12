/**
 * Rewrite pipeline: ordered when → vars → to.
 *
 * Each provider declares one or more rewrite rules. For an input URL the
 * pipeline strips `?query` and `#fragment`, finds the first rule whose
 * `when` regex matches, computes `vars` (templates over captures), and
 * renders the `to` template against captures + vars merged. The merged
 * context flows out so downstream header templates can interpolate the
 * same variables.
 *
 * Per design issue #113 §4 (vocabulary) and §5.2 (fragment/query
 * stripping must precede a greedy `(?<path>.+)` capture).
 */

import { renderTemplate } from './template.js';

export interface RewriteRule {
  readonly when: string;
  readonly vars?: Record<string, string>;
  readonly to: string;
}

export type RewriteOutcome =
  | {
      readonly matched: true;
      readonly rewrittenUrl: string;
      readonly context: Record<string, string>;
    }
  | { readonly matched: false };

/**
 * Thrown when a rule's `when` field is not a compilable regex.
 */
export class InvalidRewriteRuleError extends Error {
  constructor(pattern: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Invalid rewrite rule "when" regex: ${pattern}. ${reason}`);
    this.name = 'InvalidRewriteRuleError';
  }
}

/**
 * Thrown when a `vars` key collides with a named capture in `when`.
 * Adopter must rename one — vars cannot shadow captures (the design's
 * intent is captures + vars in a single namespace).
 */
export class VarCaptureCollisionError extends Error {
  constructor(name: string) {
    super(
      `Rewrite var "${name}" collides with a regex capture of the same name. Rename one.`,
    );
    this.name = 'VarCaptureCollisionError';
  }
}

/**
 * Apply an ordered list of rewrite rules to a URL.
 *
 * @returns `{ matched: true, rewrittenUrl, context }` for the first matching
 *   rule, or `{ matched: false }` if no rule claims the URL.
 * @throws {InvalidRewriteRuleError} if a `when` field does not compile
 * @throws {VarCaptureCollisionError} if a vars name shadows a capture name
 * @throws {TemplateMissingVarError} from a template referencing an unknown name
 * @throws {TemplateSyntaxError} from a malformed template expression
 * @throws {UnknownTransformError} from a template calling an unknown transform
 */
export function rewriteUrl(url: string, rules: readonly RewriteRule[]): RewriteOutcome {
  const stripped = stripFragmentAndQuery(url);

  for (const rule of rules) {
    const regex = compileWhen(rule.when);
    const match = regex.exec(stripped);
    if (match === null) continue;

    const captures = collectCaptures(match);
    const context = computeContext(captures, rule.vars);
    const rewrittenUrl = renderTemplate(rule.to, context);
    return { matched: true, rewrittenUrl, context };
  }

  return { matched: false };
}

function stripFragmentAndQuery(url: string): string {
  const idx = url.search(/[?#]/);
  return idx === -1 ? url : url.slice(0, idx);
}

/**
 * Compile a rule's `when` pattern — exported so the config-time check can ask
 * the same question the pipeline asks, with the same error.
 *
 * @throws {InvalidRewriteRuleError} if the pattern does not compile
 */
export function compileWhen(pattern: string): RegExp {
  try {
    // Rule patterns originate in trusted config (see design §8); runtime
    // compilation is intentional, not user-input regex injection.
    // eslint-disable-next-line security/detect-non-literal-regexp
    return new RegExp(pattern);
  } catch (e) {
    throw new InvalidRewriteRuleError(pattern, e);
  }
}

/**
 * The named capture groups a `when` pattern DECLARES — the names its captures
 * can contribute to a template context, read off the source without matching.
 *
 * `(?<name>` is a declaration unless the paren is escaped: `\(?<x>y` is an
 * optional literal paren followed by literal `<x>y`, and declares nothing.
 * Lookbehinds (`(?<=`, `(?<!`) never match because `=` and `!` cannot start
 * a group name. A group that is declared may still not PARTICIPATE in a given
 * match (`(?<q>\?.*)?`), which is why the runtime lane keeps its own check.
 *
 * @param pattern - A `when` source that {@link compileWhen} accepts
 * @returns The distinct group names, in declaration order
 */
export function namedGroupsOf(pattern: string): string[] {
  const names = new Set<string>();
  const opener = '(?<';
  for (let at = pattern.indexOf(opener); at !== -1; at = pattern.indexOf(opener, at + 1)) {
    // An odd run of backslashes before the paren escapes it.
    let slashes = 0;
    while (at - slashes - 1 >= 0 && pattern[at - slashes - 1] === '\\') slashes += 1;
    if (slashes % 2 === 1) continue;

    const name = GROUP_NAME.exec(pattern.slice(at + opener.length))?.[0];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

/** A group name at the start of the text, followed by its closing `>`. */
const GROUP_NAME = /^[A-Za-z_$][\w$]*(?=>)/;

function collectCaptures(match: RegExpExecArray): Record<string, string> {
  const captures = Object.create(null) as Record<string, string>;
  // The lib typedef for RegExpMatchArray.groups says values are `string`, but
  // optional named groups that did not match show up at runtime as `undefined`.
  // Cast to reflect runtime reality so the filter below is type-meaningful.
  const groups = (match.groups ?? {}) as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(groups)) {
    if (value !== undefined) {
      captures[key] = value;
    }
  }
  return captures;
}

function computeContext(
  captures: Record<string, string>,
  vars: Record<string, string> | undefined,
): Record<string, string> {
  const context = Object.create(null) as Record<string, string>;
  Object.assign(context, captures);

  if (vars === undefined) return context;

  for (const [name, template] of Object.entries(vars)) {
    if (Object.hasOwn(captures, name)) {
      throw new VarCaptureCollisionError(name);
    }
    context[name] = renderTemplate(template, captures);
  }

  return context;
}
