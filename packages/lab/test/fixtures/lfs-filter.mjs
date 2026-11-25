/**
 * The lab's stand-in for git-lfs's filter, for the `lfs-touch` arm (`src/facets/perf/lfs-touch.ts`).
 *
 * git runs it as `"<node>" "<this file>" clean|smudge` through `sh`, the file's bytes on stdin.
 * `clean` reads the whole file and writes an LFS-style pointer, as git-lfs does, so a stat-dirty
 * file can only be compared with its index entry by running this again over every byte. `smudge`
 * passes its input through. Each invocation appends `<bytes read>\n` to `$LAB_LFS_LOG` when set:
 * that log is how the arm counts git's filter work, which no counter inside VAT's process can see.
 */

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const mode = process.argv[2];
if (mode !== 'clean' && mode !== 'smudge') {
  process.stderr.write(`lfs-filter: expected 'clean' or 'smudge', got '${String(mode)}'\n`);
  process.exit(2);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);

const log = process.env.LAB_LFS_LOG;
if (log !== undefined && log !== '') appendFileSync(log, `${String(input.length)}\n`);

if (mode === 'clean') {
  const oid = createHash('sha256').update(input).digest('hex');
  process.stdout.write(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${String(input.length)}\n`);
} else {
  process.stdout.write(input);
}
