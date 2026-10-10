/**
 * One reading of a project's `package.json` for the lanes that want an
 * OPTIONAL field out of it — a `version` to stamp, a `vat.skills` list, a
 * `files` allowlist.
 *
 * Every one of those lanes used to spell the read as `existsSync` →
 * `readFileSync` → `JSON.parse` inside one `try { … } catch { return <absent> }`,
 * which made "there is no package.json" indistinguishable from "there is one
 * and it is not JSON" and from "there is one and the OS refused it". The first
 * is the sentinel's meaning; the other two were reported as it — a build
 * stamped no version, a consistency check verified nothing, and neither said
 * why. npm itself refuses a manifest it cannot parse, so a tree with one is
 * already broken; the reader's job is to say so, not to proceed around it.
 */

import { readFileSync } from 'node:fs';

import { classifyFsFault, isPathAbsentError } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from './command-refusal.js';

/**
 * The parsed manifest, or `undefined` when there is none at `pkgPath`.
 *
 * @throws {CommandRefusalError} `INPUT_UNREADABLE` naming the file when it
 *   exists but is not a JSON object (the parse error is the `cause`), or when
 *   the OS refused the read (a refusal stays a refusal, never an absence).
 */
export function readPackageJsonOrAbsent(pkgPath: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf-8');
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    throw classifyFsFault(error, { side: 'source', origin: 'content', action: 'read package.json', path: pkgPath });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new CommandRefusalError('INPUT_UNREADABLE', `${pkgPath} is not valid JSON: ${error.message}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CommandRefusalError('INPUT_UNREADABLE', `${pkgPath} is not a JSON object, so it is not a package manifest`);
  }
  return parsed as Record<string, unknown>;
}
