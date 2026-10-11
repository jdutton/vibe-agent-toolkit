/** What the two format readers hand the archive module: an entry, and how to get at its bytes. */

import type { ArchiveEntry } from './entries.js';

/** One entry as a reader parsed it. */
export interface ArchiveRecord extends ArchiveEntry {
  /** Whether the archive marks the file executable — the only permission bit an extraction carries over. */
  readonly executable: boolean;
  /**
   * A file's bytes. A reader that inflates lazily does so here.
   *
   * @throws Whatever the format's reader throws for an entry that does not inflate
   */
  readonly read: () => Buffer;
}
