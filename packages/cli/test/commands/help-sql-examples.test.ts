/**
 * Every SQL statement the help text — and the skill that teaches the same
 * surface — shows an adopter compiles against the real schema.
 *
 * `vat resources query --help` shipped `SELECT target FROM blob_references WHERE
 * kind = ?` — neither column exists — and a copied example is the first thing an
 * adopter runs. Help text is prose nothing executes, so a renamed column leaves
 * it wrong with every suite green.
 *
 * Compiled, never run: `assertCompiles` resolves every table and column at
 * prepare time against the compile probe, which holds the materialised AND
 * the derived relations, so no population is needed.
 */

import { readFileSync } from 'node:fs';

import { openProjectionCompileProbe } from '@vibe-agent-toolkit/projection-sqlite';
import type { Command } from 'commander';
import { afterAll, describe, expect, it } from 'vitest';

import { createResourcesCommand } from '../../src/commands/resources/index.js';
import { renderCommandHelp } from '../help-text-helpers.js';

/** A statement as the help shows it, with the values its placeholders take. */
interface HelpStatement {
  readonly sql: string;
  readonly parameters: readonly string[];
}

/** A line that opens a statement block, once trimmed. */
const STATEMENT_START = /^(?:SELECT|WITH)\s/;

/** What opens a `[$ ]vat resources query '<sql>' [--param <value>]...` example line. */
const QUERY_EXAMPLE = 'vat resources query ';

/**
 * The width of a line's leading whitespace.
 *
 * @param line - One help line
 * @returns How many leading spaces it has
 */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Every indented statement block: a line opening with SELECT or WITH, and the
 * non-blank lines after it indented at least as deep, up to a closing fence.
 *
 * @param help - Rendered help
 * @returns One entry per block
 */
function statementBlocks(help: string): HelpStatement[] {
  const lines = help.split('\n');
  const found: HelpStatement[] = [];
  for (let index = 0; index < lines.length; index++) {
    const first = lines[index] ?? '';
    if (!STATEMENT_START.test(first.trimStart())) continue;
    const depth = indentOf(first);
    const body = [first];
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? '';
      if (next.trim() === '' || indentOf(next) < depth || next.trimStart().startsWith('```')) break;
      body.push(next);
      index++;
    }
    const sql = body.join('\n');
    // A block's placeholders are filled by the reader (`--param`); bind a value
    // per `?` so the count gate passes and the NAMES are what gets checked.
    found.push({ sql, parameters: Array.from({ length: sql.split('?').length - 1 }, () => 'x') });
  }
  return found;
}

/**
 * Every `$ vat resources query` example, with its `--param` values.
 *
 * @param help - Rendered help
 * @returns One entry per example line
 */
function queryExamples(help: string): HelpStatement[] {
  return help.split('\n').flatMap((line) => {
    const trimmed = line.trimStart().replace(/^\$ /, '');
    if (!trimmed.startsWith(QUERY_EXAMPLE)) return [];
    const quote = trimmed.charAt(QUERY_EXAMPLE.length);
    const close = trimmed.indexOf(quote, QUERY_EXAMPLE.length + 1);
    if ((quote !== "'" && quote !== '"') || close === -1) return [];
    const tokens = (trimmed.slice(close + 1).split('#')[0] ?? '').trim().split(/\s+/);
    const parameters = tokens.flatMap((token, index) => (token === '--param' ? [tokens[index + 1] ?? ''] : []));
    return [{ sql: trimmed.slice(QUERY_EXAMPLE.length + 1, close), parameters }];
  });
}

/**
 * One subcommand of a command group.
 *
 * @param group - The group
 * @param name - The subcommand's name
 * @returns The subcommand
 */
function subcommand(group: Command, name: string): Command {
  const found = group.commands.find((command) => command.name() === name);
  if (found === undefined) throw new Error(`no subcommand ${name}`);
  return found;
}

/** The shipped skill that teaches `query` and `check`. */
const KNOWLEDGE_SKILL = new URL(
  '../../../vat-development-agents/resources/skills/vat-knowledge-resources.md',
  import.meta.url,
);

/** Each help surface that shows SQL, and the fewest statements it must yield. */
const SURFACES: ReadonlyArray<{ readonly label: string; readonly help: () => string; readonly atLeast: number }> = [
  { label: 'resources query', help: () => renderCommandHelp(subcommand(createResourcesCommand(), 'query')), atLeast: 7 },
  { label: 'resources check', help: () => renderCommandHelp(subcommand(createResourcesCommand(), 'check')), atLeast: 4 },
  { label: 'vat-knowledge-resources skill', help: () => readFileSync(KNOWLEDGE_SKILL, 'utf8'), atLeast: 6 },
];

describe('SQL shown in help text', () => {
  const probe = openProjectionCompileProbe();
  afterAll(async () => probe.close());

  it.each(SURFACES)('$label: every statement compiles', ({ help, atLeast }) => {
    const text = help();
    const statements = [...statementBlocks(text), ...queryExamples(text)];

    // The extractor is the thing that can silently stop finding anything.
    expect(statements.length).toBeGreaterThanOrEqual(atLeast);
    for (const statement of statements) {
      expect(() => probe.assertCompiles(statement.sql, statement.parameters), statement.sql).not.toThrow();
    }
  });

  it('refuses the example that shipped broken', () => {
    // The negative control: the same gate throws on a column the schema lacks.
    const [broken] = queryExamples(
      "  $ vat resources query 'SELECT target FROM blob_references WHERE kind = ?' --param markdown-link",
    );
    expect(broken?.parameters).toEqual(['markdown-link']);
    expect(() => probe.assertCompiles(broken?.sql ?? '', broken?.parameters ?? [])).toThrow(/no such column/);
  });
});
