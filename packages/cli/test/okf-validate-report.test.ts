/**
 * Unit tests for the `vat okf validate` report.
 *
 * 🪤 The defect these exist for: with no `okf.bundles` declared, the command
 * printed `status: passed`, `bundles: []`, and exited 0 — saying nothing at all
 * about the fact that it had checked nothing. A mistyped config key
 * (`okf.bundle:`, `okf.Bundles:`) therefore read as a clean bill of health,
 * which is the *green-without-running* shape this repo keeps finding.
 *
 * A run that examined nothing is refused: one non-overridable
 * `RESOURCE_CHECK_BROKEN` at `error` (the run-integrity mechanism every other
 * gate uses), so `status: findings` and exit 1, with the notice saying why.
 * `examined: 0` beside `status: ok` read as a pass to every consumer that
 * gates on the status or the exit code rather than on the denominator.
 */
import type { OkfFinding } from '@vibe-agent-toolkit/resources';
import { exitCodeForReport } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { createOkfCommand } from '../src/commands/okf/index.js';
import { OKF_VALIDATE_REPORT_SCHEMA, summarizeOkfBundles, type CheckedOkfBundle } from '../src/commands/okf/validate.js';

// Built from the cwd rather than a `/`-rooted literal, so the root has a drive
// letter on Windows and `issueLocation` relativizes it the same way everywhere.
const PROJECT_ROOT = safePath.resolve('okf-project');

function finding(severity: OkfFinding['severity'], document = 'concepts/a.md'): OkfFinding {
  return {
    code: 'OKF_FRONTMATTER_MISSING',
    severity,
    message: 'no frontmatter',
    document,
  };
}

function report(bundle: string, findings: OkfFinding[] = []): CheckedOkfBundle {
  return {
    report: {
      bundle,
      // The specifier, as the config wrote it — the report never carries the
      // resolved absolute path (that leak is pinned in the resources suite).
      root: `./bundles/${bundle}`,
      conceptDocuments: ['concepts/a.md'],
      reservedDocuments: [],
      findings,
      hasErrors: findings.some((f) => f.severity === 'error'),
    },
    root: safePath.join(PROJECT_ROOT, 'bundles', bundle),
  };
}

/** A bundle whose root was read successfully and held not one markdown file. */
function emptyReport(bundle: string): CheckedOkfBundle {
  return {
    report: {
      bundle,
      root: `./bundles/${bundle}`,
      conceptDocuments: [],
      reservedDocuments: [],
      findings: [],
      hasErrors: false,
    },
    root: safePath.join(PROJECT_ROOT, 'bundles', bundle),
  };
}

