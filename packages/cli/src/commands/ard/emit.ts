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
  writeArdManifest,
} from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';

import { handleCommandError } from '../../utils/command-error.js';
import { loadConfig } from '../../utils/config-loader.js';
import { createLogger } from '../../utils/logger.js';
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
  debug?: boolean | undefined;
}

export interface ArdEmitResult {
  readonly outputPath: string;
  readonly entryCount: number;
  readonly skipped: readonly SkippedArdSurface[];
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
  return { outputPath, entryCount: manifest.entries.length, skipped };
}

/** Action handler for `vat ard emit`. */
export async function ardEmitCommand(options: ArdEmitOptions): Promise<void> {
  const logger = createLogger(options.debug === true ? { debug: true } : {});
  const startTime = Date.now();
  try {
    const result = await runArdEmit(options);
    for (const item of result.skipped) {
      process.stderr.write(`skipped ${item.kind} "${item.name}": ${item.reason}\n`);
    }
    process.stdout.write(
      `Wrote ${result.entryCount} ARD entr${result.entryCount === 1 ? 'y' : 'ies'} to ${result.outputPath}\n`
    );
  } catch (error) {
    // 🔑 Exit 1 is "VAT read your project and refused to emit"; exit 2 is a
    // SYSTEM error — the run never got as far as a judgement. A project that
    // declares no `ard:` block is the first; a missing root or a missing config
    // file is the second, which is also what `vat okf validate` documents for
    // the same conditions, and what an invalid config already did here through
    // `handleCommandError`. The old split had a missing config file exiting 1
    // and an invalid one exiting 2 while the help called 2 "Unexpected internal
    // failure" — so a CI job reading 2 as a crash was paged for a typo.
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
    handleCommandError(error, logger, startTime, 'ARD emit');
  }
}
