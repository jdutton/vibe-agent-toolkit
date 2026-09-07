/**
 * Unit tests for the `vat okf validate` report summary.
 *
 * 🪤 The defect these exist for: with no `okf.bundles` declared, the command
 * printed `status: passed`, `bundles: []`, and exited 0 — saying nothing at all
 * about the fact that it had checked nothing. A mistyped config key
 * (`okf.bundle:`, `okf.Bundles:`) therefore reads as a clean bill of health,
 * which is the *green-without-running* shape this repo keeps finding.
 *
 * `vat resources check` already had the right answer for the identical
 * situation — it prints "No checks are declared. Add them under
 * `resources.checks` …" — so this is bringing one command in line with a
 * convention the repo already holds, not inventing a policy.
 *
 * Exit code stays 0 on purpose: nothing failed. It is the *status word* that
 * must not claim a pass, because that word is what a human and a CI log reader
 * actually see.
 */
import type { OkfBundleReport, OkfFinding } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { createOkfCommand } from '../src/commands/okf/index.js';
import { summarizeOkfBundles } from '../src/commands/okf/validate.js';

function finding(severity: OkfFinding['severity']): OkfFinding {
  return {
    code: 'OKF_FRONTMATTER_MISSING',
    severity,
    message: 'no frontmatter',
    document: 'concepts/a.md',
  };
}

function report(bundle: string, findings: OkfFinding[] = []): OkfBundleReport {
  return {
    bundle,
    root: `/bundles/${bundle}`,
    conceptDocuments: ['concepts/a.md'],
    reservedDocuments: [],
    findings,
    hasErrors: findings.some((f) => f.severity === 'error'),
  };
}

/** A bundle whose root was read successfully and held not one markdown file. */
function emptyReport(bundle: string): OkfBundleReport {
  return {
    bundle,
    root: `/bundles/${bundle}`,
    conceptDocuments: [],
    reservedDocuments: [],
    findings: [],
    hasErrors: false,
  };
}

/** The `validate` subcommand, with Commander's process.exit disabled. */
function validateSubcommand() {
  const okf = createOkfCommand();
  okf.exitOverride();
  const validate = okf.commands.find((command) => command.name() === 'validate');
  if (validate === undefined) throw new Error('okf has no validate subcommand');
  validate.exitOverride();
  return { okf, validate };
}

