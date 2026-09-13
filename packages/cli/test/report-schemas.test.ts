/**
 * The report-schema registry is complete, its schemas are the envelope, and
 * the committed artifacts are what the generator renders.
 *
 * Three claims, each of which was false before the registry existed:
 *
 * 1. Every `report` entry's schema IS the shared envelope — strict, carrying
 *    `status`, `examined`, `findings`, `summary` and `data` — so a command
 *    cannot register a private shape under the envelope's name.
 * 2. `schemas/<name>.json` is byte-for-byte what `generate:schemas` writes for
 *    every registered entry, with nothing missing, stale or unlisted.
 * 3. Every Commander leaf that offers a machine-readable document (`--format`
 *    with a `json` choice, `--json`, or `--yaml`) is in the registry — as a
 *    report, an external shape, or a legacy shape with its reason. A new
 *    command cannot add `--format json` without saying what it publishes.
 */

import { REPORT_ENVELOPE_KEYS } from '@vibe-agent-toolkit/schema';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findEmittedSchemaDrift } from '../../dev-tools/src/pin-emitted-schemas.js';
import { CLI_SCHEMA_TARGETS, CLI_SCHEMAS_DIR } from '../scripts/generate-json-schemas.js';
import { COMMAND_LOADERS } from '../src/command-loaders.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { REPORT_SCHEMAS } from '../src/report-schemas.js';

const reportEntries = REPORT_SCHEMAS.filter((entry) => entry.kind === 'report');
const unmigratedEntries = REPORT_SCHEMAS.filter((entry) => entry.kind !== 'report');

describe('REPORT_SCHEMAS — every report entry is the envelope', () => {
  it.each(reportEntries.map((entry) => [entry.command, entry] as const))('%s', (_command, entry) => {
    expect(entry.schema).toBeInstanceOf(z.ZodObject);
    const object = entry.schema as z.AnyZodObject;
    expect(object._def.unknownKeys).toBe('strict');
    const keys = Object.keys(object.shape);
    for (const key of REPORT_ENVELOPE_KEYS) expect(keys).toContain(key);
  });

  it('names each artifact once', () => {
    const names = reportEntries.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every unmigrated entry a reason and never a second, migrated, entry for the same command', () => {
    const migrated = new Set(reportEntries.map((entry) => entry.command));
    for (const entry of unmigratedEntries) {
      expect(entry.reason.length, entry.command).toBeGreaterThan(20);
      expect(migrated.has(entry.command), `${entry.command} is both migrated and ${entry.kind}`).toBe(false);
    }
  });
});

describe('packages/cli/schemas', () => {
  it('is committed in the state `generate:schemas` produces — nothing missing, stale, or unlisted', () => {
    expect(findEmittedSchemaDrift(CLI_SCHEMAS_DIR, CLI_SCHEMA_TARGETS)).toEqual([]);
  });

  it('has at least one target, so an emptied registry cannot pass by vacancy', () => {
    expect(CLI_SCHEMA_TARGETS.length).toBeGreaterThan(0);
  });
});

/** Whether a Commander option offers a machine-readable document. */
function offersDocument(command: Command): boolean {
  return command.options.some((option) => {
    if (option.long === '--json' || option.long === '--yaml') return true;
    return option.long === '--format' && (option.argChoices?.includes('json') ?? true);
  });
}

/**
 * Every node under `command` that offers a document, as `vat`-relative paths.
 *
 * A GROUP with its own action is asked too, not only leaves: a group that
 * offers `--format json` on its own action (as `vat audit`, which has
 * `audit settings` beneath it, would the day it gained the flag) was invisible
 * to a leaves-only walk, so its registry entry could be prose. (`vat audit`
 * today publishes YAML with no flag at all, which no option-based walk sees;
 * its `legacy` entry stands on the registry's own word.)
 */
function documentLeaves(command: Command, prefix: readonly string[]): string[] {
  const path = [...prefix, command.name()];
  const own = offersDocument(command) ? [path.join(' ')] : [];
  return [...own, ...command.commands.flatMap((sub) => documentLeaves(sub, path))];
}

/** Whether a registry entry covers a leaf — exactly, or as a `group *` wildcard. */
function covers(entryCommand: string, leaf: string): boolean {
  if (entryCommand.endsWith(' *')) return leaf.startsWith(entryCommand.slice(0, -1));
  return entryCommand === leaf;
}

describe('every command offering --format json, --json or --yaml is registered', () => {
  it('walks the whole Commander tree and finds no unregistered document', async () => {
    const leaves: string[] = [];
    for (const load of Object.values(COMMAND_LOADERS)) {
      leaves.push(...documentLeaves(await load(), []));
    }
    // `doctor` attaches itself to the program rather than living in
    // `COMMAND_LOADERS`, so it is walked by hand — or it is never walked.
    const program = new Command('vat');
    doctorCommand(program);
    for (const sub of program.commands) leaves.push(...documentLeaves(sub, []));
    // The walk must see something, or the registry could be empty and pass.
    expect(leaves.length).toBeGreaterThan(0);

    const unregistered = leaves.filter(
      (leaf) => !REPORT_SCHEMAS.some((entry) => covers(entry.command, leaf)),
    );
    expect(unregistered).toEqual([]);
  });
});
