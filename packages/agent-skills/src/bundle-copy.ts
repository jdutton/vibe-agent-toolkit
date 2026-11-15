/**
 * Copying one of the author's files into a skill bundle, classified once.
 *
 * A copy touches two trees and its errno does not say which one refused, so the
 * two sides are separate steps: the source is proven readable first (the `source`
 * side, origin `content`), and only then is the bundle written (the `destination`
 * side) — its reads still classified on the source's side by `copyRegularFile`. The
 * bundle's LAYOUT is decided by the skill's own `files:` config, so the write is
 * classified with `shapeFromSource`: a dest that lands on or under another dest's
 * file is the skill's to fix, while a full disk stays the destination's.
 *
 * The fault keeps `subject` in its `action`, so the message names what the author
 * can locate — a `files:` entry, a linked file — and not only the absolute path
 * the OS named.
 */

import { copyRegularFile, safePath, withFsFault } from '@vibe-agent-toolkit/utils';
import { openForReading } from '@vibe-agent-toolkit/utils/fs';

/**
 * Prove `path` readable by opening it for reading and closing it.
 *
 * Never `access(R_OK)`: Node documents that on Windows it ignores ACLs, so an
 * ACL-denied source passed it and then failed inside the copy, under the guard of
 * the wrong side.
 *
 * @param path A file the build is about to read
 */
async function proveReadable(path: string): Promise<void> {
  // Never blocks: a named pipe is refused (`EFTYPE`), not waited on for a writer.
  const handle = await openForReading(path);
  await handle.close();
}

/**
 * Copy one file into the bundle, creating the directory it lands in — only once the
 * source is proven readable, so a refused source never leaves a directory behind.
 *
 * The copy is made the one way a file is made in a tree VAT is building (`copyRegularFile`):
 * each directory on the way is a real one or is made, the file is created exclusively, and a
 * regular file already at the name is replaced. A file where one of its directories goes is the
 * skill's own layout — a `source` fault naming it — like every other shape the config decides.
 *
 * @param subject What the author can locate: `files: entry 'x'`, `linked file docs/a.md`
 * @param sourcePath The author's file
 * @param bundleRoot The bundle's root directory, which the packager made
 * @param targetPath Where it lands, under `bundleRoot`
 */
export async function copyIntoBundle(subject: string, sourcePath: string, bundleRoot: string, targetPath: string): Promise<void> {
  await withFsFault({ side: 'source', origin: 'content', action: `read ${subject}` }, () => proveReadable(sourcePath));
  await withFsFault({ side: 'destination', shapeFromSource: true, action: `copy ${subject} into the bundle` }, () =>
    copyRegularFile(sourcePath, bundleRoot, safePath.relative(bundleRoot, targetPath), { side: 'source', reading: subject, existing: 'replace', writing: `${subject} into the bundle` }));
}
