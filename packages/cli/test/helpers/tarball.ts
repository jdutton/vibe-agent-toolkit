/**
 * A tar archive of regular files, entry by entry and in order — `tar.create`
 * packs a directory, and no directory can hold a file `a` and a file `a/b` at
 * once, which is exactly the archive an extraction must refuse.
 */
import * as tar from 'tar';

export function tarballOf(entries: ReadonlyArray<readonly [string, string]>): Buffer {
  const blocks = entries.flatMap(([path, body]) => {
    const data = Buffer.from(body);
    const header = new tar.Header({ path, mode: 0o644, size: data.length, type: 'File', mtime: new Date(0) });
    header.encode();
    return [header.block ?? Buffer.alloc(0), data, Buffer.alloc((512 - (data.length % 512)) % 512)];
  });
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
