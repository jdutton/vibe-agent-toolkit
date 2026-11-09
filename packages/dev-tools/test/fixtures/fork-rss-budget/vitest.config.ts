/**
 * A raised-cap integration config, as a package would declare one, with the budget the
 * fork-RSS detector reads taken from FORK_RSS_PROBE_BUDGET: a number of MB, or `absent`
 * to provide none. Driven by `test/integration/fork-rss-budget.integration.test.ts`.
 */
import { defineConfig } from 'vitest/config';

import { createIntegrationTestConfig, maxTestWorkers } from '../../../../../vitest.shared.js';

const base = createIntegrationTestConfig({ maxWorkers: maxTestWorkers + 1 });
const { forkRssBudgetMb: _provided, ...withoutBudget } = base.provide;
const requested = process.env['FORK_RSS_PROBE_BUDGET'];

export default defineConfig({
  test: {
    ...base,
    include: ['probe.fixture.ts'],
    provide: requested === 'absent' ? withoutBudget : { ...withoutBudget, forkRssBudgetMb: Number(requested) },
  },
});
