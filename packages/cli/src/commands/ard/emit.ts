/**
 * `vat ard emit` — write the project's `/.well-known/ard.json`.
 *
 * **Emit, never depend.** This command produces a document and stops. Nothing
 * in VAT reads one back, and no VAT behaviour is derived from one — ARD is
 * v0.91, status Proposal, and wiring internals to a moving shape is the cost
 * this rule avoids.
 */

import {
  ArdDerivationError,
  buildArdEntries,
  buildArdManifest,
  findShadowedArdOverrideKeys,
  writeArdManifest,
  type ShadowedArdOverrideKey,
} from '@vibe-agent-toolkit/resources';
import {
  buildReport,
  exitCodeForReport,
  type Finding,
  type FindingsReport,
  type Gate,
  type OkReport,
  type RefusalCode,
} from '@vibe-agent-toolkit/schema';
import { isFilesystemAccessError, safePath, VatError } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError, errorMessageOf, refusalCodeOf } from '../../utils/command-refusal.js';
import { loadConfig } from '../../utils/config-loader.js';
import { endWithRefusal, NOTHING_FINISHED, writeDocument } from '../../utils/document-writer.js';
import { readPackageJsonOrAbsent } from '../../utils/package-json.js';
import { pathPresent } from '../../utils/project-root-policy.js';
import { discoverSkillsFromConfig } from '../skills/skill-discovery.js';

import type { ArdEmitData } from './emit-schema.js';
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
 * @throws {CommandRefusalError} `RUN_INCOMPLETE` when the OS refuses the manifest write.
 */
export async function runArdEmit(options: ArdEmitOptions): Promise<ArdEmitResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  // Absent is the invocation naming nothing; a stat the OS refuses is the
  // input's refusal (INPUT_UNREADABLE), never read as absent.
  if (!pathPresent(projectRoot, 'follow')) {
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
  try {
    await writeArdManifest(manifest, outputPath);
  } catch (error) {
    // The OS refusing `--output` (read-only, full disk, a file where a directory
    // must be) stopped the run: the user's environment, not a VAT defect.
    if (!isFilesystemAccessError(error)) throw error;
    throw new CommandRefusalError('RUN_INCOMPLETE', `Could not write ${outputPath}: ${errorMessageOf(error)}`, { cause: error });
  }
  return {
    outputPath,
    entryCount: manifest.entries.length,
    skipped,
    shadowed: findShadowedArdOverrideKeys(surfaces, ard),
  };
}

/**
 * The codes this run's findings carry. The two refusals — no `ard:` block, a
 * surface that would not derive — are REGISTRY refusal codes (`satisfies
 * RefusalCode` below), so this command has no private vocabulary for "could
 * not produce a manifest". The other three are not registry codes: nothing
 * about them is a validation an adopter tunes through `validation.severity` — a
 * skipped surface is a fact about what the manifest could not advertise, and
 * its severity is the run's to decide.
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
  NOT_CONFIGURED: 'ARD_NOT_CONFIGURED' satisfies RefusalCode,
  /** A declared surface could not be derived into a conformant entry, so no manifest was written. */
  DERIVATION_FAILED: 'ARD_DERIVATION_FAILED' satisfies RefusalCode,
  /** `--strict` refused a manifest that leaves a declared surface (or everything) unadvertised. */
  STRICT_REFUSED: 'ARD_STRICT_REFUSED',
} as const;


/**
 * The report this command's own builders produce — always a COMPLETED run
 * (`ok` or `findings`). A run that could not finish ends through the shared
 * failure path instead, so its `data` is never `null` here.
 */
export type ArdEmitReport = OkReport<ArdEmitData> | FindingsReport<ArdEmitData>;

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

/**
 * Pure: the report a result becomes, so the status rule is unit-testable.
 *
 * @param result - What the run built
 * @param gate - The gate the run is judged by (`--strict`)
 * @returns The report
 */
export function buildArdEmitReport(result: ArdEmitResult, gate: Gate): ArdEmitReport {
  return buildReport<ArdEmitData>({
    gate,
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
 * @param gate - The gate the run is judged by (`--strict`)
 * @returns The report, at `error` severity, with nothing written
 */
function buildArdRefusalReport(
  code: typeof ARD_EMIT_CODES.NOT_CONFIGURED | typeof ARD_EMIT_CODES.DERIVATION_FAILED,
  message: string,
  gate: Gate,
): ArdEmitReport {
  return buildReport<ArdEmitData>({
    gate,
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
      gate: report.gate,
      examined: report.examined,
      findings: [...report.findings, { code: ARD_EMIT_CODES.STRICT_REFUSED, severity: 'error', message: failure }],
      data: report.data,
    }),
    ...(report.durationMs === undefined ? {} : { durationMs: report.durationMs }),
  };
}

/**
 * The refusal an absence is: no project root is the invocation naming nothing
 * (`USAGE_INVALID`); no config file is a project with nothing to derive from
 * (`CONFIG_INVALID`). A project without an `ard:` block is a FINDING, not a
 * refusal — `null` here, and published as `ARD_NOT_CONFIGURED` above.
 */
const ABSENCE_REFUSALS: Readonly<Record<ArdConfigAbsence, RefusalCode | null>> = {
  'no-project-root': 'USAGE_INVALID',
  'no-config-file': 'CONFIG_INVALID',
  'no-ard-block': null,
};

/** Which refusal a failure that is not a finding about the project is. */
function ardRefusalCode(error: unknown): RefusalCode {
  const absence = error instanceof ArdConfigMissingError ? ABSENCE_REFUSALS[error.absence] : null;
  return absence ?? refusalCodeOf(error);
}

/**
 * Publish a report in the operator's format and end on the code the WRITTEN
 * document derives. In text mode the findings — including any the writer adds —
 * go to stderr and the one summary line to stdout; in json the report carries
 * them in full, so stderr would be the same facts twice.
 *
 * @param report - The document
 * @param format - `json`, or the human rendering
 */
function publishArdReport(report: ArdEmitReport, format: 'text' | 'json'): never {
  const written = writeDocument('ard emit', report, format);
  if (format === 'text') {
    for (const finding of written.findings) process.stderr.write(`${finding.message}\n`);
  }
  process.exit(exitCodeForReport(written));
}

/** Action handler for `vat ard emit`. */
export async function ardEmitCommand(options: ArdEmitOptions): Promise<void> {
  const startTime = Date.now();
  const gate: Gate = { strict: options.strict === true };
  const format = options.format ?? 'text';
  try {
    const built = { ...buildArdEmitReport(await runArdEmit(options), gate), durationMs: Date.now() - startTime };
    publishArdReport(options.strict === true ? withStrictVerdict(built) : built, format);
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
    // and what an invalid config already did here (`CONFIG_INVALID`).
    // The old split had a missing config file exiting 1 and an invalid one
    // exiting 2 while the help called 2 "Unexpected internal failure" — so a CI
    // job reading 2 as a crash was paged for a typo.
    //
    // ⚠️ Both endings publish their document through the writer, in the
    // format the operator asked for. Written inline they published
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
        { ...buildArdRefusalReport(ARD_EMIT_CODES.NOT_CONFIGURED, error.message, gate), durationMs: Date.now() - startTime },
        format,
      );
    }
    if (error instanceof ArdDerivationError) {
      return publishArdReport(
        { ...buildArdRefusalReport(ARD_EMIT_CODES.DERIVATION_FAILED, error.message, gate), durationMs: Date.now() - startTime },
        format,
      );
    }
    return endWithRefusal('ard emit', ardRefusalCode(error), error, format, gate, NOTHING_FINISHED);
  }
}
