/**
 * Copy the pinned TypeScript into `<package>/src/vendor/` and `<package>/dist/vendor/`.
 *
 * Invoked as the LAST step of `@vibe-agent-toolkit/resources`' build, run from the package
 * directory: `... && tsx ../dev-tools/src/vendor-typescript.ts`.
 *
 * VAT parses with its own copy of TypeScript, shipped as a plain file inside `resources`, so the
 * TypeScript that answered is identified by the VAT version (the cache namespace) and can never be
 * hoisted or overridden by an adopter's install. The copy is `lib/typescript.js` of `resources`' own
 * `typescript` devDependency, so it is that version by construction and no version is kept by hand:
 *
 * 1. Resolve `typescript` from the package's own directory and REFUSE unless the resolved
 *    `package.json` version equals the exact string the package declares in `devDependencies`.
 * 2. Write `typescript.cjs` (the `.cjs` name is what makes a `"type": "module"` package load it as
 *    CommonJS; under `.js` it imports as an empty module), `LICENSE.txt` and
 *    `ThirdPartyNoticeText.txt` into `src/vendor/`. The trailing `//# sourceMappingURL=` line is
 *    stripped, because TypeScript ships no map and Vite reads the comment; every other byte is the
 *    pinned file's.
 * 3. Copy `src/vendor/`'s four files (those three and the committed `typescript.d.cts`) to
 *    `dist/vendor/`.
 *
 * Every write is `replaceFile`'s (a temporary file in the target's directory and a rename), skipped
 * when the target already holds the same bytes. The three copies in `src/vendor/` are gitignored.
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { forEachInOrder, isNoSuchEntryError, mkdirSyncReal, replaceFile, safePath, VatError } from '@vibe-agent-toolkit/utils';
import semver from 'semver';

import { isEntrypoint, log } from './common.js';

/** The package whose devDependency pins the vendored TypeScript. */
const PINNED_PACKAGE = 'typescript';

/** What `src/vendor/` receives from the resolved package: its path there, and the name written. */
const COPIED_FILES = [
  { from: 'lib/typescript.js', to: 'typescript.cjs', stripSourceMap: true },
  { from: 'LICENSE.txt', to: 'LICENSE.txt', stripSourceMap: false },
  { from: 'ThirdPartyNoticeText.txt', to: 'ThirdPartyNoticeText.txt', stripSourceMap: false },
] as const;

/** The committed declaration that types the copy; it is copied to `dist/vendor/` with the three. */
const DECLARATION_FILE = 'typescript.d.cts';

/** The comment that opens the line {@link stripTrailingSourceMapLine} removes. */
const SOURCE_MAP_PREFIX = '//# sourceMappingURL=';

const LF = 0x0a;

/** The resolved TypeScript is not the one the package declares: nothing is copied. */
export class VendorTypescriptRefusal extends VatError {
  constructor(message: string) {
    super('VENDOR_TYPESCRIPT_PIN_MISMATCH', message);
  }
}

/**
 * Refuse unless `declared` is an exact version and `resolved` is that same string.
 *
 * @param declared - The package's `devDependencies.typescript`, as written
 * @param resolved - The `version` of the `typescript/package.json` resolved from the package
 * @param manifestPath - The declaring `package.json`, for the message
 * @throws {VendorTypescriptRefusal} On a missing, ranged or mismatched declaration
 */
export function assertPinnedTypescript(declared: string | undefined, resolved: string | undefined, manifestPath: string): void {
  const fix = `the vendored copy is exactly the version ${manifestPath} declares as devDependencies.${PINNED_PACKAGE}; declare one exact version there (no range) and reinstall`;
  if (declared === undefined) {
    throw new VendorTypescriptRefusal(`vendor-typescript: ${manifestPath} declares no devDependencies.${PINNED_PACKAGE}: ${fix}`);
  }
  if (semver.valid(declared) !== declared) {
    throw new VendorTypescriptRefusal(`vendor-typescript: devDependencies.${PINNED_PACKAGE} is "${declared}", not an exact version: ${fix}`);
  }
  if (resolved !== declared) {
    throw new VendorTypescriptRefusal(
      `vendor-typescript: ${PINNED_PACKAGE} resolved from ${manifestPath} is ${resolved ?? '(no version)'}, but devDependencies.${PINNED_PACKAGE} declares ${declared} (hoisted or overridden?): ${fix}`,
    );
  }
}

