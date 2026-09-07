/**
 * `vat ard emit` — write the project's `/.well-known/ard.json`.
 *
 * **Emit, never depend.** This command produces a document and stops. Nothing
 * in VAT reads one back, and no VAT behaviour is derived from one — ARD is
 * v0.91, status Proposal, and wiring internals to a moving shape is the cost
 * this rule avoids.
 */

import { existsSync, readFileSync } from 'node:fs';

import {
  ArdDerivationError,
  buildArdEntries,
  buildArdManifest,
  findShadowedArdOverrideKeys,
  writeArdManifest,
  type ShadowedArdOverrideKey,
} from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';

import { handleCommandError } from '../../utils/command-error.js';
import { loadConfig } from '../../utils/config-loader.js';
import { createLogger } from '../../utils/logger.js';
import { writeJsonOutput } from '../../utils/output.js';
import { discoverSkillsFromConfig } from '../skills/skill-discovery.js';

import { collectArdSurfaces, type SkippedArdSurface } from './surfaces.js';

/** Default destination, relative to the project root — the path ARD publishes at. */
export const DEFAULT_ARD_OUTPUT = '.well-known/ard.json';

/** The config filename every VAT project declares its surfaces in. */
const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

/**
 * Which of the three absences stopped the run.
 *
 * 🚨 `loadConfig` returns `undefined` for both "that directory does not exist"
 * and "that directory has no config file", and the command used to report the
 * third case for all of them: `--project-root /nope/nothing/here` answered "No
 * `ard:` configuration found … Add an `ard:` block to
 * vibe-agent-toolkit.config.yaml", prescribing an edit to a file in a directory
 * that does not exist. Only a `stat` can tell them apart, so the command does
 * one rather than inferring from a shared `undefined`.
 *
 * The distinction is also what the exit code reads: the first two are system
 * errors (exit 2, as `vat okf validate` documents for the same conditions), the
 * third is a project that never opted in (exit 1).
 */
export type ArdConfigAbsence = 'no-project-root' | 'no-config-file' | 'no-ard-block';

/** No manifest could be built, and this says which absence caused it. */
export class ArdConfigMissingError extends Error {
  readonly projectRoot: string;
  readonly absence: ArdConfigAbsence;

  constructor(projectRoot: string, absence: ArdConfigAbsence) {
    super(ABSENCE_MESSAGES[absence](projectRoot));
    this.name = 'ArdConfigMissingError';
    this.projectRoot = projectRoot;
    this.absence = absence;
  }
}

const ABSENCE_MESSAGES: Readonly<Record<ArdConfigAbsence, (projectRoot: string) => string>> = {
  'no-project-root': (projectRoot) =>
    `Project root ${projectRoot} does not exist. Pass --project-root a directory that does, or ` +
    'run `vat ard emit` from inside the project.',
  'no-config-file': (projectRoot) =>
    `No ${CONFIG_FILENAME} found in ${projectRoot}. ` +
    'ARD entries are derived from the surfaces that file declares, so there is nothing to emit.',
  'no-ard-block': (projectRoot) =>
    `No \`ard:\` configuration found for ${projectRoot}. ` +
    `Add an \`ard:\` block with a \`publisher\` domain to ${CONFIG_FILENAME}.`,
};

export interface ArdEmitOptions {
  /** Project root to read the config from (default: cwd). */
  projectRoot?: string | undefined;
  /** Destination path, absolute or relative to the project root. */
  output?: string | undefined;
  /**
   * How the run reports itself: a human line (default) or {@link ArdEmitReport}.
   *
   * `text` is the default because it is what the command already wrote, and
   * this lane's stdout is a published contract.
   */
  format?: 'text' | 'json' | undefined;
  /** Fail the run when it advertises nothing, or skipped a configured surface. */
  strict?: boolean | undefined;
  debug?: boolean | undefined;
}

export interface ArdEmitResult {
  readonly outputPath: string;
  readonly entryCount: number;
  readonly skipped: readonly SkippedArdSurface[];
  /**
   * Bare `ard.entries` keys a qualified key for the same surface outranked.
   *
   * Not a failure — the precedence is deterministic and documented — but the
   * losing block is dead config, and an author cannot see that from the file.
   */
  readonly shadowed: readonly ShadowedArdOverrideKey[];
}

