/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD exits OK at import, having written nothing — no stdout and no progress-log entry.
 *
 * Parent and child share the environment, so the preload acts only in the process whose argv
 * carries `--cost-log`: the child a supervisor spawned. VAT's source gains no knob for this.
 */
import { ExitCode } from '@vibe-agent-toolkit/schema';

if (process.argv.includes('--cost-log')) {
  process.exit(ExitCode.OK);
}
