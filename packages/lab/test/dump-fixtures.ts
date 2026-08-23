/**
 * Writing a directory of dumps for a dump-reader suite to read.
 *
 * Not a test file — no `.test.ts` suffix, so the runner does not collect it.
 * Extracted because every facet whose measurement arrives as per-process JSON
 * needs the identical fixture: a fresh directory, some files in it, written
 * verbatim so a case can put malformed text there on purpose.
 */

import { mkdir, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';

/* eslint-disable security/detect-non-literal-fs-filename -- every path here is composed under a caller-supplied temp root */

/**
 * Write raw files into a fresh directory under a temp root.
 *
 * The contents are written **verbatim** rather than serialised here: half the
 * cases in a dump-reader suite are about text that is not a valid dump at all,
 * and a helper that took objects could not express them.
 *
 * @param root - Temp root the suite created
 * @param name - Directory label, so a failure names the case
 * @param files - File name to exact contents
 * @returns The directory that was written
 */
export async function writeDumpDir(
  root: string,
  name: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = safePath.join(root, name);
  await mkdir(directory, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(safePath.join(directory, file), content, 'utf-8');
  }
  return directory;
}