/**
 * The project's own package version, when it has one.
 *
 * The npm package version is the only version this project recognises, and an
 * adopter's is the only one VAT can honestly stamp on an entry. Absent or
 * unreadable, the field is simply omitted.
 */
function readProjectVersion(projectRoot: string): string | undefined {
  const packagePath = safePath.join(projectRoot, 'package.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derives from the caller's project root
  if (!existsSync(packagePath)) return undefined;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- existence just confirmed above; same path
    const parsed = JSON.parse(readFileSync(packagePath, 'utf-8')) as { version?: unknown };
    // `""` is ABSENT, not a version. A `package.json` carrying it emitted
    // `"version": ""` on every entry at exit 0 — a field asserting a version
    // that does not exist. The entry schema now refuses it too, so leaving this
    // would turn a blank field into a hard emission failure instead.
    if (typeof parsed.version !== 'string' || parsed.version === '') return undefined;
    return parsed.version;
  } catch {
    // A package.json VAT cannot read is not a reason to refuse a manifest; the
    // entry is emitted without a `version`, which is a conformant entry.
    return undefined;
  }
}

/**
 * Build and write the manifest.
 *
 * @throws {ArdConfigMissingError} when no config, or no `ard:` block, is found.
 * @throws {ArdDerivationError} when a surface cannot be turned into a
 *   conformant entry — a missing `ard.baseUrl`, an unusable URN segment, or a
 *   trust identity that does not align with the publisher.
 */
export async function runArdEmit(options: ArdEmitOptions): Promise<ArdEmitResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- projectRoot is the caller's declared root
  if (!existsSync(projectRoot)) {
    throw new ArdConfigMissingError(projectRoot, 'no-project-root');
  }
  const config = loadConfig(projectRoot);
  if (config === undefined) {
    throw new ArdConfigMissingError(projectRoot, 'no-config-file');
  }
  const ard = config.ard;
  if (ard === undefined) {
    throw new ArdConfigMissingError(projectRoot, 'no-ard-block');
  }

  const { surfaces, skipped } = collectArdSurfaces(config, {
    version: readProjectVersion(projectRoot),
    // The SAME discovery `vat verify` runs, so the two commands cannot disagree
    // about which skills this project has. Omitted entirely when the project
    // declares no `skills` block: there is nothing to cross-check, and passing
    // `[]` would claim discovery ran and found nothing.
    ...(config.skills === undefined
      ? {}
      : {
          discoveredSkills: (await discoverSkillsFromConfig(config.skills, projectRoot)).map(
            (skill) => skill.name
          ),
        }),
  });
  const manifest = buildArdManifest(buildArdEntries(surfaces, ard));
  const outputPath = safePath.resolve(projectRoot, options.output ?? DEFAULT_ARD_OUTPUT);
  await writeArdManifest(manifest, outputPath);
  return {
    outputPath,
    entryCount: manifest.entries.length,
    skipped,
    shadowed: findShadowedArdOverrideKeys(surfaces, ard),
  };
}

/**
 * Whether the manifest this run wrote advertises anything at all.
 *
 * `empty` is a separate word for the same reason `vat okf validate` spells
 * `no-bundles` rather than `passed`: a run that wrote `{"entries":[]}` and one
 * that wrote a full catalogue both ended at exit 0 with a cheerful line on
 * stdout, and nothing a machine could read told them apart. A CI step that
 * emits and publishes was therefore green over a discovery document advertising
 * nothing.
 */
export type ArdEmitStatus = 'written' | 'empty';

/** The document `--format json` publishes. */
export interface ArdEmitReport {
  readonly status: ArdEmitStatus;
  readonly outputPath: string;
  readonly entryCount: number;
  /**
   * Counts BESIDE the lists, as `vat okf validate` publishes `issueCounts`.
   *
   * The count is what a CI step gates on without a JSON path into an array;
   * the list is what the human it pages then acts on. Publishing only one of
   * them answers "how many" or "which", never both.
   */
  readonly skippedCount: number;
  readonly shadowedCount: number;
  readonly skipped: readonly SkippedArdSurface[];
  readonly shadowed: readonly ShadowedArdOverrideKey[];
}

