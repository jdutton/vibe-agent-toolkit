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

import { collectArdSurfaces, type SkippedArdSurface } from './surfaces.js';

/** Default destination, relative to the project root — the path ARD publishes at. */
export const DEFAULT_ARD_OUTPUT = '.well-known/ard.json';

/**
 * The project declares no `ard` block, so there is nothing to emit.
 *
 * Distinct from a derivation failure: nothing was wrong, the feature was simply
 * never configured. Both exit non-zero, because a caller that asked for a
 * manifest and got none must not read that as success.
 */
export class ArdConfigMissingError extends Error {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    super(
      `No \`ard:\` configuration found for ${projectRoot}. ` +
        'Add an `ard:` block with a `publisher` domain to vibe-agent-toolkit.config.yaml.'
    );
    this.name = 'ArdConfigMissingError';
    this.projectRoot = projectRoot;
  }
}

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
    return typeof parsed.version === 'string' ? parsed.version : undefined;
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
  const config = loadConfig(projectRoot);
  const ard = config?.ard;
  if (config === undefined || ard === undefined) {
    throw new ArdConfigMissingError(projectRoot);
  }

  const { surfaces, skipped } = collectArdSurfaces(config, {
    version: readProjectVersion(projectRoot),
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
    // A configuration or derivation failure is the user's to fix, so it exits 1
    // — the "your input was refused" code — rather than 2, which this CLI
    // reserves for an unexpected internal failure.
    if (error instanceof ArdConfigMissingError || error instanceof ArdDerivationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
      return;
    }
    handleCommandError(error, logger, startTime, 'ARD emit');
  }
}
