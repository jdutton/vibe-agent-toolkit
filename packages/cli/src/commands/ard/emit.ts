/**
 * `vat ard emit` — write the project's `/.well-known/ard.json`.
 *
 * **Emit, never depend.** This command produces a document and stops. Nothing
 * in VAT reads one back, and no VAT behaviour is derived from one — ARD is
 * v0.91, status Proposal, and wiring internals to a moving shape is the cost
 * this rule avoids.
 */

import { existsSync } from 'node:fs';

import {
  ArdDerivationError,
  buildArdEntries,
  buildArdManifest,
  findShadowedArdOverrideKeys,
  writeArdManifest,
  type ShadowedArdOverrideKey,
} from '@vibe-agent-toolkit/resources';
import { buildReport, exitCodeForReport, reportSchema, type Finding, type Report } from '@vibe-agent-toolkit/schema';
import { safePath, VatError } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { handleReportCommandError, handleReportExpectedFailure } from '../../utils/command-error.js';
import { loadConfig } from '../../utils/config-loader.js';
import { createLogger } from '../../utils/logger.js';
import { writeJsonOutput } from '../../utils/output.js';
import { readPackageJsonOrAbsent } from '../../utils/package-json.js';
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
export class ArdConfigMissingError extends VatError {
  readonly projectRoot: string;
  readonly absence: ArdConfigAbsence;

