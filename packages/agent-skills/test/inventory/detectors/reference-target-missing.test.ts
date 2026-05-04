import { describe, it, expect } from 'vitest';

import { detectReferenceTargetMissing } from '../../../src/inventory/detectors/reference-target-missing.js';
import type { ResolvedReference } from '../../../src/inventory/index.js';
import { makePluginInventory } from '../plugin-inventory-fixtures.js';

const REFERENCE_TARGET_MISSING_CODE = 'REFERENCE_TARGET_MISSING';
const HOOK_FROM = 'hooks[0].script';
const HOOK_MISSING_TO = '/abs/hooks/missing.sh';

function makePlugin(references: ResolvedReference[]) {
	return makePluginInventory({}, {}, { references });
}

describe('detectReferenceTargetMissing', () => {
	it('returns no issues when references is empty', () => {
		expect(detectReferenceTargetMissing(makePlugin([]))).toEqual([]);
	});

	it('returns no issues when all references exist', () => {
		const inv = makePlugin([
			{ from: HOOK_FROM, to: '/abs/hooks/setup.sh', exists: true },
		]);
		expect(detectReferenceTargetMissing(inv)).toEqual([]);
	});

	it('returns one issue for a reference whose target does not exist', () => {
		const inv = makePlugin([
			{ from: HOOK_FROM, to: HOOK_MISSING_TO, exists: false },
		]);
		const issues = detectReferenceTargetMissing(inv);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.code).toBe(REFERENCE_TARGET_MISSING_CODE);
		expect(issues[0]?.severity).toBe('error');
		expect(issues[0]?.message).toContain(HOOK_FROM);
		expect(issues[0]?.message).toContain(HOOK_MISSING_TO);
		expect(issues[0]?.location).toBe(HOOK_MISSING_TO);
	});

	it('returns one issue per missing reference', () => {
		const inv = makePlugin([
			{ from: HOOK_FROM, to: '/abs/hooks/a.sh', exists: false },
			{ from: 'hooks[1].script', to: '/abs/hooks/b.sh', exists: true },
			{ from: 'mcpServers[0].path', to: '/abs/mcp/server.js', exists: false },
		]);
		const issues = detectReferenceTargetMissing(inv);
		expect(issues).toHaveLength(2);
		for (const issue of issues) {
			expect(issue.code).toBe(REFERENCE_TARGET_MISSING_CODE);
			expect(issue.severity).toBe('error');
		}
	});
});
