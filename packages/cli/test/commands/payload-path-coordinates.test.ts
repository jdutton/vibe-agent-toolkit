/**
 * Every payload-emitting command states ONE root and publishes paths relative
 * to it.
 *
 * `vat audit` already answers "relative to what?" once, at the document
 * boundary, via `relativizePathEntries`. Four other commands answered it
 * differently — by not answering at all — and shipped `$HOME`-absolute paths in
 * machine-readable output. That is not cosmetic: an absolute path leaks the
 * operator's home directory into anything the payload is pasted into, makes two
 * runs of the same command on two machines diff against each other, and (for
 * `rag query`) put a RELATIVE `resourceId` directly above an ABSOLUTE
 * `filePath` in the same record — one document in two coordinate systems.
 *
 * These builders are pure: no CLI spawn, no file system, no `process.exit`.
 * The commands keep absolute paths internally (they are the identity every
 * registry and cache keys on) and re-base exactly once, here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { buildAgentListOutput } from '../../src/commands/agent/list.js';
import { buildQueryOutputData } from '../../src/commands/rag/query-command.js';
import { buildScanOutputData } from '../../src/commands/resources/scan.js';
import { formatSkillsYaml } from '../../src/commands/skills/list.js';

/**
 * Synthetic absolute paths, resolved rather than written as literals — on
 * Windows a driveless literal and a resolved path disagree, and
 * `safePath.relative` between them returns a drive-absolute string instead of
 * a subtree-relative one.
 */
const ROOT = safePath.resolve('/payload-root');
const README = safePath.resolve('/payload-root/docs/README.md');
const SKILL = safePath.resolve('/payload-root/skills/alpha/SKILL.md');
const AGENT_DIR = safePath.resolve('/payload-root/agents/alpha');

const README_REL = 'docs/README.md';
const SKILL_REL = 'skills/alpha/SKILL.md';
const AGENT_REL = 'agents/alpha';

/** Nothing in a payload may name the machine it ran on. */
function expectNoAbsolutePaths(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain(ROOT);
}

const SCAN_RESOURCE = {
  filePath: README,
  links: [{}, {}],
  headings: [{ children: [{}] }, {}],
  checksum: 'a'.repeat(64),
};

/** The scan payload for one README, with and without `--verbose`. */
function scanPayload(verbose: boolean) {
  return buildScanOutputData({
    resources: [SCAN_RESOURCE],
    root: ROOT,
    durationMs: 234,
    collections: undefined,
    verbose,
  });
}

describe('resources scan payload', () => {
  it('publishes each --verbose file path relative to the stated root', () => {
    const data = scanPayload(true);

    expect(data.root).toBe(ROOT);
    expect(data.files).toEqual([
      { path: README_REL, links: 2, anchors: 3, checksum: 'a'.repeat(64) },
    ]);
    expectNoAbsolutePaths(data.files);
  });

  it('names the duration field `durationSecs`, in seconds', () => {
    // The shipped help doc and the emitted payload have to agree on the field
    // name; a doc that says `duration: 234ms` describes a field that does not
    // exist.
    const data = scanPayload(false);

    expect(data.durationSecs).toBe(0.234);
    expect(data).not.toHaveProperty('duration');
  });

  it('omits the file list entirely without --verbose', () => {
    expect(scanPayload(false)).not.toHaveProperty('files');
  });
});

describe('skills list payload', () => {
  const skills = [{ name: 'alpha', path: SKILL, valid: true }];

  it('publishes each skill path relative to the stated root', () => {
    const yamlText = formatSkillsYaml(skills, 'project', ROOT);

    expect(yamlText).toContain(`root: ${ROOT}\n`);
    expect(yamlText).toContain(`    path: ${SKILL_REL}\n`);
    expect(yamlText).not.toContain(`path: ${SKILL}`);
  });

  it('leaves the entries it was handed unmutated', () => {
    formatSkillsYaml(skills, 'project', ROOT);

    expect(skills[0]?.path).toBe(SKILL);
  });
});

describe('agent list payload', () => {
  const agents = [
    { name: 'alpha', version: '0.1.0', path: AGENT_DIR, manifestPath: `${AGENT_DIR}/agent.yaml` },
  ];

  it('publishes each agent path relative to the stated root', () => {
    const data = buildAgentListOutput(agents, ROOT, 19);

    expect(data.root).toBe(ROOT);
    expect(data.agents).toEqual([{ name: 'alpha', version: '0.1.0', path: AGENT_REL }]);
    expect(data.count).toBe(1);
    expect(data.duration).toBe('19ms');
    expectNoAbsolutePaths(data.agents);
  });
});

describe('rag query payload', () => {
  const chunk = {
    chunkId: 'c1',
    resourceId: README_REL,
    filePath: README,
    content: 'body',
    contentHash: 'h',
    tokenCount: 4,
    embeddingModel: 'm',
    embeddedAt: new Date(0),
  };

  it('puts filePath in the same coordinate system as resourceId', () => {
    // The discriminating case for this command: `resourceId` was ALREADY
    // relative and sat one line above an absolute `filePath` in the same
    // record. A test that only checked "no absolute path anywhere" would pass
    // on a payload that dropped filePath altogether.
    const data = buildQueryOutputData({
      queryText: 'hello',
      chunks: [chunk],
      stats: { totalMatches: 1, searchDurationMs: 3 },
      durationMs: 12,
      root: ROOT,
    });

    expect(data.root).toBe(ROOT);
    const chunks = data.chunks as Array<{ filePath: string; resourceId: string }>;
    expect(chunks[0]?.filePath).toBe(README_REL);
    expect(chunks[0]?.resourceId).toBe(README_REL);
    expect(data.duration).toBe('12ms');
    expectNoAbsolutePaths(data.chunks);
  });
});

describe('packages/cli/docs/resources.md — the shipped scan reference', () => {
  // Runtime-loaded help text is the single source of truth for `vat resources
  // --help --verbose`, so a drifted example is a shipped lie, not a typo.
  const docPath = safePath.resolve(
    safePath.join(fileURLToPath(new URL('.', import.meta.url)), '../../docs/resources.md'),
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from this test file's own location
  const doc = readFileSync(docPath, 'utf8');
  const scanSection = doc.slice(
    doc.indexOf('### vat resources scan'),
    doc.indexOf('### vat resources validate'),
  );

  it('documents the scan options the command actually accepts', () => {
    expect(scanSection).toContain('`--verbose`');
    expect(scanSection).toContain('`--collection <id>`');
  });

  it('shows the duration field the command actually emits', () => {
    expect(scanSection).toContain('durationSecs:');
    expect(scanSection).not.toContain('duration: 234ms');
  });

  it('shows relative file paths under a stated root', () => {
    expect(scanSection).toContain('path: docs/README.md');
    expect(scanSection).toContain('root:');
  });
});
