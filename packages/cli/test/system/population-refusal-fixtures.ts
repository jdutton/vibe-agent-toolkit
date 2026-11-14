/**
 * The corpora and the one run helper the population-refusal system tests share: a committed
 * corpus beside an image the report stays silent about, a corpus holding one refused file in two
 * collections' worth of documents, and a run that reads the verb's published document.
 *
 * Every run is isolated in the scratch it is given: `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and
 * the temp directory (`TMPDIR`, `TEMP`, `TMP`) all point into it, and no projection store is
 * selected, so every run derives.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import yaml from 'yaml';

import { writeCommittedCorpus } from '../test-helpers.js';

import { executeCli, getBinPath, isolatedScratchEnv } from './test-common.js';

const binPath = getBinPath(import.meta.url);

/** PNG signature bytes: a NUL inside the sniff window, so the blob stage declines them as not text. */
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

/**
 * A committed corpus: `files` as given, plus the image the report stays silent about.
 *
 * @param scratch - The isolated scratch the corpus is written under
 * @param name - The corpus directory's name under scratch
 * @param files - Root-relative path → content
 * @returns The corpus root
 */
export function corpus(scratch: string, name: string, files: Readonly<Record<string, string | Buffer>>): string {
  return writeCommittedCorpus(safePath.join(scratch, name), { ...files, 'assets/logo.png': PNG_BYTES });
}

export const REFUSED_CODE = 'RESOURCE_PARSE_LIMIT_EXCEEDED';

/** What the verbs publish that the refused-file cases read. */
interface Published {
  examined: number;
  findings: Array<{ code: string; severity: string; location?: string; message: string }>;
}

/**
 * A corpus holding one refused file in two collections' worth of documents,
 * under `validation` (YAML lines nested under `resources:`, or none).
 *
 * The other documents are frontmatter only: `rag index` indexes such a document as empty and
 * loads no embedding model, so no run over this corpus downloads one.
 *
 * @param scratch - The isolated scratch the corpus is written under
 * @param name - The corpus directory's name under scratch
 * @param validation - The `resources.validation` block's lines
 * @returns The corpus root
 */
export function refusedCorpus(scratch: string, name: string, validation: readonly string[]): string {
  return corpus(scratch, name, {
    'vibe-agent-toolkit.config.yaml': [
      'resources:',
      '  include: ["docs/**/*.md", "notes/**/*.md"]',
      '  collections:',
      '    docs:',
      '      include: ["docs/**/*.md"]',
      '    notes:',
      '      include: ["notes/**/*.md"]',
      ...validation,
      '',
    ].join('\n'),
    'docs/a.md': '---\ntitle: A\n---\n',
    'docs/deep.md': `---\na: ${'['.repeat(1000)}${']'.repeat(1000)}\n---\n# Deep\n`,
    'notes/n.md': '---\ntitle: N\n---\n',
  });
}

/**
 * Run one verb in a corpus and read its published document.
 *
 * @param scratch - The isolated scratch the run is aimed at
 * @param root - The corpus root
 * @param args - The verb and its arguments
 * @param env - Variables to set over the isolated environment
 * @returns The exit status, the document, and stderr for failure messages
 */
export async function published(
  scratch: string,
  root: string,
  args: string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ status: number | null; report: Published; stderr: string }> {
  const result = await executeCli(binPath, args, { cwd: root, env: { ...isolatedScratchEnv(scratch), ...env } });
  return { status: result.status, report: yaml.parse(result.stdout) as Published, stderr: result.stderr };
}

/**
 * Run each verb in one corpus, side by side, and read each one's published document. The runs
 * share nothing but the corpus they read, so the order they finish in decides nothing.
 *
 * @param scratch - The isolated scratch the runs are aimed at
 * @param root - The corpus root
 * @param verbs - Each verb and its arguments
 * @returns Each run's arguments with what {@link published} returns, in the order of `verbs`
 */
export function publishedEach(
  scratch: string,
  root: string,
  verbs: readonly string[][],
): Promise<Array<{ args: string[]; status: number | null; report: Published; stderr: string }>> {
  return Promise.all(verbs.map(async (args) => ({ args, ...(await published(scratch, root, args)) })));
}

/** The refusal findings of a report. */
export function refusedIn(report: Published): Published['findings'] {
  return report.findings.filter((finding) => finding.code === REFUSED_CODE);
}
