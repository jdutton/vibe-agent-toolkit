/**
 * `vat agent install` / `vat agent uninstall` join a positional into a scope
 * root and then `rm -rf` / copy / symlink the result. The sweep watched
 * `uninstall ../../../victim` delete a sibling of the repo at exit 0. Every
 * name the shared hostile table carries must be refused by name, with nothing
 * outside the root touched — and the legitimate names must still resolve,
 * INCLUDING an entry that is itself a symlink pointing out of the root, which
 * is exactly what `install --dev` creates.
 *
 * Two layers, deliberately. The helper is tested for what it decides; the two
 * SINKS are tested for what they do — replace `agentInstallPath` in either
 * verb with a bare `safePath.join` and only the sink cases go red. The scope
 * root is injected at the `scope-locations` seam: it is computed from
 * `process.cwd()` at module load, so it cannot be pointed at a fixture any
 * other way.
 */
import { existsSync, lstatSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { HOSTILE_NAMES, type HostileTree, hostileTreePerTest } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentInstallPath, AgentNameEscapesScopeError } from '../../src/commands/agent/install-path.js';
import { installAgent } from '../../src/commands/agent/install.js';
import { uninstallAgent } from '../../src/commands/agent/uninstall.js';

const scope = vi.hoisted(() => ({ root: '' }));

vi.mock('../../src/utils/scope-locations.js', () => ({
  validateAndGetScopeLocation: () => scope.root,
}));

describe('agentInstallPath', () => {
  const hostile = hostileTreePerTest('agent-install-path-');
  beforeEach(hostile.plant);
  afterEach(hostile.clear);
  const tree = (): HostileTree => hostile.tree();

  it.each(HOSTILE_NAMES)('refuses %j by name, and the victim outside the root survives', (name) => {
    expect(() => agentInstallPath(tree().root, name)).toThrow(AgentNameEscapesScopeError);
    expect(existsSync(safePath.join(tree().victim, 'secret.txt'))).toBe(true);
  });

  it('resolves an installed agent, a not-yet-installed one, and a dot-dot-named one', () => {
    expect(agentInstallPath(tree().root, 'member')).toBe(tree().member);
    expect(agentInstallPath(tree().root, 'not-yet')).toBe(safePath.join(tree().root, 'not-yet'));
    expect(agentInstallPath(tree().root, '..cache')).toBe(tree().dotdotNamed);
  });

  // A `--dev` install IS a symlink to the built skill outside the scope root.
  // A realpath check here read every live dev install as "outside" and made it
  // un-uninstallable and un-replaceable; the sink acts on the ENTRY, and `rm`
  // on a link removes the link, never its target.
  it('resolves an entry that is a symlink pointing outside the scope root (a --dev install)', ({ skip }) => {
    if (tree().linkOut === null) skip('host cannot create symlinks');
    expect(agentInstallPath(tree().root, 'link-out')).toBe(tree().linkOut);
  });

  it('still resolves an entry under a scope root that is itself reached through a symlink', ({ skip }) => {
    if (tree().rootAlias === null) skip('host cannot create symlinks');
    expect(agentInstallPath(tree().rootAlias, 'member')).toBe(safePath.join(tree().rootAlias, 'member'));
  });
});

/** Run a verb with `process.exit` returning (so the verb's own catch is not re-entered) and stdio captured. */
async function runVerb(fn: () => Promise<void>): Promise<{ exits: number[]; stderr: string }> {
  const exits: number[] = [];
  let stderr = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
  }) as never);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await fn();
  } finally {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    outSpy.mockRestore();
  }
  return { exits, stderr };
}

/** The sink refused by NAME: ERROR, the refusal on stderr, and the victim untouched. */
async function expectRefusedByName(victimDir: string, verb: () => Promise<void>): Promise<void> {
  const { exits, stderr } = await runVerb(verb);

  expect(exits).toEqual([ExitCode.ERROR]);
  expect(stderr).toContain('Refusing to touch "../victim"');
  expect(existsSync(safePath.join(victimDir, 'secret.txt'))).toBe(true);
}

describe('the install / uninstall sinks on a hostile tree', () => {
  const hostile = hostileTreePerTest('agent-install-sink-');
  beforeEach(() => {
    hostile.plant();
    scope.root = hostile.tree().root;
  });
  afterEach(hostile.clear);
  const tree = (): HostileTree => hostile.tree();

  it('uninstall ../victim is refused by name, ends on ERROR, and the victim survives', async () => {
    await expectRefusedByName(tree().victim, () => uninstallAgent('../victim', {}));
  });

  it('install ../victim --force is refused by name before the agent is even looked up, and the victim survives', async () => {
    await expectRefusedByName(tree().victim, () => installAgent('../victim', { force: true }));
  });

  it('uninstall of a --dev link pointing outside the root removes only the link; the target survives', async ({ skip }) => {
    if (tree().linkOut === null) skip('host cannot create symlinks');

    const { exits, stderr } = await runVerb(() => uninstallAgent('link-out', {}));

    expect(exits).toEqual([ExitCode.OK]);
    expect(stderr).toContain('Removed symlink');
    expect(existsSync(tree().linkOut ?? '')).toBe(false);
    expect(existsSync(safePath.join(tree().victim, 'secret.txt'))).toBe(true);
    expect(lstatSync(tree().victim).isDirectory()).toBe(true);
  });

  it('uninstall of a regular install removes exactly that directory', async () => {
    const { exits } = await runVerb(() => uninstallAgent('member', {}));

    expect(exits).toEqual([ExitCode.OK]);
    expect(existsSync(tree().member)).toBe(false);
    expect(existsSync(tree().dotdotNamed)).toBe(true);
  });
});
