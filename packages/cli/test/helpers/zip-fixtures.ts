/**
 * REAL ZIP archives for tests, written with the same library the code reads.
 *
 * 🚨 Shared because the alternative was two copies, and the two copies were the
 * defect: every ZIP fixture in `org-skill-upload-payload.test.ts` used to be a
 * stand-in buffer that no ZIP reader could parse, so `inspectZipArchive`
 * returned `undefined` for all of them and the whole block guarded by it —
 * answer-key refusal, expanded-size refusal, title/name divergence — was
 * unreachable from that suite while it reported green.
 *
 * A test that wants to exercise an archive must write an archive. That is one
 * line here and it should stay one line, in one place.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';

/** One archive member: its entry name (ZIP fixes `/` as the separator) and its bytes. */
export type ZipFixtureEntry = readonly [entryName: string, content: Buffer];

/**
 * Write a real archive of `entries`, in the order given, and return its path.
 *
 * The ORDER is load-bearing for anything that elects one entry over another:
 * a reader that carries state across the loop reaches a different answer
 * depending on which SKILL.md it saw first, and only writing both orders can
 * see that.
 */
export function writeZipFixture(
  dir: string,
  fileName: string,
  entries: readonly ZipFixtureEntry[],
): string {
  const zipPath = safePath.join(dir, fileName);
  const zip = new AdmZip();
  for (const [entryName, content] of entries) zip.addFile(entryName, content);
  zip.writeZip(zipPath);
  return zipPath;
}

/** A SKILL.md declaring `name`, with an optional body after the frontmatter. */
export function skillMdBytes(name: string, body = `\n# ${name}\n`): Buffer {
  return Buffer.from(`---\nname: ${name}\ndescription: A fixture skill.\n---\n${body}`, 'utf8');
}
