/**
 * The anchor base contract for one `vat audit` run.
 *
 * `ValidationIssue.location` is contractually a project-relative POSIX path,
 * but "relative to WHAT?" was answered per-resource by the nearest-ancestor
 * `vibe-agent-toolkit.config.yaml` walk-up. A single audit run spans many such
 * roots, so one document mixed coordinate systems and two DISTINCT files could
 * carry a byte-identical `location`.
 *
 * The contract these tests enforce: a run states its base ONCE (the invocation
 * scan root) and every `path`/`location` in the document is relative to it.
 *
 * Deliberately exhaustive: every assertion iterates EVERY emitted issue, not a
 * named subset — a suite that checks one named property per test is
 * structurally blind to producers added later.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

import fs from 'node:fs';

import { isAbsoluteAnyPlatform, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAuditReport } from '../../src/commands/audit.js';
import { anchorContractViolations, anchorsBelowRoot, pluginManifestLocations } from '../anchor-contract-helpers.js';
import { runAudit, silentLogger } from '../test-helpers.js';

/**
 * Two sibling VAT projects with byte-identical internal layout. Each owns a
 * `vibe-agent-toolkit.config.yaml`, so each is its own governing-config root —
 * the exact shape that let `plugins/plugin-a/.claude-plugin/plugin.json` name
 * two different files in one report.
 */
const PROJECTS = ['proj-alpha', 'proj-beta'] as const;

