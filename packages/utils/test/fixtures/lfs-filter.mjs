/**
 * The repository's stand-in for git-lfs's filter: the utils LFS key tests
 * (`test/integration/git-tree-key-lfs.integration.test.ts`) and the lab's `lfs-touch` arm
 * (`packages/lab/src/facets/perf/lfs-touch.ts`) both configure it.
 *
 * git runs it as `"<node>" "<this file>" clean|smudge` through `sh`, the file's bytes on stdin.
 * `clean` reads the whole file and writes an LFS-style pointer, as git-lfs does, so a stat-dirty
 * file can only be compared with its index entry by running this again over every byte. As git-lfs
 * does, `clean` writes a pointer it is handed back as that pointer (LF-terminated, whatever line
 * ending it arrived with: git-lfs reads a pointer line by line), so a file that is its pointer on
 * disk (not pulled) cleans to the blob already in the index. `smudge` passes its input through, so
 * a checkout leaves the pointer on disk. `clean-to` writes the bytes of `clean-to.blob` beside the
 * repository whatever it is handed: it records a file's stat against a blob git-lfs's own clean makes of it and this filter
 * cannot (a non-canonical pointer's canonical encoding, a file an extension cleans). Each invocation appends `<bytes read>\n` to `$LAB_LFS_LOG`
 * when set: that log is how the lab arm counts git's filter work, which no counter inside VAT's
 * process can see.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

const mode = process.argv[2];
if (mode !== 'clean' && mode !== 'clean-to' && mode !== 'smudge') {
  process.stderr.write(`lfs-filter: expected 'clean', 'clean-to' or 'smudge', got '${String(mode)}'\n`);
  process.exit(2);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);

const log = process.env.LAB_LFS_LOG;
if (log !== undefined && log !== '') appendFileSync(log, `${String(input.length)}\n`);

/** `clean-to`'s bytes: a fixed file beside the repository, as git runs a filter from the worktree root. No path comes from argv. */
const CLEAN_TO_BLOB = '../clean-to.blob';

/** A pointer's text, read as git-lfs reads one: small, its lines LF or CRLF. */
const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([0-9a-f]{64})\r?\nsize (\d+)\r?\n$/;

if (mode === 'clean-to') {
  process.stdout.write(readFileSync(CLEAN_TO_BLOB));
} else if (mode === 'clean') {
  const pointer = input.length < 1024 ? POINTER.exec(input.toString('latin1')) : null;
  const [oid, size] = pointer === null
    ? [createHash('sha256').update(input).digest('hex'), String(input.length)]
    : [pointer[1], pointer[2]];
  process.stdout.write(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`);
} else {
  process.stdout.write(input);
}
