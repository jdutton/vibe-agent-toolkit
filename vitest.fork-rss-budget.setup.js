/**
 * Fails a test file whose fork's PEAK resident memory passed the budget.
 *
 * Installed (vitest.shared.ts) where a tier runs more forks than its memory was
 * once sized for: by `createIntegrationTestConfig` for a package that raises its
 * worker cap above `maxTestWorkers` — the cap is 2 because an integration fork can
 * hold memory `--max-old-space-size` never sees (onnxruntime, LanceDB's Arrow
 * engine: 1-3 GB each) — and by `createSystemTestConfig` for every package, since
 * Windows runs that tier on 2 workers where it ran 1, beside `rag-lancedb` forks
 * that load LanceDB and ONNX in-process.
 *
 * A DETECTOR, not a limit: it reads the peak after the file ran, so it names a
 * file that grew, and cannot stop a fork the machine kills first. Its scope is
 * the fork's own process (worker threads included) — a `vat` child a test spawns
 * is outside it.
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
				'This tier\'s forks are sized to this budget so that they can run side by side. ' +
				'Find what grew (a native addon at work, a large fixture) and shrink it, or re-measure the budget for the whole tier.',
		);
	}
});
