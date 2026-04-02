/**
 * License resolution utilities for marketplace publish.
 *
 * Handles SPDX shortcut identifiers (e.g., "mit" → full MIT license text)
 * and file path references (e.g., "./LICENSE" → copy as-is).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Known SPDX identifiers (lowercase). Extend as needed. */
const KNOWN_SPDX_IDS = new Set([
  'mit',
  'apache-2.0',
  'gpl-2.0',
  'gpl-3.0',
  'lgpl-2.1',
  'lgpl-3.0',
  'bsd-2-clause',
  'bsd-3-clause',
  'isc',
  'mpl-2.0',
  'unlicense',
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
 * Check if a value is a known SPDX license identifier (case-insensitive).
 */
export function isSpdxIdentifier(value: string): boolean {
  return KNOWN_SPDX_IDS.has(value.toLowerCase());
}

/**
 * Read a license file from disk.
 */
export function readLicenseFile(filePath: string, baseDir: string): string {
  const resolved = resolve(baseDir, filePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated config
  return readFileSync(resolved, 'utf-8');
}

/**
 * Generate standard license text for a known SPDX identifier.
 */
export function generateLicenseText(spdxId: string, ownerName: string, year: number): string {
  const id = spdxId.toLowerCase();

  switch (id) {
    case 'mit':
      return `MIT License

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
`;

    case 'apache-2.0':
      return `Copyright ${year} ${ownerName}

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
`;

    default:
      if (!KNOWN_SPDX_IDS.has(id)) {
        throw new Error(`Unknown SPDX license identifier: "${spdxId}". Use a file path instead.`);
      }
      return `This software is licensed under the ${spdxId} license.

Copyright (c) ${year} ${ownerName}
`;
  }
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

  if (!isSpdxIdentifier(licenseValue)) {
    throw new Error(
      `"${licenseValue}" is neither a known SPDX identifier nor a file path. ` +
        `Use a known identifier (mit, apache-2.0, etc.) or a file path (./LICENSE).`,
    );
  }

  return generateLicenseText(licenseValue, ownerName, new Date().getFullYear());
}
