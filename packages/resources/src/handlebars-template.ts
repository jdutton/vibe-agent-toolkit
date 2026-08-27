/**
 * Cached Handlebars rendering for link-rewrite templates, with HTML escaping
 * disabled because the output is markdown rather than HTML.
 *
 * ⚠️ `link-auth/template.ts` also exports a renderer, and the two are NOT
 * interchangeable: that one is a `${...}` substituter with a fixed transform
 * whitelist, deliberately unable to evaluate an expression. This one compiles
 * arbitrary Handlebars. Rendering an untrusted link-auth rule through here would
 * hand it the full Handlebars expression language — the names differ so the two
 * cannot be swapped by autocomplete.
 */

import Handlebars from 'handlebars';

const templateCache = new Map<string, HandlebarsTemplateDelegate>();

/**
 * Render a Handlebars template with the given context.
 * Uses noEscape since this is for markdown content, not HTML.
 * Compiled templates are cached by template string.
 */
export function renderHandlebarsTemplate(
  template: string,
  context: Record<string, unknown>,
): string {
  let compiled = templateCache.get(template);
  if (!compiled) {
    // Safe: templates render markdown/plaintext, not HTML. No XSS risk.
    // eslint-disable-next-line sonarjs/disabled-auto-escaping
    compiled = Handlebars.compile(template, { noEscape: true });
    templateCache.set(template, compiled);
  }
  return compiled(context);
}
