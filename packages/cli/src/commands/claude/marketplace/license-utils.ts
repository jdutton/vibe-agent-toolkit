/**
 * License resolution utilities for marketplace publish.
 *
 * Handles SPDX shortcut identifiers (e.g., "mit" → full MIT license text)
 * and file path references (e.g., "./LICENSE" → copy as-is).
 *
 * The output of {@link generateLicenseText} is written verbatim as the LICENSE
 * file of a published marketplace, so VAT only accepts an SPDX shortcut when it
 * carries that license's complete text. For everything else it refuses and
 * directs the user at the file-path form — see {@link UNRENDERABLE_SPDX_IDS}.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

/** Build a lowercase-keyed lookup from canonical SPDX identifiers. */
function byLowercaseId(canonicalIds: readonly string[]): ReadonlyMap<string, string> {
  return new Map(canonicalIds.map(id => [id.toLowerCase(), id]));
}

/** Renders the complete text of one license, stamped with owner and year. */
type LicenseRenderer = (ownerName: string, year: number) => string;

/**
 * Complete license texts VAT can emit, keyed by canonical SPDX identifier.
 *
 * This table — not a separate list of identifiers — is the source of truth for
 * what VAT will render, so it is structurally impossible to vouch for an
 * identifier without supplying its text. The returned string is written
 * verbatim as the LICENSE file of a published marketplace, so every entry must
 * be the license itself: not a summary, not a notice header.
 */
const LICENSE_TEXT_RENDERERS: Readonly<Record<string, LicenseRenderer>> = {
  MIT: (ownerName, year) => `MIT License

Copyright (c) ${year} ${ownerName}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
};

/**
 * SPDX identifiers VAT embeds the complete license text for.
 *
 * Derived from {@link LICENSE_TEXT_RENDERERS} so the two can never disagree.
 */
export const RENDERABLE_SPDX_IDS = byLowercaseId(Object.keys(LICENSE_TEXT_RENDERERS));

/**
 * SPDX identifiers VAT recognizes but refuses to render.
 *
 * VAT carries no vetted copy of these texts, and a summary or a notice header
 * is not a license: GPL-3.0 §4 and Apache-2.0 §4(a) both require conveying a
 * copy of the License with the work. Listing them here buys a specific,
 * actionable error instead of a generic "unknown identifier".
 */
export const UNRENDERABLE_SPDX_IDS = byLowercaseId([
  'Apache-2.0',
  'GPL-2.0',
  'GPL-3.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MPL-2.0',
  'Unlicense',
]);

/**
 * Check if a license value looks like a file path.
 *
 * A value is treated as a file path if it contains a `/` or has a dot that
 * looks like a file extension (dot followed by a non-digit, e.g. `.txt`, `.md`).
 * Version-style dots in SPDX identifiers (e.g. `apache-2.0`, `gpl-3.0`) are
 * NOT treated as file-path indicators.
 */
export function isFilePath(value: string): boolean {
  if (value.includes('/')) return true;
  // Match a dot followed by a non-digit character — file extension pattern
  return /\.[^\d]/.test(value);
}

/**
 * Check if a value is an SPDX identifier VAT can turn into a complete LICENSE
 * file (case-insensitive).
 *
 * `true` here is a promise that {@link generateLicenseText} will produce the
 * full license text, not a summary of it.
 */
export function isSpdxIdentifier(value: string): boolean {
  return RENDERABLE_SPDX_IDS.has(value.toLowerCase());
}

/**
 * Explain why a license value cannot be turned into a LICENSE file, or return
 * undefined when it can.
 *
 * Shared by every caller so the diagnosis is identical whether the value is
 * rejected during option parsing or during tree composition.
 */
export function explainUnusableLicense(value: string): string | undefined {
  const id = value.toLowerCase();

  if (RENDERABLE_SPDX_IDS.has(id)) {
    return undefined;
  }

  const canonical = UNRENDERABLE_SPDX_IDS.get(id);
  if (canonical !== undefined) {
    return (
      `VAT cannot generate the full text of the "${value}" license. ` +
      `Emitting a summary or a notice header would produce a legally void LICENSE ` +
      `file — most licenses require that a complete copy be conveyed with the work. ` +
      `Download the official text from https://spdx.org/licenses/${canonical}.html ` +
      `and set \`license\` to its file path instead (e.g. ./LICENSE).`
    );
  }

  const renderable = [...RENDERABLE_SPDX_IDS.keys()].join(', ');
  return (
    `"${value}" is neither an SPDX identifier VAT can generate nor a file path. ` +
    `Set \`license\` to a LICENSE file path (e.g. ./LICENSE), ` +
    `or to one of: ${renderable}.`
  );
}

/**
 * Read a license file from disk.
 */
export function readLicenseFile(filePath: string, baseDir: string): string {
  const resolved = safePath.resolve(baseDir, filePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated config
  return readFileSync(resolved, 'utf-8');
}

/**
 * Generate the complete license text for a renderable SPDX identifier.
 *
 * @throws when the identifier is not in {@link RENDERABLE_SPDX_IDS} — including
 *   for identifiers VAT recognizes but has no vetted text for. Producing a
 *   plausible-looking stub is worse than refusing: the caller writes this
 *   string straight to disk as LICENSE.
 */
export function generateLicenseText(spdxId: string, ownerName: string, year: number): string {
  const problem = explainUnusableLicense(spdxId);
  if (problem !== undefined) {
    throw new Error(problem);
  }

  const canonical = RENDERABLE_SPDX_IDS.get(spdxId.toLowerCase()) ?? '';
  const render = LICENSE_TEXT_RENDERERS[canonical];
  if (render === undefined) {
    // Unreachable while RENDERABLE_SPDX_IDS is derived from the renderer table.
    throw new Error(`No license text renderer registered for "${spdxId}".`);
  }

  return render(ownerName, year);
}

/**
 * Resolve a license config value to LICENSE file content.
 *
 * @param licenseValue - SPDX identifier or file path from config
 * @param ownerName - Owner name for generated license text
 * @param baseDir - Base directory for resolving file paths
 * @returns License text content
 */
export function resolveLicense(licenseValue: string, ownerName: string, baseDir: string): string {
  if (isFilePath(licenseValue)) {
    return readLicenseFile(licenseValue, baseDir);
  }

  return generateLicenseText(licenseValue, ownerName, new Date().getFullYear());
}
