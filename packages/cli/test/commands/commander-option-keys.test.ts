/**
 * Commander's option-key shape, pinned at BOTH ends.
 *
 * Commander camelCases long option names, and represents a `--no-x` boolean as
 * the POSITIVE key `x` — defaulted to `true`, set to `false` only when the
 * negated flag is passed. It never produces a `noX` key, and never a kebab-case
 * `'base-path'` key. Three read sites in this package read exactly those
 * never-produced keys, so `--no-cache`, `--no-rewrite-links` and `--base-path`
 * were all silent no-ops. Worse, each command's own options *interface* declared
 * the wrong key shape, so TypeScript validated the broken reads against a type
 * that itself lied.
 *
 * A test that only exercised the resolvers would have stayed green through all
 * of that. The junction block below is the part that catches it: it parses a
 * REAL argv through the REAL Command factory and feeds Commander's own `opts()`
 * bag straight into the resolver. That goes red the moment the declaration and
 * the read disagree — which is precisely the defect.
 */

import { dirname } from 'node:path';

import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createResourcesCommand } from '../../src/commands/resources/index.js';
import { resolveNoCache } from '../../src/commands/resources/validate.js';
import {
  createPackageCommand,
  resolveBasePath,
  resolveRewriteLinks,
} from '../../src/commands/skills/package.js';

/** The positional `<skill-path>` used throughout, deep enough that dirname bites. */
const SKILL_ARG = 'skills/demo/SKILL.md';
/** A base path an operator would pass that is NOT dirname(SKILL_ARG). */
const CUSTOM_BASE = 'packages/demo';

/** Commander hands the action an untyped bag; the resolvers are what narrow it. */
function bag<T>(options: Record<string, unknown>): T {
  return options as unknown as T;
}

/**
 * Parse a real argv through a real Command and return the options Commander
 * actually built.
 *
 * `.exitOverride()` keeps a parse error from killing the test process, and the
 * no-op `.action()` displaces the real handler, which would otherwise touch the
 * filesystem and call `process.exit`.
 */
function parseOptions(root: Command, target: Command, argv: string[]): Record<string, unknown> {
  root.exitOverride();
  target.exitOverride();
  target.action(() => { /* displace the real handler */ });
  root.parse(argv, { from: 'user' });
  return target.opts();
}

function subcommand(root: Command, name: string): Command {
  const found = root.commands.find((candidate) => candidate.name() === name);
  if (!found) {
    throw new Error(`command factory no longer exposes a '${name}' subcommand`);
  }
  return found;
}

/** Options Commander builds for a real `vat resources validate` invocation. */
function resourcesValidateOptions(flags: string[]): Record<string, unknown> {
  const root = createResourcesCommand();
  return parseOptions(root, subcommand(root, 'validate'), ['validate', 'docs', ...flags]);
}

/** Options Commander builds for a real `vat skills package` invocation. */
function skillsPackageOptions(flags: string[]): Record<string, unknown> {
  const command = createPackageCommand();
  return parseOptions(command, command, [SKILL_ARG, '-o', 'out', ...flags]);
}

interface NegatableCase {
  readonly label: string;
  /** The POSITIVE key Commander really emits. */
  readonly key: string;
  /** Keys that look plausible but Commander never emits — reading one is the bug. */
  readonly phantomKeys: readonly string[];
  readonly resolve: (options: Record<string, unknown>) => boolean;
  /** Expected result for: key absent, key === false, key === true. */
  readonly whenAbsent: boolean;
  readonly whenFalse: boolean;
  readonly whenTrue: boolean;
}

const NEGATABLE_CASES: readonly NegatableCase[] = [
  {
    label: 'resolveNoCache (--no-cache)',
    key: 'cache',
    phantomKeys: ['noCache', 'no-cache'],
    resolve: (options) => resolveNoCache(bag(options)),
    whenAbsent: false,
    whenFalse: true,
    whenTrue: false,
  },
  {
    label: 'resolveRewriteLinks (--no-rewrite-links)',
    key: 'rewriteLinks',
    phantomKeys: ['noRewriteLinks', 'no-rewrite-links'],
    resolve: (options) => resolveRewriteLinks(bag(options)),
    whenAbsent: true,
    whenFalse: false,
    whenTrue: true,
  },
];

