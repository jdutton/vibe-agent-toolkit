/**
 * Fails a test file whose fork's PEAK resident memory passed the budget.
 *
 * Installed by `createIntegrationTestConfig` (vitest.shared.ts) only for a package
 * that raises its worker cap above `maxTestWorkers`. The cap is 2 because a fork
 * can hold memory `--max-old-space-size` never sees (onnxruntime, LanceDB's Arrow
 * engine: 1-3 GB each); a package may run more forks only while each stays under
 * `forkRssBudgetMb`, and this is what makes that a measured fact, not a comment.
 *
 * `process.resourceUsage().maxRSS` is the fork's lifetime peak in KiB on every
 * platform (libuv normalises macOS's bytes; on Windows it is the peak working
 * set). Forks are reused across files, so the file that crosses is the one that
 * fails — read the number, and look at what the fork ran before it as well.
 */
import { afterAll, inject } from 'vitest';

afterAll(() => {
	const budgetMb = inject('forkRssBudgetMb');
	const peakMb = Math.round(process.resourceUsage().maxRSS / 1024);
	// An unprovided budget is a refusal, not a pass: a missing number must not read as "under it".
	if (typeof budgetMb !== 'number' || peakMb > budgetMb) {
		throw new Error(
			`fork peak RSS ${peakMb} MB is over the ${budgetMb} MB budget (vitest.shared.ts: forkRssBudgetMb). ` +
				'This package runs its integration tier above the shared worker cap, which is only safe while every fork stays small. ' +
				'Find what grew (a native addon at work, a large fixture), or keep the suite at the default cap.',
		);
	}
});
