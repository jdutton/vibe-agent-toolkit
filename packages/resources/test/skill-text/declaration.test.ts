import { describe, expect, it } from 'vitest';

import {
  SKILL_TEXT_DECLARATION,
  SKILL_TEXT_FAMILIES,
  SKILL_TEXT_PATTERN_IDS,
  skillTextDeclarationDigest,
} from '../../src/skill-text/declaration.js';

/** Every `family` a section of the declaration names, found by walking it. */
function sectionFamilies(value: unknown, found: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) sectionFamilies(item, found);
  } else if (typeof value === 'object' && value !== null && !(value instanceof RegExp)) {
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'family' || key.endsWith('Family')) && typeof child === 'string') found.add(child);
      else sectionFamilies(child, found);
    }
  }
  return found;
}

/** Every object reachable from the declaration, regexes included. */
function reachable(value: unknown, found: object[] = []): object[] {
  if (typeof value !== 'object' || value === null) return found;
  found.push(value);
  if (!(value instanceof RegExp)) for (const child of Object.values(value)) reachable(child, found);
  return found;
}

describe('SKILL_TEXT_DECLARATION', () => {
  it('is frozen all the way down, so no holder can change what the core reads', () => {
    const objects = reachable(SKILL_TEXT_DECLARATION);
    expect(objects.filter((object) => !Object.isFrozen(object))).toEqual([]);
    expect(objects.filter((object) => object instanceof RegExp).length).toBeGreaterThan(20);
  });

  it('refuses exec on a declared global regex, so a stray lastIndex cannot drop a later match', () => {
    const global = reachable(SKILL_TEXT_DECLARATION).filter(
      (object): object is RegExp => object instanceof RegExp && object.global,
    );
    expect(global.length).toBeGreaterThan(0);
    for (const regex of global) {
      expect(() => regex.exec('`a` b:c x')).toThrow(TypeError);
      expect(regex.lastIndex).toBe(0);
    }
  });

  it('lists exactly the families its sections name, both ways', () => {
    const named = sectionFamilies(SKILL_TEXT_DECLARATION, new Set());
    expect([...named].sort((a, b) => a.localeCompare(b))).toEqual(
      [...SKILL_TEXT_FAMILIES].sort((a, b) => a.localeCompare(b)),
    );
    expect(new Set(SKILL_TEXT_FAMILIES).size).toBe(SKILL_TEXT_FAMILIES.length);
  });

  it('gives every pattern id once', () => {
    expect(new Set(SKILL_TEXT_PATTERN_IDS).size).toBe(SKILL_TEXT_PATTERN_IDS.length);
    expect(SKILL_TEXT_PATTERN_IDS).toContain('claude-plugin-root');
    expect(SKILL_TEXT_PATTERN_IDS).toContain('EXTERNAL_CLI_AZ');
    expect(SKILL_TEXT_PATTERN_IDS).toContain('BROWSER_AUTH_WEBBROWSER_OPEN');
  });

  // Pins each literal to the composition the declaration's header documents: the declaration is
  // the only statement of the patterns, so the literal has no other statement of its structure.
  it('pins each composed literal to its documented composition', () => {
    const month = '(?:january|february|march|april|may|june|july|august|september|october|november|december)';
    const position = String.raw`(?:^|[|;&\x60])\s*`;
    const segment = String.raw`[^\n|;&\x60]*?`;
    const envVar = (name: string): string => String.raw`\$\{${name}\}|\$\{?env:${name}\b|\$\{?${name}\b`;
    const sourcesOf = (patterns: ReadonlyArray<{ pattern: RegExp }>): string[][] =>
      patterns.map(({ pattern }) => [pattern.source, pattern.flags]);

    expect(sourcesOf(SKILL_TEXT_DECLARATION.timeSensitive.patterns).slice(0, 4)).toEqual(
      ['as of', 'after', 'before', 'until'].map((phrase) => [String.raw`\b${phrase} ${month} \d{4}\b`, 'i']),
    );
    expect(sourcesOf(SKILL_TEXT_DECLARATION.nonPortableAsset.patterns).slice(0, 3)).toEqual(
      ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SKILL_DIR'].map((name) => [envVar(name), 'i']),
    );
    expect(sourcesOf(SKILL_TEXT_DECLARATION.nonPortableCommand.patterns)).toEqual([
      [position + String.raw`timeout\s+\S+`, ''],
      [position + String.raw`grep\b` + segment + String.raw`\s(?:-[A-Za-z]*P|--perl-regexp)\b`, ''],
      [position + String.raw`sed\b` + segment + String.raw`\s-i(?=\s|$)`, ''],
      [position + String.raw`readlink\b` + segment + String.raw`\s-[a-z]*f\b`, ''],
      [position + String.raw`date\b` + segment + String.raw`\s-d\b`, ''],
    ]);
    expect(sourcesOf(SKILL_TEXT_DECLARATION.compat.externalCli)).toEqual(
      SKILL_TEXT_DECLARATION.compat.externalCli.map(({ binary }) => [String.raw`(^|[\s;|&])${binary}(\s|$)`, 'm']),
    );
  });

  it('holds the external CLI table the compat evidence derives from', () => {
    expect(SKILL_TEXT_DECLARATION.compat.externalCli.map(({ binary, patternId }) => [binary, patternId])).toEqual([
      ['az', 'EXTERNAL_CLI_AZ'],
      ['aws', 'EXTERNAL_CLI_AWS'],
      ['gcloud', 'EXTERNAL_CLI_GCLOUD'],
      ['kubectl', 'EXTERNAL_CLI_KUBECTL'],
      ['docker', 'EXTERNAL_CLI_DOCKER'],
      ['terraform', 'EXTERNAL_CLI_TERRAFORM'],
      ['gh', 'EXTERNAL_CLI_GH'],
      ['op', 'EXTERNAL_CLI_OP'],
    ]);
  });
});

describe('skillTextDeclarationDigest', () => {
  const digest = skillTextDeclarationDigest(SKILL_TEXT_DECLARATION);

  it('is a stable sha256 hex', () => {
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(skillTextDeclarationDigest(SKILL_TEXT_DECLARATION)).toBe(digest);
  });

  it('moves with a regex source', () => {
    expect(skillTextDeclarationDigest({ ...SKILL_TEXT_DECLARATION, h1: /^#[ \t]([^\n]+)$/m })).not.toBe(digest);
  });

  it('moves with a regex flag', () => {
    expect(skillTextDeclarationDigest({ ...SKILL_TEXT_DECLARATION, h1: /^#[ \t]([^\n]*)$/mu })).not.toBe(digest);
  });

  it('moves with a constant', () => {
    const crossSkill = { ...SKILL_TEXT_DECLARATION.crossSkill, lookbehindChars: 61 };
    expect(skillTextDeclarationDigest({ ...SKILL_TEXT_DECLARATION, crossSkill } as typeof SKILL_TEXT_DECLARATION)).not.toBe(digest);
  });

  it('moves with array order', () => {
    const reordered = [...SKILL_TEXT_DECLARATION.timeSensitive.patterns].reverse();
    const timeSensitive = { ...SKILL_TEXT_DECLARATION.timeSensitive, patterns: reordered };
    expect(skillTextDeclarationDigest({ ...SKILL_TEXT_DECLARATION, timeSensitive } as typeof SKILL_TEXT_DECLARATION)).not.toBe(digest);
  });

  it('does not move with object key order', () => {
    const { h1, ...rest } = SKILL_TEXT_DECLARATION;
    expect(skillTextDeclarationDigest({ h1, ...rest })).toBe(digest);
  });
});