describe.each(NEGATABLE_CASES)('$label', (testCase) => {
  const { key, phantomKeys, resolve, whenAbsent, whenFalse, whenTrue } = testCase;

  it('treats an absent key as the opt-out default (feature ON)', () => {
    expect(resolve({})).toBe(whenAbsent);
  });

  it(`reacts to ${key} === false — how Commander records the negated flag`, () => {
    expect(resolve({ [key]: false })).toBe(whenFalse);
  });

  it(`leaves ${key} === true alone — the flag was not passed`, () => {
    expect(resolve({ [key]: true })).toBe(whenTrue);
  });

  it.each(phantomKeys)('ignores %s, a key Commander never produces', (phantom) => {
    expect(resolve({ [phantom]: true })).toBe(whenAbsent);
  });
});

describe('resolveBasePath', () => {
  it('falls back to the SKILL.md directory when basePath is absent', () => {
    expect(resolveBasePath(bag({}), SKILL_ARG)).toBe(dirname(SKILL_ARG));
  });

  it('uses the camelCase basePath key Commander produces', () => {
    expect(resolveBasePath(bag({ basePath: CUSTOM_BASE }), SKILL_ARG)).toBe(CUSTOM_BASE);
  });

  it("ignores a kebab-case 'base-path' key, which Commander never produces", () => {
    expect(resolveBasePath(bag({ 'base-path': CUSTOM_BASE }), SKILL_ARG)).toBe(dirname(SKILL_ARG));
  });
});

describe('junction: real argv → real Command → resolver', () => {
  it('vat resources validate --no-cache disables the external-URL cache', () => {
    expect(resolveNoCache(bag(resourcesValidateOptions(['--no-cache'])))).toBe(true);
  });

  it('vat resources validate without --no-cache keeps the cache on', () => {
    expect(resolveNoCache(bag(resourcesValidateOptions([])))).toBe(false);
  });

  it('vat skills package --no-rewrite-links turns link rewriting off', () => {
    expect(resolveRewriteLinks(bag(skillsPackageOptions(['--no-rewrite-links'])))).toBe(false);
  });

  it('vat skills package without --no-rewrite-links keeps rewriting on', () => {
    expect(resolveRewriteLinks(bag(skillsPackageOptions([])))).toBe(true);
  });

  it('vat skills package --base-path <path> becomes the base path', () => {
    expect(resolveBasePath(bag(skillsPackageOptions(['--base-path', CUSTOM_BASE])), SKILL_ARG)).toBe(
      CUSTOM_BASE
    );
  });

  it('vat skills package -b <path> becomes the base path', () => {
    expect(resolveBasePath(bag(skillsPackageOptions(['-b', CUSTOM_BASE])), SKILL_ARG)).toBe(CUSTOM_BASE);
  });

  it('vat skills package without --base-path falls back to the SKILL.md directory', () => {
    expect(resolveBasePath(bag(skillsPackageOptions([])), SKILL_ARG)).toBe(dirname(SKILL_ARG));
  });
});

describe('the key shapes Commander actually emits', () => {
  const EMITTED: readonly [string, () => Record<string, unknown>, string, readonly string[]][] = [
    ['resources validate --no-cache', () => resourcesValidateOptions(['--no-cache']), 'cache', ['noCache', 'no-cache']],
    ['skills package --no-rewrite-links', () => skillsPackageOptions(['--no-rewrite-links']), 'rewriteLinks', ['noRewriteLinks', 'no-rewrite-links']],
    ['skills package --base-path', () => skillsPackageOptions(['--base-path', CUSTOM_BASE]), 'basePath', ['base-path']],
  ];

  it.each(EMITTED)('%s produces only the camelCase positive key', (_label, parse, positive, phantoms) => {
    const options = parse();
    expect(options).toHaveProperty(positive);
    for (const phantom of phantoms) {
      expect(options).not.toHaveProperty(phantom);
    }
  });
});
