/**
 * The refusal map is a utility: loading it must not load a command module.
 *
 * Each command module below is replaced by a factory that throws, so the
 * import of `command-refusal.ts` fails if any route reaches one. The codes it
 * once borrowed from those modules must still map to their refusals.
 */

import { VatError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/commands/agent/install-path.js', () => {
  throw new Error('command-refusal.ts loaded commands/agent/install-path.ts');
});
vi.mock('../../src/commands/claude/plugin/tree-copy.js', () => {
  throw new Error('command-refusal.ts loaded commands/claude/plugin/tree-copy.ts');
});

describe('command-refusal.ts module boundary', () => {
  it('loads without loading any command module, and still maps the codes those modules throw', async () => {
    const { refusalCodeOf } = await import('../../src/utils/command-refusal.js');
    const { AGENT_NAME_ESCAPES_SCOPE_CODE, PLUGIN_SYMLINK_REFUSED_CODE } = await import('../../src/utils/command-error-codes.js');

    expect(refusalCodeOf(new VatError(AGENT_NAME_ESCAPES_SCOPE_CODE, 'x'))).toBe('USAGE_INVALID');
    expect(refusalCodeOf(new VatError(PLUGIN_SYMLINK_REFUSED_CODE, 'x'))).toBe('INPUT_UNREADABLE');
  });
});
