/**
 * What `vat resources query --help` and `vat resources check --help` say about the workspace
 * relations, the `DATA_FILE_NO_ROWS` findings a run reports, and what `--check` narrows: each claim
 * as the code behaves.
 */

import { describe, expect, it } from 'vitest';

import { createResourcesCommand } from '../../src/commands/resources/index.js';
import { renderCommandHelp, subcommand } from '../help-text-helpers.js';

/** A subcommand's help with its line wrapping folded to single spaces, so a claim reads across a wrap. */
function helpOf(name: string): string {
  return renderCommandHelp(subcommand(createResourcesCommand(), name)).replaceAll(/\s+/gu, ' ');
}

describe('resources query and check --help', () => {
  it.each(['query', 'check'])('%s names the workspace relations among the derived relations', (name) => {
    const help = helpOf(name);
    for (const relation of ['workspace_packages', 'workspace_dependencies', 'workspace_conditions']) expect(help).toContain(relation);
  });

  it('query says which runs report DATA_FILE_NO_ROWS: only the files the workspace step reads, unless a data__* relation is named', () => {
    const help = helpOf('query');
    expect(help).not.toContain('the workspace step reads the same files');
    expect(help).toContain('only the files the workspace step reads');
  });

  it('query says a refused workspace relation exits 2 with RUN_INCOMPLETE or INPUT_UNREADABLE, and when each', () => {
    const exitCodes = helpOf('query').split('Exit Codes:')[1] ?? '';
    expect(exitCodes).toMatch(/WORKSPACE_\*.*RUN_INCOMPLETE.*INPUT_UNREADABLE/u);
  });

  it('check never claims --check skips a lens: every declared check drives the run', () => {
    const help = helpOf('check');
    expect(help).not.toContain('skips the cost of lenses');
    expect(help).toContain('every declared check');
    expect(help).not.toContain('when a check names a data__* or workspace_* relation');
  });
});
