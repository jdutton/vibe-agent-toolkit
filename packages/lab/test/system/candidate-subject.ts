/**
 * The built candidate vat and a clean neutral committed subject for it, shared
 * by the system files that check the candidate exits as the lab commits it will.
 */

import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils';

import type { InstrumentSource, ResolvedInstrument } from '../../src/harness/types.js';
import { PROBE_VERSION } from '../command-probe.js';
import { commitAll, initRepo, writeFixtureFile } from '../git-fixtures.js';
import { tempDir } from '../integration/verdict-fixtures.js';

const VAT_BIN = resolveFromImportMeta(import.meta.url, '../../../cli/dist/bin/vat.js');

/** The built vat at `packages/cli/dist/bin/vat.js`. */
export const CANDIDATE_VAT: ResolvedInstrument = { command: process.execPath, leadingArgs: [VAT_BIN], version: PROBE_VERSION };

/** How an operator would name {@link CANDIDATE_VAT}. */
export const CANDIDATE_SOURCE: InstrumentSource = { kind: 'dist', path: resolveFromImportMeta(import.meta.url, '../../../cli/dist') };

/**
 * Something for every CI verb to read — a resources collection, one doc, one
 * link, one skill — and nothing wrong in it. An empty config is NOT clean:
 * `skills validate` and `validate` exit 1 on "nothing to validate".
 */
const CONFIG = [
  'resources:',
  '  collections:',
  '    docs:',
  '      include:',
  '        - "docs/**/*.md"',
  'skills:',
  '  include:',
  '    - "skills/*/SKILL.md"',
  '',
].join('\n');

const SKILL = [
  '---',
  'name: sample-skill',
  'description: A neutral sample skill so the candidate build has one skill to validate',
  '---',
  '',
  '# Sample skill',
  '',
  'Read [the guide](../../docs/guide.md) first.',
  '',
].join('\n');

/**
 * @returns The root of a fresh committed clean subject (removed by `cleanupVerdictFixtures`)
 */
export function cleanSubject(): string {
  return candidateSubject({});
}

/**
 * The clean subject plus exactly one real finding: its doc links a page that does not exist.
 *
 * @returns The root of a fresh committed subject (removed by `cleanupVerdictFixtures`)
 */
export function brokenLinkSubject(): string {
  return candidateSubject({ 'docs/guide.md': '# guide\n\nSee [the missing page](missing.md).\n' });
}

/**
 * @param overrides - Relative path → content, over the clean subject's files
 * @returns The root of a fresh committed subject
 */
function candidateSubject(overrides: Readonly<Record<string, string>>): string {
  const root = tempDir('lab-candidate-subject-');
  initRepo(root);
  const files: Record<string, string> = {
    'vibe-agent-toolkit.config.yaml': CONFIG,
    'README.md': '# subject\n\nSee [the guide](docs/guide.md).\n',
    'docs/guide.md': '# guide\n',
    'skills/sample-skill/SKILL.md': SKILL,
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) writeFixtureFile(root, path, content);
  commitAll(root, 'subject');
  return root;
}
