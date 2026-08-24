/**
 * `vat claude budget` publishes the bounds on the number it GATES on.
 *
 * ## Why a count and not a presence check
 *
 * The half of this lane that queries (`vat claude context`) already publishes 23
 * stated limits; the half that applies a threshold published none — *the half
 * that gates was the half with no published bounds.* Fixing that invites the
 * defect its sibling already shipped once: attaching the block per FINDING
 * instead of per REPORT. A presence assertion passes identically with one copy
 * and with six thousand, which is exactly how that survived in this lane before,
 * so every assertion here counts occurrences over a MULTI-finding report.
 *
 * ## Why the AGENTS.md assertions are string assertions
 *
 * Normally a test that greps prose is a test of a sentence nobody promised. Here
 * the honesty of the sentence IS the contract: `AGENTS.md` contributes nothing to
 * this measurement unless a `CLAUDE.md` imports it, so a surface claiming
 * "CLAUDE.md/AGENTS.md" hands a repo standardised on `AGENTS.md` a clean bill of
 * health from a check that measured nothing.
 */

import {
  ALWAYS_LOADED_BUDGET_LIMITS,
  CLAUDE_CONTEXT_BOUNDS_STATEMENT,
  type AlwaysLoadedBudget,
  type BudgetSweep,
} from '@vibe-agent-toolkit/resources';
import { CODE_REGISTRY, createRegistryIssue, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import {
  buildReport,
  createBudgetCommand,
  renderReportText,
  type BudgetReport,
} from '../../../src/commands/claude/budget.js';

/** The claim three shipped surfaces used to make and none of them may make now. */
const BARE_AGENTS_CLAIM = 'CLAUDE.md/AGENTS.md';

/**
 * A budget answer for a fixture finding — the fields the renderer reads.
 *
 * @param directory - The representative directory
 * @returns An over-budget answer
 */
function budgetFor(directory: string): AlwaysLoadedBudget {
  return {
    directory,
    tokens: 20_000,
    threshold: 12_000,
    overBudget: true,
    contributors: [{ path: `${directory}/CLAUDE.md`, tokens: 20_000 }],
    unknownTokenRows: 0,
    excludedRuleRows: 0,
    excludedDeepImportRows: 0,
    unattributedImportRows: 0,
    lowerBound: false,
  };
}

/**
 * A sweep over several distinct chains, so a per-finding copy is observable.
 *
 * ⛔ Several, deliberately. With ONE finding a per-report block and a per-finding
 * block serialize to the same document, and the whole defect class is invisible.
 *
 * @param directories - The representative directories
 * @returns The sweep
 */
function sweepOver(directories: readonly string[]): BudgetSweep {
  return {
    locations: directories.map((directory) => ({
      directory,
      representative: directory,
      budget: budgetFor(directory),
    })),
    evaluatedDirectories: directories.length,
    queriedDirectories: directories.length,
    skippedUnknownLocations: 0,
  };
}

/**
 * A report over several over-budget chains.
 *
 * @returns The report
 */
function reportOverThreeChains(): BudgetReport {
  const directories = ['docs', 'packages/cli', 'packages/resources'];
  const findings: ValidationIssue[] = directories.map((directory) =>
    createRegistryIssue('ALWAYS_LOADED_CONTEXT_BUDGET', `over budget at ${directory}`, { location: directory }));
  return buildReport({
    root: '/repo',
    threshold: 12_000,
    scope: [''],
    sweep: sweepOver(directories),
    scoped: { unmatchedScope: [] },
    findings,
  });
}

/**
 * The command's full `--help`, including the `addHelpText('after')` body.
 *
 * ⛔ Not `helpInformation()`. That renders only the generated usage/options block
 * and silently omits every `addHelpText` hook — which is where the whole
 * Description section lives, so an assertion against it would pass whatever the
 * description claimed. `outputHelp` with a captured writer is the path a user
 * actually gets.
 *
 * @returns The rendered help text
 */
function helpText(): string {
  let captured = '';
  const command = createBudgetCommand();
  command.configureOutput({ writeOut: (chunk) => { captured += chunk; } });
  command.outputHelp();
  return captured;
}

/**
 * How many times a needle occurs in a haystack.
 *
 * @param haystack - The text
 * @param needle - The substring
 * @returns The occurrence count
 */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('vat claude budget — the bounds ride on the REPORT', () => {
  it('states the bounds statement exactly ONCE across a multi-finding report', () => {
    const report = reportOverThreeChains();

    expect(report.findings).toHaveLength(3);
    // The count is the assertion. Presence passes with a copy per finding.
    expect(occurrences(JSON.stringify(report), JSON.stringify(CLAUDE_CONTEXT_BOUNDS_STATEMENT).slice(1, -1)))
      .toBe(1);
  });

  it('carries the limit list exactly ONCE, by count and not by presence', () => {
    const report = reportOverThreeChains();
    const serialized = JSON.stringify(report);
    const firstStatement = ALWAYS_LOADED_BUDGET_LIMITS[0]?.statement ?? '';

    expect(occurrences(serialized, JSON.stringify(firstStatement).slice(1, -1))).toBe(1);
    expect(report.limits).toBe(ALWAYS_LOADED_BUDGET_LIMITS);
  });

  it('publishes the bounds even when nothing was over budget', () => {
    // The limits bound the METHOD. A clean report is subject to every one of
    // them, and a reader acting on "within budget" needs them most.
    const report = buildReport({
      root: '/repo',
      threshold: 12_000,
      scope: [''],
      sweep: sweepOver([]),
      scoped: { unmatchedScope: [] },
      findings: [],
    });

    expect(report.limits.length).toBeGreaterThan(0);
    expect(report.boundsStatement).toBe(CLAUDE_CONTEXT_BOUNDS_STATEMENT);
  });

  it('puts no limit field on any finding', () => {
    const report = reportOverThreeChains();

    for (const finding of report.findings) {
      for (const field of ['limits', 'boundsStatement']) {
        expect(field in finding).toBe(false);
      }
    }
  });
});

describe('vat claude budget — the text rendering', () => {
  it('prints the bounds statement and every limit, once each', () => {
    const text = renderReportText(reportOverThreeChains());

    expect(occurrences(text, 'neither a floor nor a ceiling')).toBe(1);
    for (const limit of ALWAYS_LOADED_BUDGET_LIMITS) {
      expect(occurrences(text, `${limit.direction}: ${limit.id}`)).toBe(1);
    }
  });

  it('prints the bounds on a clean run too', () => {
    const text = renderReportText(buildReport({
      root: '/repo',
      threshold: 12_000,
      scope: [''],
      sweep: sweepOver([]),
      scoped: { unmatchedScope: [] },
      findings: [],
    }));

    expect(text).toContain('Every instruction chain checked is within budget.');
    expect(text).toContain('neither a floor nor a ceiling');
  });
});

describe('vat claude budget — what the chain actually is', () => {
  it('does not claim AGENTS.md is measured, in the help text', () => {
    const help = helpText();

    expect(help).not.toContain(BARE_AGENTS_CLAIM);
    expect(help).toMatch(/AGENTS\.md/);
    expect(help).toMatch(/imports it|imported by a CLAUDE\.md/i);
  });

  it('does not claim AGENTS.md is measured, in the registry description', () => {
    const { description } = CODE_REGISTRY.ALWAYS_LOADED_CONTEXT_BUDGET;

    expect(description).not.toContain(BARE_AGENTS_CLAIM);
    expect(description).toContain('CLAUDE.md');
  });

  it('says the root rules files are charged, and the path-scoped ones are not', () => {
    const help = helpText();

    expect(help).toMatch(/path-scoped/i);
    // The blanket "rules files are excluded" claim is what the root-rule
    // admission falsified; it must not survive anywhere in the help.
    expect(help).not.toMatch(/Rules files are excluded —/);
  });
});

describe('ALWAYS_LOADED_CONTEXT_BUDGET — the fix string', () => {
  it('points at the named contributors before naming a file type', () => {
    const { fix } = CODE_REGISTRY.ALWAYS_LOADED_CONTEXT_BUDGET;

    expect(fix).toMatch(/largest contributors/i);
    // The old wording asserted the win is always in an ancestor CLAUDE.md. With
    // a root rules file now charged, the largest contributor may not be one.
    expect(fix).not.toContain('shrink an ANCESTOR CLAUDE.md instead');
  });

  it('keeps the reason an ancestor file is usually where the win is', () => {
    const { fix } = CODE_REGISTRY.ALWAYS_LOADED_CONTEXT_BUDGET;

    expect(fix).toMatch(/every directory beneath it/);
  });
});
