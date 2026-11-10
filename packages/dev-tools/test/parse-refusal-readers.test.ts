/**
 * Every resource crawl in `src` reports the files whose parse it refused.
 *
 * A file whose parse was stopped at a limit, or lost with its worker, is in no
 * list a `ResourceRegistry` keeps but `getParseRefusedResources()`: not
 * admitted, not unreadable, not in `getAllResources()`. A consumer that crawls
 * and never reads that log drops a pathological document from its output at
 * exit 0. Nothing in the type system makes the read happen — the log must
 * outlive the crawl, for `validate()` and for registries shared across lanes —
 * so this test holds it from the tree.
 *
 * A file that runs a crawl — `.crawl(`, `.addResources(`, `.fromCrawl(`, or a
 * call to a builder named in {@link BUILDERS} — must do one of:
 *
 * 1. read `getParseRefusedResources()` itself;
 * 2. be a builder: hand the crawled registry out through the functions it is
 *    listed with here, whose every caller is then held to this same rule;
 * 3. be listed in {@link NOT_READ_HERE}, with how its refusals still reach
 *    the user, or why it has no user to reach.
 *
 * Both tables are asserted both ways: a builder must still crawl and define its
 * functions, and a {@link NOT_READ_HERE} entry must still crawl and must
 * not read the log itself (then it needs no entry).
 *
 * ⚠️ The detector is textual: a crawl reached through a name not listed here —
 * a new builder — is invisible until it is added to {@link BUILDERS}.
 */

import { describe, expect, it } from 'vitest';

import { packageSources } from './package-sources.js';

/** The registry's own crawl entry points, called as methods. */
const CRAWL_METHODS = ['crawl', 'addResources', 'fromCrawl'] as const;

/**
 * Files that hand a crawled registry out, and the functions they hand it out
 * through. Every caller of one of these is held to the rule in turn.
 */
const BUILDERS: Readonly<Record<string, readonly string[]>> = {
  // `vat resources scan`, `vat resources validate` and `vat rag index` each crawl through it.
  'packages/cli/src/utils/resource-loader.ts': ['loadResourcesWithConfig'],
};

/**
 * Files that crawl and do not read the refusal log themselves, with how the
 * refusals still reach the user, or why there is no user to reach.
 */
const NOT_READ_HERE: Readonly<Record<string, string>> = {
  'packages/cli/src/commands/resources/validate.ts':
    '`registry.validate()` reports every refused file as an error finding (`collectParseRefusedErrors`).',
  'packages/cli/src/commands/skills/validate.ts':
    'its shared registry reaches `registryForSkill` in `packaging-validator.ts`, which reads the log for every skill it validates.',
  'packages/cli/src/pipeline-oracles/lanes.ts':
    'an oracle that builds each lane\'s registry to compare their enumerations; it reports to no user.',
};

/** The registry itself: it defines the log and reads it in `validate()`. */
const OWNER = 'packages/resources/src/resource-registry.ts';

/** The read every crawler owes. */
const READ = 'getParseRefusedResources(';

/** What a comment line starts with, once indentation is trimmed. */
const COMMENT_STARTS = ['*', '//', '/*'] as const;

/** `text` with comment lines removed, so a JSDoc example is not a call. */
function code(text: string): string {
  const kept = text.split('\n').filter((line) => !COMMENT_STARTS.some((start) => line.trimStart().startsWith(start)));
  return kept.join('\n');
}

/** A character that continues an identifier or a member access, so `x` in `ax(` or `.x(` is not a call to `x`. */
function continuesName(char: string | undefined): boolean {
  return char !== undefined && (char === '.' || char === '_' || char === '$' || /[\p{L}\p{N}]/u.test(char));
}

/** Whether `body` calls the free function `name` — never its definition, never a method of that name. */
function callsFunction(body: string, name: string): boolean {
  const call = `${name}(`;
  for (let at = body.indexOf(call); at !== -1; at = body.indexOf(call, at + 1)) {
    if (!continuesName(body[at - 1]) && !body.slice(0, at).endsWith('function ')) return true;
  }
  return false;
}

/** Whether `body` calls one of the crawl entry points (builder definitions excluded). */
function crawls(body: string, builderNames: readonly string[]): boolean {
  return CRAWL_METHODS.some((method) => body.includes(`.${method}(`)) || builderNames.some((name) => callsFunction(body, name));
}

describe('every resource crawl reports its parse refusals', () => {
  const files = new Map([...packageSources()].map(([file, text]) => [file, code(text)]));
  const builderNames = Object.values(BUILDERS).flat();
  const crawlers = [...files].filter(([file, body]) => file !== OWNER && crawls(body, builderNames));

  it('finds the crawlers — at least the CLI resource loader', () => {
    expect(crawlers.map(([file]) => file)).toContain('packages/cli/src/utils/resource-loader.ts');
  });

  it('reads getParseRefusedResources(), hands the registry to a listed builder\'s callers, or is listed as not read here', () => {
    const unread = crawlers
      .filter(([file, body]) => !body.includes(READ) && BUILDERS[file] === undefined && NOT_READ_HERE[file] === undefined)
      .map(([file]) => file);
    expect(unread).toEqual([]);
  });

  it('lists only builders that still crawl and still define what they are listed with', () => {
    const stale = Object.entries(BUILDERS).flatMap(([file, names]) => {
      const body = files.get(file);
      if (body === undefined || !crawls(body, builderNames.filter((name) => !names.includes(name)))) return [file];
      return names.filter((name) => !body.includes(`function ${name}(`)).map((name) => `${file}#${name}`);
    });
    expect(stale).toEqual([]);
  });

  it('lists as not read here only files that still crawl and do not read the log themselves', () => {
    const stale = Object.keys(NOT_READ_HERE).filter((file) => {
      const body = files.get(file);
      return body === undefined || !crawls(body, builderNames) || body.includes(READ);
    });
    expect(stale).toEqual([]);
  });
});
