/**
 * Config-time compilation of one linkAuth provider.
 *
 * Every question here is about the CONFIG — does the `match.host` glob
 * compile, does each `when` regex compile, is each template well-formed, does
 * each transform exist, does each template read only names the rule can
 * supply — and none of them needs a URL to answer. Asking them at
 * `buildLinkAuthEngineConfig` time means a mistyped provider refuses the run
 * by name, once, before any link is looked at.
 *
 * 🚨 **Why this is a refusal and not a per-link finding.** The engine used to
 * meet these defects one URL at a time and degrade each to
 * `{ outcome: 'unverified' }`, which the validator reports as
 * `LINK_AUTH_UNVERIFIED` — a warning whose registry remedy tells a token-less
 * CI lane to set it to `ignore`. An adopter who did that had every provider
 * typo swallowed: the link was neither authenticated nor checked anonymously,
 * and the run was green with a `linksChecked` count that nothing had fetched.
 * A provider that cannot compile is a config error; config errors are refused
 * (exit 2, named), like an invalid macro override already was.
 *
 * What this cannot see stays with the engine's runtime lane, reported under
 * `LINK_AUTH_PROVIDER_ERROR`: a declared capture group that did not
 * PARTICIPATE in one URL's match (`(?<q>\?.*)?`), and a transform refusing a
 * particular value (`urlencode` on a lone surrogate).
 *
 * Each check calls the SAME function the runtime lane calls — `compileWhen`,
 * `templateReferences` shares `renderTemplate`'s parser, `assertKnownTransform`
 * is `applyTransform`'s own test — so the two cannot disagree about what is
 * well-formed.
 */

import picomatch from 'picomatch';

import type { Provider } from './resolve.js';
import { compileWhen, namedGroupsOf } from './rewrite.js';
import { templateReferences } from './template.js';

/**
 * Thrown when a provider in `resources.linkAuth` cannot be compiled. The
 * message names the provider (index and host), the field, and the underlying
 * error, so the reader is sent to one line of their config.
 */
export class LinkAuthConfigError extends Error {
  /** The offending field, as a path under the provider: `rewrite[0].when`. */
  readonly field: string;

  constructor(providerLabel: string, field: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`resources.linkAuth ${providerLabel}: ${field} — ${detail}`);
    this.name = 'LinkAuthConfigError';
    this.field = field;
  }
}

/** The name every header template may read on top of the rule's captures and vars. */
const TOKEN_NAME = 'token';

/**
 * Refuse `provider` unless every static part of it compiles.
 *
 * @param provider - A fully-expanded provider (macro references already resolved)
 * @param index - Its position in `resources.linkAuth.providers`, for the message
 * @throws {LinkAuthConfigError} naming the first field that does not compile
 */
export function assertProviderCompiles(provider: Provider, index: number): void {
  const label = `providers[${String(index)}] (host "${provider.match.host}")`;
  const check = (field: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      throw new LinkAuthConfigError(label, field, error);
    }
  };

  check('match.host', () => picomatch(provider.match.host.toLowerCase()));
  for (const [i, pattern] of (provider.match.excludeHost ?? []).entries()) {
    check(`match.excludeHost[${String(i)}]`, () => picomatch(pattern.toLowerCase()));
  }

  // Every name any rule can put in a header context. Headers render against
  // whichever rule matched, so a name one rule declares is legitimate in a
  // header even though another rule will not supply it — the runtime lane
  // reports that per URL.
  const headerNames = new Set<string>([TOKEN_NAME]);

  for (const [i, rule] of provider.rewrite.entries()) {
    const at = `rewrite[${String(i)}]`;
    check(`${at}.when`, () => compileWhen(rule.when));
    const captures = namedGroupsOf(rule.when);
    const ruleNames = new Set(captures);

    for (const [name, template] of Object.entries(rule.vars ?? {})) {
      const field = `${at}.vars.${name}`;
      // Same collision the pipeline refuses at match time.
      check(field, () => {
        if (captures.includes(name)) {
          throw new Error(`var "${name}" collides with a capture of the same name in ${at}.when. Rename one.`);
        }
      });
      // A var renders against the captures only — not other vars, not the token.
      check(field, () => assertReadsOnly(template, new Set(captures), `${at}.when`));
      ruleNames.add(name);
    }

    check(`${at}.to`, () => assertReadsOnly(rule.to, ruleNames, `${at}.when or ${at}.vars`));
    for (const name of ruleNames) headerNames.add(name);
  }

  for (const [name, template] of Object.entries(provider.auth.headers)) {
    check(`auth.headers.${name}`, () => assertReadsOnly(template, headerNames, 'any rewrite rule'));
  }
  for (const [name, template] of Object.entries(provider.fetch?.headers ?? {})) {
    check(`fetch.headers.${name}`, () => assertReadsOnly(template, headerNames, 'any rewrite rule'));
  }
}

/**
 * Refuse a template that is malformed, calls an unknown transform, or reads a
 * name outside `declared`.
 *
 * @param template - The template to check, never rendered
 * @param declared - Every name the template's context can hold
 * @param declaredBy - Where those names come from, for the message
 */
function assertReadsOnly(template: string, declared: ReadonlySet<string>, declaredBy: string): void {
  for (const name of templateReferences(template)) {
    if (!declared.has(name)) {
      const known = [...declared].map((n) => `"${n}"`).join(', ');
      throw new Error(
        `template reads "${name}", which ${declaredBy} does not declare` +
          (known === '' ? ` (nothing is declared). Template: ${template}` : ` (declared: ${known}). Template: ${template}`),
      );
    }
  }
}
