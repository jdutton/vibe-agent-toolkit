import type { InventoryParseError } from '@vibe-agent-toolkit/agent-skills';
import { everywhere, fsFaultOf, isFsFaultError, isLinkChainRefusedError, pathPresent } from '@vibe-agent-toolkit/utils';

/**
 * One `parseErrors[]` row, marked `unreadable` when the OS refused the path, or a
 * link chain VAT would not hand the kernel (`LINK_CHAIN_REFUSED`, raw or wrapped
 * by `pathPresent`), so the consumer files it as a refusal, not a defect.
 */
export function recordedFailure(path: string, message: string, cause: unknown): InventoryParseError {
	const refused = fsFaultOf(cause) !== undefined || isFsFaultError(cause) || isLinkChainRefusedError(cause);
	return refused ? { path, message, unreadable: true } : { path, message };
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
 * What is at `path` (followed: a dangling link is absent). A `refused` probe has
 * its row recorded, since the extractors never throw; `absent` has none.
 *
 * @param path - The path to probe
 * @param within - The tree it is read in: the plugin, marketplace or install root the operator named
 * @param parseErrors - Where a refusal is recorded
 */
export function presenceOrRecord(path: string, within: string, parseErrors: InventoryParseError[]): Presence {
	try {
		return pathPresent(path, { follow: within }, everywhere('source'), 'probe') ? 'present' : 'absent';
	} catch (e) {
		recordOnce(parseErrors, path, e);
		return 'refused';
	}
}
