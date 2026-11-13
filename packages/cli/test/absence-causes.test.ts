/**
 * The absence-cause enumeration, held both ways: against the static domain of
 * codes the packages export, and against its seeds.
 *
 * - Every code (and content state) in the static domain is classified exactly
 *   once, and nothing is classified that the domain does not hold.
 * - The seeded causes are the members: a member with no seed reds, and a seed
 *   naming anything else reds (test files are not typechecked, so the member
 *   type on a seed is documentation, and this is the check that fires).
 * - Each system seed file is exactly its template, so a seed cannot be deleted
 *   or skipped in the file; each lower-tier seed's named test exists, runs, and
 *   calls `expectAbsenceCause` on rows it did not write by hand.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as agentSkills from '@vibe-agent-toolkit/agent-skills';
import * as claudeMarketplace from '@vibe-agent-toolkit/claude-marketplace';
import * as resources from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  ABSENCE_EXEMPTIONS,
  ABSENCE_MEMBER_KEYS,
  CONTENT_STATE_KEYS,
  groupOf,
  memberEntry,
  siblingsOf,
  surfacedCodesOf,
  type AbsenceMember,
} from './helpers/absence-causes.js';
import { causeOf, LOWER_TIER_SEEDS, seedFilePath, seedFileText, SYSTEM_SEEDS, type SeedFileKey } from './helpers/absence-seeds.js';

const REPO_ROOT = safePath.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** Sorted, so a set compares as a list with a readable diff. */
function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/** Every string export of a barrel whose value is its own name: the barrel's exported codes. */
function selfNamedCodes(barrel: Record<string, unknown>): string[] {
  return Object.entries(barrel).filter(([name, value]) => value === name).map(([name]) => name);
}

/** The static domain: every code a row can carry that a package exports, and every content state. */
const STATIC_DOMAIN = sorted([
  ...resources.BLOB_REFUSAL_CONDITION_CODES,
  ...resources.BLOB_FINDING_CONDITION_CODES,
  ...CONTENT_STATE_KEYS,
  ...selfNamedCodes(resources),
  ...selfNamedCodes(claudeMarketplace),
  ...selfNamedCodes(agentSkills),
]);

describe('the enumeration covers the static domain', () => {
  it('classifies every code and content state exactly once: a member or an exemption, never both', () => {
    const exempt = Object.keys(ABSENCE_EXEMPTIONS);
    expect(exempt.filter((key) => (ABSENCE_MEMBER_KEYS as readonly string[]).includes(key))).toEqual([]);
    expect(sorted([...ABSENCE_MEMBER_KEYS, ...exempt])).toEqual(STATIC_DOMAIN);
  });

  it('reads the extent where new causes are likeliest: the filesystem extent\'s five codes are in the domain', () => {
    for (const code of [
      resources.EXTENT_DIRECTORY_UNLISTABLE,
      resources.EXTENT_SYMLINK_NOT_REALIZED,
      resources.EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT,
      resources.EXTENT_SYMLINK_TARGET_UNREADABLE,
      resources.EXTENT_SYMLINK_TARGET_UNRESOLVED,
    ]) {
      expect(STATIC_DOMAIN).toContain(code);
    }
  });

  it('keys each member by its own signature: the code, or contentState:<state>', () => {
    for (const member of ABSENCE_MEMBER_KEYS) {
      const { signature } = memberEntry(member);
      expect('contentState' in signature ? `contentState:${signature.contentState}` : signature.code).toBe(member);
    }
  });
});

