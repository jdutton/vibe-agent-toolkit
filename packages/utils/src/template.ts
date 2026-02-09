import Handlebars from 'handlebars';

const templateCache = new Map<string, HandlebarsTemplateDelegate>();

/**
 * Render a Handlebars template with the given context.
 * Uses noEscape since this is for markdown content, not HTML.
 * Compiled templates are cached by template string.
 */
export function renderTemplate(template: string, context: Record<string, unknown>): string {
  let compiled = templateCache.get(template);
  if (!compiled) {
    // Safe: templates render markdown/plaintext, not HTML. No XSS risk.
    // eslint-disable-next-line sonarjs/disabled-auto-escaping
    compiled = Handlebars.compile(template, { noEscape: true });
    templateCache.set(template, compiled);
  }
  return compiled(context);
}