function writeFileAt(filePath: string, content: string): void {
  fs.mkdirSync(safePath.resolve(filePath, '..'), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Build one scan root containing two governing-config roots. Both ship a plugin
 * at the same in-project subpath and a skill under it, so the defect produces
 * colliding `location` values and the fix produces distinct ones.
 */
function buildScanRoot(root: string): void {
  for (const project of PROJECTS) {
    const projectDir = safePath.join(root, project);
    writeFileAt(safePath.join(projectDir, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n');
    const pluginDir = safePath.join(projectDir, 'plugins', 'plugin-a');
    // No `version` field → PLUGIN_MISSING_VERSION anchors at plugin.json.
    writeFileAt(
      safePath.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'plugin-a', description: `Plugin A of ${project}` }),
    );
    writeFileAt(
      safePath.join(pluginDir, 'skills', 'example', 'SKILL.md'),
      [
        '---',
        'name: example',
        'description: An example skill that exists only to emit findings anchored at its own SKILL.md.',
        'allowed-tools: [Bash]',
        '---',
        '',
        '# Example',
        '',
        'See [the missing reference](./missing-reference.md) for details.',
        '',
        // A link that RESOLVES is what populates `linkedFiles[]`. Without one,
        // every path-walking assertion below is vacuous on that branch of the
        // document — which is exactly how 532 absolute `linkedFiles[].path`
        // values survived a gate that already forbade absolute paths.
        'See [the resolvable guide](./references/guide.md) for the rest.',
        '',
        // A fenced shell block invoking an external CLI makes the compat
        // detectors emit EvidenceRecords, whose `location` is an OBJECT and so
        // needs the same anchor base as every string location in the document.
        '```bash',
        'az login',
        '```',
        '',
      ].join('\n'),
    );
    // The target of the resolvable link above. Its presence is what gives the
    // audit document a populated `linkedFiles[]` to walk.
    writeFileAt(
      safePath.join(pluginDir, 'skills', 'example', 'references', 'guide.md'),
      '# Guide\n\nReference content reachable by link traversal.\n',
    );
    // A script file and a third-party import make the plugin-level scanners
    // (script-file / python-import) emit evidence too, so the compat lane is
    // represented alongside the per-skill lane.
    writeFileAt(safePath.join(pluginDir, 'scripts', 'setup.py'), 'import requests\n');
  }
}

describe('vat audit — one run, one anchor base', () => {
  let scanRoot: string;

  beforeAll(() => {
    scanRoot = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-anchor-root-'));
    buildScanRoot(scanRoot);
  });

  afterAll(() => {
    fs.rmSync(scanRoot, { recursive: true, force: true });
  });

  it('anchors every issue location at the invocation scan root, not a per-resource config root', async () => {
    const results = await runAudit(scanRoot);
    expect(results.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    let issueCount = 0;
    for (const result of results) {
      for (const issue of result.issues) {
        issueCount += 1;
        const location = issue.location;
        if (location === undefined || location === '') continue;
        if (isAbsoluteAnyPlatform(location)) {
          offenders.push(`absolute location: ${location} (${issue.code})`);
          continue;
        }
        // The contract: joining the ONE stated root to the location names the
        // file the finding is in. Anything else means the base was something
        // the document never stated.
        if (!fs.existsSync(safePath.join(scanRoot, location))) {
          offenders.push(`${issue.code}: location "${location}" does not resolve under the scan root`);
        }
      }
    }

    expect(issueCount).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('emits exactly one absolute path — the top-level root — and re-bases every other path onto it', async () => {
    const { document } = await buildAuditReport(scanRoot, {}, Date.now(), silentLogger);

    expect(document.root).toBe(toForwardSlash(scanRoot));
    expect(isAbsoluteAnyPlatform(document.root)).toBe(true);

    const anchors = anchorsBelowRoot(document);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchorContractViolations(anchors, document.root)).toEqual([]);
  });

  // This gate already walked every path in the document and forbade absolutes,
  // yet 532 absolute `linkedFiles[].path` values passed it — because the fixture
  // had no resolvable link, so that branch of the document was always empty.
  // Assert the distinguishing power itself, or the coverage silently rots away
  // again the next time the fixture is simplified.
  it('actually has linked files to walk, so the absolute-path contract is not vacuous', async () => {
    const { document } = await buildAuditReport(scanRoot, {}, Date.now(), silentLogger);

    const linkedAnchors = anchorsBelowRoot(document).filter((a) => a.trail.includes('linkedFiles'));
    expect(linkedAnchors.length).toBeGreaterThan(0);
    expect(anchorContractViolations(linkedAnchors, document.root)).toEqual([]);
  });

  it('spells the resource that IS the scan root as `.`, never as a blank path', async () => {
    // Pointing audit at a single plugin makes that plugin the root, which
    // relativizes to the empty string. An empty path is a value every consumer
    // has to special-case; `.` is joinable and needs no special case.
    const pluginDir = safePath.join(scanRoot, PROJECTS[0], 'plugins', 'plugin-a');
    const { document } = await buildAuditReport(pluginDir, {}, Date.now(), silentLogger);

    const anchors = anchorsBelowRoot(document);
    expect(anchors.map((a) => a.value)).toContain('.');
    expect(anchorContractViolations(anchors, document.root)).toEqual([]);
  });

  it('anchors evidence `location.file` at the same root as every string location', async () => {
    // Evidence is omitted from terse output, so the anchor contract can only be
    // observed with --verbose; --compat additionally attaches the plugin-level
    // scanner evidence. Both lanes must answer "relative to what?" identically.
    const { document } = await buildAuditReport(
      scanRoot,
      { verbose: true, compat: true },
      Date.now(),
      silentLogger,
    );

    const anchors = anchorsBelowRoot(document);
    const evidenceAnchors = anchors.filter((a) => a.key === 'file');
    expect(evidenceAnchors.length).toBeGreaterThan(0);
    expect(anchorContractViolations(anchors, document.root)).toEqual([]);
  });

  it('gives the two same-named plugins distinct locations for their distinct manifests', async () => {
    const { document } = await buildAuditReport(scanRoot, {}, Date.now(), silentLogger);

    // A collision collapses these two strings into one.
    expect(pluginManifestLocations(anchorsBelowRoot(document))).toEqual(
      PROJECTS.map((p) => `${p}/plugins/plugin-a/.claude-plugin/plugin.json`),
    );
  });
});