describe('surfaced codes, siblings and groups, asked of production', () => {
  it('surfaces a blob member through the not-admitted contract, and a condition member under its own code', () => {
    expect(surfacedCodesOf(resources.BLOB_PARSE_LIMIT_EXCEEDED)).toEqual(['RESOURCE_PARSE_LIMIT_EXCEEDED']);
    expect(surfacedCodesOf(resources.BLOB_UNREADABLE)).toEqual(['RESOURCE_UNREADABLE']);
    expect(surfacedCodesOf('contentState:oversize')).toEqual(['RESOURCE_PARSE_LIMIT_EXCEEDED', 'RESOURCE_UNREADABLE']);
    expect(surfacedCodesOf(resources.EXTENT_DIRECTORY_UNLISTABLE)).toEqual([resources.EXTENT_DIRECTORY_UNLISTABLE]);
  });

  it('derives the siblings a seed must show none of from overlapping surfaced codes', () => {
    expect(siblingsOf(resources.BLOB_PARSE_LIMIT_EXCEEDED)).toEqual(['contentState:oversize']);
    expect(siblingsOf(resources.EXTENT_SYMLINK_NOT_REALIZED)).toEqual([]);
    expect(siblingsOf('contentState:oversize')).toContain(resources.BLOB_PARSE_LIMIT_EXCEEDED);
    expect(siblingsOf('contentState:oversize')).toContain('contentState:unreadable');
  });

  it('puts every member a finding cannot tell apart in one group', () => {
    expect(groupOf(resources.BLOB_PARSE_LIMIT_EXCEEDED)).toBe(groupOf(resources.BLOB_UNREADABLE));
    expect(groupOf(resources.BLOB_PARSE_WORKER_DIED)).not.toBe(groupOf(resources.BLOB_PARSE_LIMIT_EXCEEDED));
    expect(groupOf(resources.EXTENT_DIRECTORY_UNLISTABLE)).toBe(resources.EXTENT_DIRECTORY_UNLISTABLE);
  });
});

describe('members and seeds, both ways', () => {
  const systemCauses = Object.values(SYSTEM_SEEDS).flat().map((seed) => causeOf(seed));

  it('seeds every system-tier member with a system seed, and nothing else', () => {
    expect(systemCauses.filter((cause) => cause === undefined)).toEqual([]);
    expect(sorted(systemCauses as string[])).toEqual(sorted(ABSENCE_MEMBER_KEYS.filter((member) => memberEntry(member).tier === 'system')));
    expect(systemCauses).toHaveLength(new Set(systemCauses).size);
  });

  it('seeds every lower-tier member with a manifest row, and nothing else', () => {
    const lower = LOWER_TIER_SEEDS.map((seed) => seed.member);
    expect(sorted(lower)).toEqual(sorted(ABSENCE_MEMBER_KEYS.filter((member) => memberEntry(member).tier === 'lower')));
    expect(lower).toHaveLength(new Set(lower).size);
  });

  it.each(Object.keys(SYSTEM_SEEDS) as SeedFileKey[])('holds the %s seed file to its template', (key) => {
    expect(readFileSync(safePath.join(REPO_ROOT, seedFilePath(key)), 'utf-8')).toBe(seedFileText(key));
  });
});

// ── Finding a lower-tier seed's test ────────────────────────────────────────

/** The `it`/`test` call forms a manifest row may name. */
const TEST_FUNCTIONS = new Set(['it', 'test']);
const TEST_MODIFIERS = new Set(['each', 'skipIf', 'runIf']);
const SKIPPING_DESCRIBES = new Set(['skip', 'skipIf']);

/** Whether `callee` is `it`/`test`, or a modifier form called first (`it.each(...)`). */
function isTestCallee(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return TEST_FUNCTIONS.has(callee.text);
  if (!ts.isCallExpression(callee) || !ts.isPropertyAccessExpression(callee.expression)) return false;
  const { expression, name } = callee.expression;
  return ts.isIdentifier(expression) && TEST_FUNCTIONS.has(expression.text) && TEST_MODIFIERS.has(name.text);
}

/** Whether a call is `describe.skip(...)` or `describe.skipIf(...)(...)`. */
function isSkippingDescribe(call: ts.CallExpression): boolean {
  const access = ts.isCallExpression(call.expression) ? call.expression.expression : call.expression;
  return ts.isPropertyAccessExpression(access)
    && ts.isIdentifier(access.expression)
    && access.expression.text === 'describe'
    && SKIPPING_DESCRIBES.has(access.name.text);
}

/** Whether any call enclosing a node is a skipping `describe`. */
function isUnderSkippingDescribe(node: ts.Node): boolean {
  for (let parent: ts.Node = node.parent; !ts.isSourceFile(parent); parent = parent.parent) {
    if (ts.isCallExpression(parent) && isSkippingDescribe(parent)) return true;
  }
  return false;
}

