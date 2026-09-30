import { stat } from 'node:fs/promises';

import type { InventoryParseError } from '@vibe-agent-toolkit/agent-skills';
import { isFilesystemAccessError, isPathAbsentError } from '@vibe-agent-toolkit/utils';

/**
 * One `parseErrors[]` row, marked `unreadable` when the OS refused the path so
 * the consumer files it as a refusal, not a defect: an `EACCES` on `skills/<name>`
 * used to reach `vat audit` as `PLUGIN_INVALID_JSON` at error severity.
 */
export function recordedFailure(path: string, message: string, cause: unknown): InventoryParseError {
	return isFilesystemAccessError(cause) ? { path, message, unreadable: true } : { path, message };
}

/**
 * Whether anything is at `path`. Absent is `false` with no row; a `stat` the
 * OS refuses is `false` WITH its row — `existsSync` answered "absent" for both.
 */
export async function presentOrRecord(path: string, parseErrors: InventoryParseError[]): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (e) {
		if (!isPathAbsentError(e)) parseErrors.push(recordedFailure(path, (e as Error).message, e));
		return false;
	}
}
