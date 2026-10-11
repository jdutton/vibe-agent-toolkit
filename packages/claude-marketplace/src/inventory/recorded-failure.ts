import type { InventoryParseError } from '@vibe-agent-toolkit/agent-skills';
import { fsFaultOf, pathPresent } from '@vibe-agent-toolkit/utils';

/**
 * One `parseErrors[]` row, marked `unreadable` when the OS refused the path so
 * the consumer files it as a refusal, not a defect: an `EACCES` on `skills/<name>`
 * used to reach `vat audit` as `PLUGIN_INVALID_JSON` at error severity.
 */
export function recordedFailure(path: string, message: string, cause: unknown): InventoryParseError {
	return fsFaultOf(cause) === undefined ? { path, message } : { path, message, unreadable: true };
}

/**
 * Record `cause` against `path` unless that row is already there: one path is
 * probed or listed by more than one lane (a declared `skills` ref and discovery,
 * discovery and the whole-tree crawl), and one refusal is one row.
 */
export function recordOnce(parseErrors: InventoryParseError[], path: string, cause: unknown): void {
	const message = (cause as Error).message;
	if (!parseErrors.some((row) => row.path === path && row.message === message)) {
		parseErrors.push(recordedFailure(path, message, cause));
	}
}

/** What a probe of a path found: something, nothing, or a refusal already recorded. */
type Presence = 'present' | 'absent' | 'refused';

/**
 * What is at `path` (followed: a dangling link is absent). `refused` — a `stat`
 * the OS would not answer — has its row recorded, because the extractors never
 * throw; `absent` has none, and what an absence means is the caller's to say.
 */
export function presenceOrRecord(path: string, parseErrors: InventoryParseError[]): Presence {
	try {
		return pathPresent(path, 'follow', 'source', 'probe') ? 'present' : 'absent';
	} catch (e) {
		recordOnce(parseErrors, path, e);
		return 'refused';
	}
}