/** Every call in a subtree. */
function callsIn(node: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** What a lower-tier seed's named test was found to hold. */
interface FoundTest {
  readonly found: number;
  /** The text of each `expectAbsenceCause` call's arguments whose first argument is not a literal. */
  readonly calls: readonly string[];
  /** Whether a call's first argument is a literal (rows written by hand). */
  readonly literalRows: boolean;
  readonly skippedByDescribe: boolean;
}

/** A literal the rows argument must never be: rows a test wrote are no evidence. */
function isLiteral(node: ts.Expression): boolean {
  return ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isLiteralExpression(node)
    || node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword;
}

/**
 * Find the test a manifest row names, and what its body calls.
 *
 * @param file - Repository-relative test file
 * @param testName - The title as written
 * @returns What was found
 */
function findTest(file: string, testName: string): FoundTest {
  const source = ts.createSourceFile(file, readFileSync(safePath.join(REPO_ROOT, file), 'utf-8'), ts.ScriptTarget.Latest, true);
  const tests = callsIn(source).filter((call) => {
    const [title] = call.arguments;
    return isTestCallee(call.expression) && title !== undefined && ts.isStringLiteralLike(title) && title.text === testName;
  });
  const [test] = tests;
  if (test === undefined) return { found: 0, calls: [], literalRows: false, skippedByDescribe: false };
  const absenceCalls = callsIn(test).filter((call) => ts.isIdentifier(call.expression) && call.expression.text === 'expectAbsenceCause');
  return {
    found: tests.length,
    calls: absenceCalls.filter((call) => call.arguments[0] !== undefined && !isLiteral(call.arguments[0])).map((call) => call.arguments.map((argument) => argument.getText(source)).join(', ')),
    literalRows: absenceCalls.some((call) => call.arguments[0] === undefined || isLiteral(call.arguments[0])),
    skippedByDescribe: isUnderSkippingDescribe(test),
  };
}

/** The text a call's signature argument must name: the member's code constant, or its state. */
function signatureToken(member: AbsenceMember): string {
  const { signature } = memberEntry(member);
  return 'contentState' in signature ? `'${signature.contentState}'` : signature.code;
}

describe('each lower-tier seed names a test that plants its member', () => {
  it.each(LOWER_TIER_SEEDS.map((seed) => [seed.member, seed] as const))('%s', (member, seed) => {
    const found = findTest(seed.file, seed.testName);
    expect(found.found, `exactly one test titled '${seed.testName}' in ${seed.file}`).toBe(1);
    expect(found.skippedByDescribe, 'inside describe.skip or describe.skipIf').toBe(false);
    expect(found.literalRows, 'expectAbsenceCause over rows the test wrote by hand').toBe(false);
    expect(found.calls.some((call) => call.includes(signatureToken(member))), `an expectAbsenceCause call naming ${signatureToken(member)}: ${found.calls.join(' / ')}`).toBe(true);
  });

  it('finds a modifier form, and reds a describe.skip around it (the finder\'s own positive controls)', () => {
    const fixture = [
      "describe.skip('off', () => { it.each([1])('inside', () => { expectAbsenceCause(rows, { code: X }); }); });",
      "it.skipIf(cond)('outside', () => { expectAbsenceCause({ blobConditions: [] }, { code: X }); });",
    ].join('\n');
    const source = ts.createSourceFile('fixture.ts', fixture, ts.ScriptTarget.Latest, true);
    const titled = callsIn(source).filter((call) => isTestCallee(call.expression)).map((call) => (call.arguments[0] as ts.StringLiteral).text);
    expect(titled).toEqual(['inside', 'outside']);
    const inside = callsIn(source).find((call) => isTestCallee(call.expression));
    expect(inside).toBeDefined();
    expect(isUnderSkippingDescribe(inside as ts.Node)).toBe(true);
    const outside = callsIn(source).filter((call) => ts.isIdentifier(call.expression) && call.expression.text === 'expectAbsenceCause');
    expect(outside.map((call) => isLiteral(call.arguments[0] as ts.Expression))).toEqual([false, true]);
  });
});