function summarize(checked: readonly CheckedOkfBundle[]) {
  return summarizeOkfBundles(checked, PROJECT_ROOT);
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
  it('refuses the run as RESOURCE_CHECK_BROKEN, exit 1, when nothing was declared', () => {
    const summary = summarize([]);

    expect(summary.status).toBe('findings');
    expect(summary.examined).toBe(0);
    expect(summary.findings.map((f) => [f.code, f.severity])).toEqual([['RESOURCE_CHECK_BROKEN', 'error']]);
    expect(summary.summary).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(exitCodeForReport(summary)).toBe(1);
    expect(summary.data.bundles).toEqual([]);
  });

  it('names the config key to add, so the fix does not need a docs lookup', () => {
    const summary = summarize([]);

    expect(summary.data.notice).toBeDefined();
    expect(summary.data.notice).toContain('okf.bundles');
  });

  it('is ok, with the documents it read as the denominator, when a bundle produced no findings', () => {
    const summary = summarize([report('knowledge')]);

    expect(summary.status).toBe('ok');
    expect(summary.examined).toBe(1);
    expect(summary.data.notice).toBeUndefined();
  });

  it('reports findings, with the file to open as a project-relative location', () => {
    const summary = summarize([report('knowledge', [finding('error')])]);

    expect(summary.status).toBe('findings');
    expect(summary.summary.errors).toBe(1);
    expect(summary.findings).toEqual([{
      code: 'OKF_FRONTMATTER_MISSING',
      severity: 'error',
      message: 'no frontmatter',
      location: 'bundles/knowledge/concepts/a.md',
    }]);
  });

  it('builds a document its own published schema accepts, findings or none', () => {
    // The drift test proves `schemas/okf-validate.json` matches the Zod object;
    // this proves the Zod object matches what the command WRITES. A producer
    // adding a key to `findings[]` (strict at every level) reds here, not in
    // an adopter's validator.
    expect(OKF_VALIDATE_REPORT_SCHEMA.safeParse(summarize([])).success).toBe(true);
    expect(OKF_VALIDATE_REPORT_SCHEMA.safeParse(summarize([report('knowledge', [finding('error')])])).success).toBe(true);
  });

  it('names the bundle root itself for the root-unreadable finding', () => {
    const summary = summarize([report('knowledge', [finding('error', '.')])]);

    expect(summary.findings[0]?.location).toBe('bundles/knowledge');
  });

  it('counts every finding below error too', () => {
    // THE case the counts block exists for. A bundle lowered to `warning` via
    // `okf.bundles.<name>.severity` exits 0 while carrying real conformance
    // findings — so the whole distribution is asserted, not just the error
    // bucket. Checking only `errors === 0` would pass just as happily if the
    // warning and info findings had been dropped on the floor instead of counted.
    const summary = summarize([
      report('knowledge', [finding('warning'), finding('info')]),
    ]);

    expect(summary.status).toBe('findings');
    expect(summary.summary).toEqual({ errors: 0, warnings: 1, info: 1 });
    expect(summary.findings).toHaveLength(2);
  });

  it('counts across every bundle, not just the first', () => {
    const summary = summarize([
      report('a', [finding('error')]),
      report('b', [finding('error'), finding('warning')]),
    ]);

    expect(summary.summary).toEqual({ errors: 2, warnings: 1, info: 0 });
    expect(summary.examined).toBe(2);
    expect(summary.findings.map((f) => f.location)).toEqual([
      'bundles/a/concepts/a.md',
      'bundles/b/concepts/a.md',
      'bundles/b/concepts/a.md',
    ]);
  });

  it('keeps the per-bundle rows free of findings — the envelope carries them once', () => {
    const summary = summarize([report('a', [finding('error')])]);

    expect(summary.data.bundles).toEqual([{
      bundle: 'a',
      root: './bundles/a',
      conceptDocuments: ['concepts/a.md'],
      reservedDocuments: [],
    }]);
  });

  it('distinguishes an empty declaration from a declared-but-empty bundle', () => {
    // A bundle root that exists and holds no concept documents is a real,
    // checked result. Both examine zero; the rows and the notice tell them apart.
    const summary = summarize([emptyReport('empty-but-declared')]);

    expect(summary.status).toBe('findings');
    expect(summary.examined).toBe(0);
    expect(summary.data.bundles).toHaveLength(1);
  });

  describe('a bundle root holding no markdown at all', () => {
    // ⚠️ DELIBERATELY RE-PINNED. This suite used to assert only that an empty
    // bundle reports `passed`, and said nothing about whether the report admits
    // that nothing was read. That is the same green-without-running shape the
    // `no-bundles` notice was added for, one level down: a `root:` typo landing
    // on a real-but-wrong directory, or a root one level too deep, reads as a
    // clean bill of health. A run whose EVERY bundle is empty examined nothing
    // and is refused like the empty declaration; the notice names the bundles.

    it('says so in the notice, naming the bundle', () => {
      const summary = summarize([emptyReport('empty')]);

      expect(summary.data.notice).toBeDefined();
      expect(summary.data.notice).toContain("'empty'");
      expect(summary.status).toBe('findings');
      expect(summary.findings.map((f) => f.code)).toEqual(['RESOURCE_CHECK_BROKEN']);
      expect(summary.findings[0]?.message).toContain("'empty'");
      expect(exitCodeForReport(summary)).toBe(1);
    });

    it('does not refuse a run where another bundle WAS read — the notice alone names the empty one', () => {
      const summary = summarize([emptyReport('empty'), report('knowledge')]);

      expect(summary.status).toBe('ok');
      expect(summary.data.notice).toContain("'empty'");
      expect(exitCodeForReport(summary)).toBe(0);
    });

    it('adds no second report when the root was unreadable — that finding already fails the run', () => {
      const unreadable = emptyReport('gone');
      const summary = summarize([{
        ...unreadable,
        report: { ...unreadable.report, findings: [finding('error', '.')], hasErrors: true },
      }]);

      expect(summary.findings.map((f) => f.code)).toEqual(['OKF_FRONTMATTER_MISSING']);
      expect(exitCodeForReport(summary)).toBe(1);
    });

    it('names every empty bundle, not just the first', () => {
      const summary = summarize([emptyReport('one'), emptyReport('two')]);

      expect(summary.data.notice).toContain("'one'");
      expect(summary.data.notice).toContain("'two'");
    });

    it('stays silent when the bundle held documents', () => {
      // The negative control: a notice attached unconditionally would satisfy
      // both assertions above and mean nothing.
      const summary = summarize([report('knowledge')]);

      expect(summary.data.notice).toBeUndefined();
    });

    it('counts a reserved-only bundle as read, not as empty', () => {
      // An index.md is a document that WAS opened and judged (§8/§12), so the
      // run is not vacuous even with no concept documents.
      const only = emptyReport('index-only');
      const summary = summarize([
        { ...only, report: { ...only.report, reservedDocuments: ['index.md'] } },
      ]);

      expect(summary.data.notice).toBeUndefined();
      expect(summary.examined).toBe(1);
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
    //
    // 🪤 This test used to assert only `toContain('§6.1')` and
    // `toContain('[[')` — both of which the ORIGINAL over-claiming text
    // satisfied. Rewriting the section to "Also covered: wikilinks.
    // `[[other-concept]]` resolves like any other link", i.e. restoring the
    // exact defect, left it green while four sibling mutations in this file went
    // red. What matters is the NEGATION, so that is what is asserted: the two
    // brackets have to appear inside a sentence that disclaims them.
    const { validate } = validateSubcommand();
    // `outputHelp()`, not `helpInformation()`: the latter renders only the
    // generated usage/options block, so an assertion against it would be blind
    // to every `addHelpText('after', …)` section — which is where the whole
    // §6.1 claim lives.
    let help = '';
    validate.configureOutput({ writeOut: (chunk) => { help += chunk; } });
    validate.outputHelp();

    expect(help).toContain('§6.1');
    // `[^]` rather than `.` with the `s` flag: the disclaimer and the example
    // are on different lines, and the order is the claim — "NOT covered" has to
    // come first, or the sentence says the opposite.
    expect(help).toMatch(/NOT covered[^]*\[\[/);
  });
});