  constructor(projectRoot: string, absence: ArdConfigAbsence) {
    super('ARD_CONFIG_MISSING', ABSENCE_MESSAGES[absence](projectRoot));
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
 * adopter's is the only one VAT can honestly stamp on an entry. Absent, the
 * field is simply omitted. A `package.json` that is there and is not JSON is
 * refused by name instead: it used to be read as "no version" too, and a
 * manifest emitted with no `version` from a tree npm itself cannot read is a
 * manifest that hid the one fact worth reporting.
 */
function readProjectVersion(projectRoot: string): string | undefined {
  const parsed = readPackageJsonOrAbsent(safePath.join(projectRoot, 'package.json'));
  const version = parsed?.['version'];
  // `""` is ABSENT, not a version. A `package.json` carrying it emitted
  // `"version": ""` on every entry at exit 0 — a field asserting a version
  // that does not exist. The entry schema now refuses it too, so leaving this
  // would turn a blank field into a hard emission failure instead.
  if (typeof version !== 'string' || version === '') return undefined;
  return version;
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
          // `'refuse'`: a manifest cross-checked against a partial skill list
          // would advertise or omit entries on a population it never saw. The
          // throw is an invocation failure → exit 2 (see the catch in
          // `ardEmitCommand`).
          discoveredSkills: (await discoverSkillsFromConfig(config.skills, projectRoot, 'refuse')).map(
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
 * The codes this run's findings carry. Not registry codes: nothing here is a
 * validation an adopter tunes through `validation.severity` — a skipped
 * surface is a fact about what the manifest could not advertise, and its
 * severity is the run's to decide.
 */
export const ARD_EMIT_CODES = {
  /** A configured surface that became no entry, and why — the thing `--strict` gates. */
  SURFACE_SKIPPED: 'ARD_SURFACE_SKIPPED',
  /**
   * A bare `ard.entries` key a qualified key for the same surface outranked.
   * Not a failure — the precedence is deterministic and documented — but the
   * losing block is dead config, and an author cannot see that from the file.
   */
  OVERRIDE_KEY_SHADOWED: 'ARD_OVERRIDE_KEY_SHADOWED',
  /**
   * The project was read and declares no `ard:` block, so no manifest was
   * built. A finding at `error` — exit 1 — because the PROJECT is the subject,
   * not the invocation: it is fixed by editing config.
   */
  NOT_CONFIGURED: 'ARD_NOT_CONFIGURED',
  /** A declared surface could not be derived into a conformant entry, so no manifest was written. */
  DERIVATION_FAILED: 'ARD_DERIVATION_FAILED',
  /** `--strict` refused a manifest that leaves a declared surface (or everything) unadvertised. */
  STRICT_REFUSED: 'ARD_STRICT_REFUSED',
} as const;

/**
 * What the run reports beyond its findings.
 *
 * 🪤 `entryCount: 0` is the empty manifest. A run that wrote `{"entries":[]}`
 * and one that wrote a full catalogue both used to end at exit 0 with a
 * cheerful line on stdout, and nothing a machine could read told them apart —
 * so a CI step that emits and publishes was green over a discovery document
 * advertising nothing. The envelope's `examined` is every configured surface
 * the run considered, so "nothing declared" (`examined: 0`) and "everything
 * declared was skipped" (`examined: N`, `entryCount: 0`) read differently too.
 */
export const ArdEmitDataSchema = z.object({
  /** Where the manifest was written — `null` when the project produced none. */
  outputPath: z.string().nullable(),
  entryCount: z.number().int().nonnegative(),
  /**
   * Counts BESIDE the findings. The count is what a CI step gates on without
   * a JSON path into an array; the finding is what the human it pages then
   * acts on. Publishing only one of them answers "how many" or "which", never
   * both.
   */
  skippedCount: z.number().int().nonnegative(),
  shadowedCount: z.number().int().nonnegative(),
}).strict();

export type ArdEmitData = z.infer<typeof ArdEmitDataSchema>;

/** The document `--format json` publishes. */
export const ARD_EMIT_REPORT_SCHEMA = reportSchema(ArdEmitDataSchema);

export type ArdEmitReport = Report<ArdEmitData>;

/** The finding one skipped surface becomes. Its text is the stderr line, so the two channels agree. */
function skippedFinding(item: SkippedArdSurface): Finding {
  return {
    code: ARD_EMIT_CODES.SURFACE_SKIPPED,
    severity: 'warning',
    message: `skipped ${item.kind} "${item.name}": ${item.reason}`,
  };
}

/** The finding one shadowed override key becomes, pointing at the dead config block. */
function shadowedFinding(item: ShadowedArdOverrideKey): Finding {
  return {
    code: ARD_EMIT_CODES.OVERRIDE_KEY_SHADOWED,
    severity: 'info',
    message:
      `ignored \`ard.entries.${item.shadowedKey}\`: the ${item.kind} "${item.name}" is also named ` +
      `by \`ard.entries."${item.winningKey}"\`, and the kind-qualified key wins. Nothing in the ` +
      'bare block was read — fold it into the qualified one or delete it.',
    field: `ard.entries.${item.shadowedKey}`,
  };
}

/** Pure: the report a result becomes, so the status rule is unit-testable. */
export function buildArdEmitReport(result: ArdEmitResult): ArdEmitReport {
  return buildReport<ArdEmitData>({
    // Every configured surface the run considered: the ones that became
    // entries and the ones it had to skip.
    examined: result.entryCount + result.skipped.length,
    findings: [...result.skipped.map(skippedFinding), ...result.shadowed.map(shadowedFinding)],
    data: {
      outputPath: result.outputPath,
      entryCount: result.entryCount,
      skippedCount: result.skipped.length,
      shadowedCount: result.shadowed.length,
    },
  });
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
  const { skippedCount, entryCount } = report.data;
  if (skippedCount > 0) {
    const surfaces =
      skippedCount === 1 ? '1 configured surface was' : `${skippedCount} configured surfaces were`;
    // Not "see above": in `--format json` the reasons are IN the report, not on
    // stderr, so a message naming a position would be wrong on one of the two
    // channels.
    return `--strict: ${surfaces} not advertised — each is named, with its reason, in this run's \`findings\`.`;
  }
  if (entryCount === 0) {
    return '--strict: the manifest advertises nothing. Nothing this project declares became an ARD entry.';
  }
  return undefined;
}

/**
 * The report for a project VAT read and could build no manifest for.
 *
 * 🚨 These endings used to publish the envelope's ERROR branch (`status:
 * error`) and exit 1 — a document saying "could not do its job" beside a code
 * saying "the project failed its gate". They are findings about the project,
 * so they are published as findings and the code is derived from them.
 *
 * @param code - Which refusal
 * @param message - What the operator must change
 * @returns The report, at `error` severity, with nothing written
 */
function buildArdRefusalReport(
  code: typeof ARD_EMIT_CODES.NOT_CONFIGURED | typeof ARD_EMIT_CODES.DERIVATION_FAILED,
  message: string,
): ArdEmitReport {
  return buildReport<ArdEmitData>({
    examined: 0,
    findings: [{ code, severity: 'error', message }],
    data: { outputPath: null, entryCount: 0, skippedCount: 0, shadowedCount: 0 },
  });
}

/**
 * The report `--strict` publishes: the same one, with the refusal as a finding.
 *
 * It used to be a stderr line beside a document that still said `status: ok`,
 * and an exit 1 the document did not explain.
 *
 * @param report - What the run built
 * @returns The report, with a `STRICT_REFUSED` error when `--strict` refuses it
 */
function withStrictVerdict(report: ArdEmitReport): ArdEmitReport {
  const failure = strictFailure(report);
  if (failure === undefined) return report;
  return {
    ...buildReport<ArdEmitData>({
      examined: report.examined,
      findings: [...report.findings, { code: ARD_EMIT_CODES.STRICT_REFUSED, severity: 'error', message: failure }],
      data: report.data,
    }),
    ...(report.durationMs === undefined ? {} : { durationMs: report.durationMs }),
  };
}

/** The human rendering: findings on stderr, the one summary line on stdout. */
function writeArdEmitText(report: ArdEmitReport): void {
  for (const finding of report.findings) {
    process.stderr.write(`${finding.message}\n`);
  }
  const { entryCount, outputPath } = report.data;
  if (outputPath !== null) {
    process.stdout.write(`Wrote ${entryCount} ARD entr${entryCount === 1 ? 'y' : 'ies'} to ${outputPath}\n`);
  }
}

/**
 * Publish a report in the operator's format and end on the code it DERIVES.
 *
 * @param report - The document
 * @param format - `json`, or anything else for the human rendering
 */
function publishArdReport(report: ArdEmitReport, format: string | undefined): never {
  if (format === 'json') {
    // The report carries every skipped and shadowed surface in full, so the
    // stderr lines would be the same facts twice on two channels.
    writeJsonOutput(report);
  } else {
    writeArdEmitText(report);
  }
  process.exit(exitCodeForReport(report));
}

/** Action handler for `vat ard emit`. */
export async function ardEmitCommand(options: ArdEmitOptions): Promise<void> {
  const logger = createLogger(options.debug === true ? { debug: true } : {});
  const startTime = Date.now();
  try {
    const built = { ...buildArdEmitReport(await runArdEmit(options)), durationMs: Date.now() - startTime };
    publishArdReport(options.strict === true ? withStrictVerdict(built) : built, options.format);
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
    // and what an invalid config already did here through `handleReportCommandError`.
    // The old split had a missing config file exiting 1 and an invalid one
    // exiting 2 while the help called 2 "Unexpected internal failure" — so a CI
    // job reading 2 as a crash was paged for a typo.
    //
    // ⚠️ Both endings publish their document through `handleReportExpectedFailure`,
    // in the format the operator asked for. Written inline they published
    // NOTHING — a `--format json` run of the commonest case of all, a
    // repository that never opted into ARD, wrote zero bytes to stdout and left
    // a CI wrapper parsing stderr for a fact the report is supposed to carry.
    //
    // 🪤 `return` the call, though its type is `never`: under test `process.exit`
    // is a spy that RETURNS, so a bare call falls through to the handler below
    // and the run records a second exit — the same reason the inline endings
    // this replaced each carried a `return`.
    if (error instanceof ArdConfigMissingError && error.absence === 'no-ard-block') {
      return publishArdReport(
        { ...buildArdRefusalReport(ARD_EMIT_CODES.NOT_CONFIGURED, error.message), durationMs: Date.now() - startTime },
        options.format,
      );
    }
    if (error instanceof ArdDerivationError) {
      return publishArdReport(
        { ...buildArdRefusalReport(ARD_EMIT_CODES.DERIVATION_FAILED, error.message), durationMs: Date.now() - startTime },
        options.format,
      );
    }
    if (error instanceof ArdConfigMissingError) {
      return handleReportExpectedFailure(error.message, startTime, options.format);
    }
    handleReportCommandError(error, logger, startTime, 'ARD emit', options.format);
  }
}