describe('summarizeOkfBundles', () => {
  it('reports no-bundles, not passed, when nothing was declared', () => {
    const summary = summarizeOkfBundles([]);

    expect(summary.status).toBe('no-bundles');
    expect(summary.findingCount).toBe(0);
    expect(summary.issueCounts).toEqual({ errors: 0, warnings: 0, info: 0 });
  });

  it('names the config key to add, so the fix does not need a docs lookup', () => {
    const summary = summarizeOkfBundles([]);

    expect(summary.notice).toBeDefined();
    expect(summary.notice).toContain('okf.bundles');
  });

  it('passes when a declared bundle produced no findings', () => {
    const summary = summarizeOkfBundles([report('knowledge')]);

    expect(summary.status).toBe('passed');
    expect(summary.notice).toBeUndefined();
  });

  it('fails on an error-severity finding', () => {
    const summary = summarizeOkfBundles([report('knowledge', [finding('error')])]);

    expect(summary.status).toBe('failed');
    expect(summary.issueCounts.errors).toBe(1);
    expect(summary.findingCount).toBe(1);
  });

  it('passes, but still counts, when every finding is below error', () => {
    // THE case the counts block exists for. A bundle lowered to `warning` via
    // `okf.bundles.<name>.severity` reports `passed` and exits 0 while carrying
    // real conformance findings — so the whole distribution is asserted, not
    // just the error bucket. Assert it as one object: checking only
    // `errors === 0` would pass just as happily if the warning and info
    // findings had been dropped on the floor instead of counted.
    const summary = summarizeOkfBundles([
      report('knowledge', [finding('warning'), finding('info')]),
    ]);

    expect(summary.status).toBe('passed');
    expect(summary.issueCounts).toEqual({ errors: 0, warnings: 1, info: 1 });
    expect(summary.findingCount).toBe(2);
  });

  it('counts across every bundle, not just the first', () => {
    const summary = summarizeOkfBundles([
      report('a', [finding('error')]),
      report('b', [finding('error'), finding('warning')]),
    ]);

    expect(summary.issueCounts).toEqual({ errors: 2, warnings: 1, info: 0 });
    expect(summary.findingCount).toBe(3);
    expect(summary.status).toBe('failed');
  });

  it('distinguishes an empty declaration from a declared-but-empty bundle', () => {
    // A bundle root that exists and holds no concept documents is a real,
    // checked result. It must NOT collapse into the same word as "you declared
    // nothing" — that collapse is what made the original defect invisible.
    const summary = summarizeOkfBundles([emptyReport('empty-but-declared')]);

    expect(summary.status).toBe('passed');
    expect(summary.status).not.toBe('no-bundles');
  });

  describe('a bundle root holding no markdown at all', () => {
    // ⚠️ DELIBERATELY RE-PINNED. This suite used to assert only that an empty
    // bundle reports `passed`, and said nothing about whether the report admits
    // that nothing was read. That is the same green-without-running shape the
    // `no-bundles` notice was added for, one level down: a `root:` typo landing
    // on a real-but-wrong directory, or a root one level too deep, reads as a
    // clean bill of health. The status word and the exit code do not move —
    // nothing failed — but the report now says so out loud.

    it('says so in the notice, naming the bundle', () => {
      const summary = summarizeOkfBundles([emptyReport('empty')]);

      expect(summary.notice).toBeDefined();
      expect(summary.notice).toContain("'empty'");
      expect(summary.status).toBe('passed');
    });

    it('names every empty bundle, not just the first', () => {
      const summary = summarizeOkfBundles([emptyReport('one'), emptyReport('two')]);

      expect(summary.notice).toContain("'one'");
      expect(summary.notice).toContain("'two'");
    });

    it('stays silent when the bundle held documents', () => {
      // The negative control: a notice attached unconditionally would satisfy
      // both assertions above and mean nothing.
      const summary = summarizeOkfBundles([report('knowledge')]);

      expect(summary.notice).toBeUndefined();
    });

    it('counts a reserved-only bundle as read, not as empty', () => {
      // An index.md is a document that WAS opened and judged (§8/§12), so the
      // run is not vacuous even with no concept documents.
      const summary = summarizeOkfBundles([
        { ...emptyReport('index-only'), reservedDocuments: ['index.md'] },
      ]);

      expect(summary.notice).toBeUndefined();
    });
  });
});

describe('createOkfCommand', () => {
  it('refuses an unknown --format instead of silently printing YAML', async () => {
    // 🪤 `--format Json` in a pipeline used to get YAML and exit 0, so the
    // mistake surfaced downstream in `jq` rather than here.
    const { okf, validate } = validateSubcommand();

    await expect(
      okf.parseAsync(['validate', '--format', 'bogus'], { from: 'user' }),
    ).rejects.toThrow(/bogus/);
    expect(validate.opts()['format']).not.toBe('bogus');
  });

  it('still accepts both formats it advertises, and defaults to yaml', () => {
    // The negative control for the refusal above: an option that rejected
    // EVERYTHING would satisfy that test just as happily.
    const { validate } = validateSubcommand();
    const format = validate.options.find((option) => option.long === '--format');

    expect(format?.argChoices).toEqual(['yaml', 'json']);
    expect(format?.defaultValue).toBe('yaml');
  });

  it('does not promise cross-link coverage the check does not deliver', () => {
    // The §6.1 line used to read "every markdown cross-link resolves inside the
    // bundle". Wikilinks (`[[other-concept]]`) are invisible to the parser, so
    // the sentence over-claimed. The parser gap is pre-existing; the CLAIM is
    // what is fixed here.
    const { validate } = validateSubcommand();
    // `outputHelp()`, not `helpInformation()`: the latter renders only the
    // generated usage/options block, so an assertion against it would be blind
    // to every `addHelpText('after', …)` section — which is where the whole
    // §6.1 claim lives.
    let help = '';
    validate.configureOutput({ writeOut: (chunk) => { help += chunk; } });
    validate.outputHelp();

    expect(help).toContain('§6.1');
    expect(help).toContain('[[');
  });
});
