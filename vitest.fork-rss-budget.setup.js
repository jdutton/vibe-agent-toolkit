/**
 * Fails a test file whose fork's PEAK resident memory passed the budget.
 *
 * Installed by `createIntegrationTestConfig` (vitest.shared.ts) only for a package
 * that raises its worker cap above `maxTestWorkers`. The cap is 2 because a fork
 * can hold memory `--max-old-space-size` never sees (onnxruntime, LanceDB's Arrow
 * engine: 1-3 GB each); a package may run more forks only while each stays under
 * `forkRssBudgetMb`.
 *
 * A DETECTOR, not a limit: it reads the peak after the file ran, so it names a
 * file that grew, and cannot stop a fork the machine kills first. Its scope is
 * the fork's own process (worker threads included) — a `vat` child a test spawns
 * is outside it (the cap now allows more such children at once than 2 did).
 *
 * `process.resourceUsage().maxRSS` is in KiB on every platform (libuv normalises
 * macOS's bytes; on Windows it is the peak working set). On Linux it also carries
 * the vitest parent's resident set at fork time, so there it can read high. On
 * Windows the peak working set can read LOW under memory pressure, when Windows
 * trims working sets — it names a file that grew by gigabytes, not a near miss.
 * With isolation on (vitest's default, which no tier overrides) every test
 * file gets a fresh fork, so the figure is that one file's.
 */
import { afterAll, inject } from 'vitest';

afterAll(() => {
	const budgetMb = inject('forkRssBudgetMb');
	const peakMb = Math.round(process.resourceUsage().maxRSS / 1024);
	// An unprovided budget is a refusal, not a pass: a missing number must not read as "under it".
	if (typeof budgetMb !== 'number' || peakMb > budgetMb) {
		throw new Error(
			`fork peak RSS ${peakMb} MB is over the ${String(budgetMb)} MB budget (vitest.shared.ts: forkRssBudgetMb). ` +
				'This package runs its integration tier above the shared worker cap, which is only safe while every fork stays small. ' +
				'Find what grew (a native addon at work, a large fixture), or keep the suite at the default cap.',
		);
	}
});
