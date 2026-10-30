/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD starts a GRANDCHILD that idles for good — as a `git` it ran and did not wait for would —
 * writes its pid to `TEST_GRANDCHILD_PID_FILE`, and then runs to completion as usual, leaving the
 * grandchild behind in its process group. The grandchild holds none of the child's stdio, and the
 * child does not wait for it.
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

if (process.argv.includes('--supervised-by')) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  grandchild.unref();
  fs.writeFileSync(process.env['TEST_GRANDCHILD_PID_FILE'], String(grandchild.pid), 'utf-8');
}