/**
 * Remove the file's last line when it is a `//# sourceMappingURL=` comment, and nothing else.
 *
 * @param bytes - The file's bytes
 * @returns The bytes up to and including the newline before that line, or `bytes` unchanged
 */
export function stripTrailingSourceMapLine(bytes: Buffer): Buffer {
  const end = bytes.at(-1) === LF ? bytes.length - 1 : bytes.length;
  if (end === 0) return bytes;
  const lineStart = bytes.lastIndexOf(LF, end - 1) + 1;
  const line = bytes.subarray(lineStart, end).toString('utf8');
  return line.startsWith(SOURCE_MAP_PREFIX) ? bytes.subarray(0, lineStart) : bytes;
}

/** The file operations {@link replaceIfChanged} performs, injectable so its rule is unit-tested. */
export interface ReplaceIo {
  /** The file's bytes, or `undefined` when it does not exist. */
  read(path: string): Promise<Buffer | undefined>;
  /** Replace the file in one step (a temporary file beside it, then a rename). */
  replace(path: string, bytes: Buffer): Promise<void>;
}

const NODE_IO: ReplaceIo = {
  async read(path) {
    try {
      return await readFile(path);
    } catch (error) {
      if (isNoSuchEntryError(error)) return undefined;
      throw error;
    }
  },
  replace: replaceFile,
};

/**
 * Put `bytes` at `target` through `replaceFile` (a temporary file in the target's directory and a
 * rename, so a reader never sees a partial file), unless `target` already holds exactly those bytes.
 *
 * @param target - The file to write
 * @param bytes - Its new content
 * @param io - The file operations
 * @returns Whether the file was written
 */
export async function replaceIfChanged(target: string, bytes: Buffer, io: ReplaceIo = NODE_IO): Promise<boolean> {
  const current = await io.read(target);
  if (current?.equals(bytes) === true) return false;
  await io.replace(target, bytes);
  return true;
}

interface Manifest {
  version?: string;
  devDependencies?: Record<string, string>;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/**
 * Vendor the pinned TypeScript into `<packageRoot>/src/vendor/` and `<packageRoot>/dist/vendor/`.
 *
 * @param packageRoot - The package whose devDependency pins `typescript`
 * @returns The files written (an unchanged file is not listed)
 * @throws {VendorTypescriptRefusal} When the resolved TypeScript is not the declared one
 */
export async function vendorTypescript(packageRoot: string): Promise<string[]> {
  const manifestPath = safePath.join(packageRoot, 'package.json');
  const resolvedManifest = createRequire(manifestPath).resolve(`${PINNED_PACKAGE}/package.json`);
  assertPinnedTypescript(readManifest(manifestPath).devDependencies?.[PINNED_PACKAGE], readManifest(resolvedManifest).version, manifestPath);

  const typescriptRoot = safePath.join(resolvedManifest, '..');
  const srcVendor = safePath.join(packageRoot, 'src', 'vendor');
  const distVendor = safePath.join(packageRoot, 'dist', 'vendor');
  mkdirSyncReal(srcVendor, { recursive: true });
  mkdirSyncReal(distVendor, { recursive: true });

  const written: string[] = [];
  const put = async (target: string, bytes: Buffer): Promise<void> => {
    if (await replaceIfChanged(target, bytes)) written.push(target);
  };
  // `dist/vendor/` copies what `src/vendor/` holds, so it runs once the first pass is done.
  await forEachInOrder(COPIED_FILES, async (file) => {
    const bytes = await readFile(safePath.join(typescriptRoot, file.from));
    await put(safePath.join(srcVendor, file.to), file.stripSourceMap ? stripTrailingSourceMapLine(bytes) : bytes);
  });
  await forEachInOrder([...COPIED_FILES.map((file) => file.to), DECLARATION_FILE], async (name) => {
    await put(safePath.join(distVendor, name), await readFile(safePath.join(srcVendor, name)));
  });
  return written;
}

async function main(): Promise<void> {
  try {
    const written = await vendorTypescript(process.cwd());
    const outcome = written.length === 0 ? 'up to date' : `wrote ${String(written.length)} file(s)`;
    log(`vendor-typescript: ${outcome}`, 'green');
  } catch (error) {
    if (!(error instanceof VendorTypescriptRefusal)) throw error;
    log(error.message, 'red');
    process.exitCode = ExitCode.ERROR;
  }
}

if (isEntrypoint(import.meta.url)) await main();
