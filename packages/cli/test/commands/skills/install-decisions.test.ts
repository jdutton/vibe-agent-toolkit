/**
 * The refusals `vat skills install` makes before it fetches or copies anything, and the row it
 * publishes per skill — and the plan pieces every flat-skill install shares (`install-plan.ts`).
 */

import { TREE_DEST_OCCUPIED_CODE, VatError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { __internal } from '../../../src/commands/skills/install.js';
import { CommandRefusalError } from '../../../src/utils/command-refusal.js';
import { occupiedRefusal, skillCopyChange, skillOwnership } from '../../../src/utils/install-plan.js';
import { refusalOf } from '../../helpers/refusal-of.js';

const { assertInstallableName, assertNameOverrideApplies, assertNoNameCollisions, assertPlacement, planRow } = __internal;


describe('assertInstallableName', () => {
  it.each(['../victim', 'a/b', '.', '..', ''])('refuses %j as the invocation\'s mistake, saying where the name came from', (name) => {
    const refusal = refusalOf(() => assertInstallableName(name, 'declared in /src/SKILL.md'));
    expect(refusal.refusal).toBe('USAGE_INVALID');
    expect(refusal.message).toContain('(declared in /src/SKILL.md)');
  });

  it('accepts one path segment', () => {
    expect(() => assertInstallableName('my-skill', '--name')).not.toThrow();
  });
});

describe('assertNameOverrideApplies', () => {
  it('accepts --name for a single-skill source', () => {
    expect(() => assertNameOverrideApplies(1, 'renamed')).not.toThrow();
  });

  it('refuses --name over several skills, saying how many', () => {
    expect(refusalOf(() => assertNameOverrideApplies(3, 'renamed')).message).toBe('--name is only valid for single-skill sources; found 3 skills.');
  });

  it('refuses a --name that is not one segment before it counts the skills', () => {
    expect(refusalOf(() => assertNameOverrideApplies(3, '../x')).message).toContain('(--name)');
  });
});

describe('assertNoNameCollisions', () => {
  it('accepts distinct names', () => {
    expect(() => assertNoNameCollisions([{ name: 'a', dir: '/s/a' }, { name: 'b', dir: '/s/b' }])).not.toThrow();
  });

  it('refuses two skills declaring one name, naming both directories', () => {
    const refusal = refusalOf(() => assertNoNameCollisions([{ name: 'dup', dir: '/s/first' }, { name: 'other', dir: '/s/o' }, { name: 'dup', dir: '/s/second' }]));
    expect(refusal.refusal).toBe('USAGE_INVALID');
    expect(refusal.message).toContain('both declare the name "dup"');
    expect(refusal.message).toContain('  - /s/first\n  - /s/second');
  });
});

describe('assertPlacement', () => {
  it('accepts a known target and scope', () => {
    expect(() => assertPlacement('claude', 'user')).not.toThrow();
  });

  it('refuses an unknown target, then an unknown scope, each listing the valid ones', () => {
    expect(refusalOf(() => assertPlacement('emacs', 'user')).message).toMatch(/^Invalid --target "emacs"\. Valid targets: .*claude/);
    expect(refusalOf(() => assertPlacement('claude', 'galaxy')).message).toMatch(/^Invalid --scope "galaxy"\. Valid scopes: .*user/);
  });
});

describe('planRow', () => {
  const skill = { name: 'a', source: '/src/a', dest: '/home/u/.claude/skills/a' };

  it('says whether something was already there only under --dry-run', () => {
    expect(planRow(skill, true, true)).toEqual({ name: 'a', installPath: '/home/u/.claude/skills/a', alreadyInstalled: true });
    expect(planRow(skill, false, true)).toEqual({ name: 'a', installPath: '/home/u/.claude/skills/a', alreadyInstalled: false });
    expect(planRow(skill, true, false)).toEqual({ name: 'a', installPath: '/home/u/.claude/skills/a' });
  });
});

describe('install-plan', () => {
  it('--force takes whatever is at the destination; without it the destination must be free', () => {
    expect(skillOwnership(true)).toEqual({ kind: 'force' });
    expect(skillOwnership(false)).toEqual({ kind: 'must-be-free' });
  });

  it('a skill copy is one replace that keeps links as links and reads its source on the side given', () => {
    expect(skillCopyChange({ name: 'a', source: '/tmp/staged/a', dest: '/home/u/.claude/skills/a' }, 'environment', false)).toEqual({
      op: 'replace',
      dest: '/home/u/.claude/skills/a',
      ownership: { kind: 'must-be-free' },
      fill: { from: 'copy', source: '/tmp/staged/a', side: 'environment', links: 'preserve' },
      label: 'skill a',
    });
  });

  it('an occupied destination becomes the invocation\'s refusal naming --force, the plan\'s refusal kept as its cause', () => {
    const occupied = new VatError(TREE_DEST_OCCUPIED_CODE, '/home/u/.claude/skills/a holds 2 entries');
    const refusal = occupiedRefusal(occupied) as CommandRefusalError;
    expect(refusal).toBeInstanceOf(CommandRefusalError);
    expect(refusal.refusal).toBe('USAGE_INVALID');
    expect(refusal.message).toBe('Something already exists where the install goes: /home/u/.claude/skills/a holds 2 entries. Use --force to overwrite.');
    expect(refusal.cause).toBe(occupied);
  });

  it('any other failure is handed back as itself', () => {
    const other = new Error('ENOSPC');
    expect(occupiedRefusal(other)).toBe(other);
  });
});
