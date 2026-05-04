/**
 * Shared helpers for audit pipeline tests (capture script + parity harness).
 *
 * Extracted to eliminate duplication between:
 *   - capture-legacy-snapshot.ts  (one-shot capture tool)
 *   - inventory-parity.system.test.ts  (regression parity harness)
 */

import * as path from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';

import { getValidationResults } from '../../src/commands/audit.js';
import { createLogger } from '../../src/utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FindingTuple {
	path: string;
	code: string;
	location: string;
	severity: string;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an absolute path to a corpus-relative POSIX path.
 * If the value is not absolute or cannot be made relative, return it unchanged.
 */
export function toCorpusRelative(corpus: string, value: string): string {
	if (!value) return value;
	if (path.isAbsolute(value)) {
		return safePath.relative(corpus, value);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------

export function compareStrings(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

export function sortTuples(tuples: FindingTuple[]): FindingTuple[] {
	return [...tuples].sort((a, b) => {
		if (a.path !== b.path) return compareStrings(a.path, b.path);
		if (a.code !== b.code) return compareStrings(a.code, b.code);
		return compareStrings(a.location, b.location);
	});
}

// ---------------------------------------------------------------------------
// Collection helper
// ---------------------------------------------------------------------------

/**
 * Run the audit pipeline over `corpus` (recursive) and return sorted
 * (path, code, location, severity) tuples for all findings.
 */
export async function collectFindings(corpus: string): Promise<FindingTuple[]> {
	const logger = createLogger({});
	const results = await getValidationResults(corpus, true, {}, logger);

	const tuples: FindingTuple[] = [];
	for (const result of results) {
		const resultPath = toCorpusRelative(corpus, result.path);
		for (const issue of result.issues) {
			const rawLoc = issue.location ?? '';
			const location = toCorpusRelative(corpus, rawLoc);
			tuples.push({
				path: resultPath,
				code: String(issue.code),
				location,
				severity: String(issue.severity),
			});
		}
	}

	return sortTuples(tuples);
}