/** Pure: the report a result becomes, so the status rule is unit-testable. */
export function buildArdEmitReport(result: ArdEmitResult): ArdEmitReport {
  return {
    status: result.entryCount > 0 ? 'written' : 'empty',
    outputPath: result.outputPath,
    entryCount: result.entryCount,
    skippedCount: result.skipped.length,
    shadowedCount: result.shadowed.length,
    skipped: result.skipped,
    shadowed: result.shadowed,
  };
}

/**
 * Why `--strict` fails this run, or `undefined` when it does not.
 *
 * ⚠️ A shadowed override key is deliberately NOT a strict failure: the
 * precedence is deterministic and documented, the entry is still emitted, and
 * nothing about the published manifest is wrong. What `--strict` gates is the
 * manifest's CONTENT — a surface an author declared and a consumer will never
 * see, and the empty document that is the limit case of that.
 */
function strictFailure(report: ArdEmitReport): string | undefined {
  if (report.skippedCount > 0) {
    const surfaces =
      report.skippedCount === 1 ? '1 configured surface was' : `${report.skippedCount} configured surfaces were`;
    // Not "see above": in `--format json` the reasons are IN the report, not on
    // stderr, so a message naming a position would be wrong on one of the two
    // channels.
    return `--strict: ${surfaces} not advertised — each is named, with its reason, in this run's \`skipped\` report.`;
  }
  if (report.status === 'empty') {
    return '--strict: the manifest advertises nothing. Nothing this project declares became an ARD entry.';
  }
  return undefined;
}

/** The human rendering: findings on stderr, the one summary line on stdout. */
function writeArdEmitText(report: ArdEmitReport): void {
  for (const item of report.skipped) {
    process.stderr.write(`skipped ${item.kind} "${item.name}": ${item.reason}\n`);
  }
  for (const item of report.shadowed) {
    process.stderr.write(
      `ignored \`ard.entries.${item.shadowedKey}\`: the ${item.kind} "${item.name}" is also named ` +
        `by \`ard.entries."${item.winningKey}"\`, and the kind-qualified key wins. Nothing in the ` +
        'bare block was read — fold it into the qualified one or delete it.\n'
    );
  }
  process.stdout.write(
    `Wrote ${report.entryCount} ARD entr${report.entryCount === 1 ? 'y' : 'ies'} to ${report.outputPath}\n`
  );
}

/** Action handler for `vat ard emit`. */
export async function ardEmitCommand(options: ArdEmitOptions): Promise<void> {
  const logger = createLogger(options.debug === true ? { debug: true } : {});
  const startTime = Date.now();
  try {
    const report = buildArdEmitReport(await runArdEmit(options));
    if (options.format === 'json') {
      // The report carries every skipped and shadowed surface in full, so the
      // stderr lines would be the same facts twice on two channels.
      writeJsonOutput(report);
    } else {
      writeArdEmitText(report);
    }
    const failure = options.strict === true ? strictFailure(report) : undefined;
    if (failure !== undefined) {
      process.stderr.write(`${failure}\n`);
      process.exit(1);
    }
  } catch (error) {
    // 🔑 THE RULE, in one sentence: **exit 1 means VAT read this project and
    // produced no manifest by its own rules — it declares no `ard:` block, or a
    // surface could not be derived into a conformant entry; exit 2 means VAT
    // never got that far — no project root, no config file, a config it cannot
    // parse, or an unexpected internal failure.**
    //
    // ⚠️ Not "1 is reserved for a check that ran and failed": `ard emit` is not
    // a check, and "no `ard:` block" is not a failed one. The distinction that
    // matters to a caller is whether the PROJECT is the subject (1) or the
    // INVOCATION is (2) — the first is fixed by editing config, the second by
    // fixing the command line or the file itself. A CI job that tolerates
    // repositories which have not opted into ARD keys on exactly that split.
    //
    // Exit 2 is also what `vat okf validate` documents for the same conditions,
    // and what an invalid config already did here through `handleCommandError`.
    // The old split had a missing config file exiting 1 and an invalid one
    // exiting 2 while the help called 2 "Unexpected internal failure" — so a CI
    // job reading 2 as a crash was paged for a typo.
    if (error instanceof ArdConfigMissingError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(error.absence === 'no-ard-block' ? 1 : 2);
      return;
    }
    if (error instanceof ArdDerivationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
      return;
    }
    handleCommandError(error, logger, startTime, 'ARD emit', options.format);
  }
}
