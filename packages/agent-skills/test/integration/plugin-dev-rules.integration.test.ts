import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { validatePlugin } from '../../src/validators/plugin-validator.js';
import { validateSkill } from '../../src/validators/skill-validator.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = safePath.join(
	__dirname,
	'..',
	'fixtures',
	'plugin-dev-rules',
	'sample-plugin',
);

describe('plugin-dev cross-walk rules (integration)', () => {
	it('plugin manifest fires PLUGIN_MISSING_DESCRIPTION/AUTHOR/LICENSE at info', async () => {
		const result = await validatePlugin(FIXTURE);
		const codes = result.issues.map(i => i.code);
		expect(codes).toContain('PLUGIN_MISSING_DESCRIPTION');
		expect(codes).toContain('PLUGIN_MISSING_AUTHOR');
		expect(codes).toContain('PLUGIN_MISSING_LICENSE');
	});

	it('skill validator fires SKILL_REFERENCES_BUT_NO_LINKS for the unreferenced scripts/ dir', async () => {
		const result = await validateSkill({ skillPath: safePath.join(FIXTURE, 'SKILL.md') });
		const codes = result.issues.map(i => i.code);
		expect(codes).toContain('SKILL_REFERENCES_BUT_NO_LINKS');
	});

	it('skill validator fires SKILL_BODY_NOT_IMPERATIVE for "You should…"', async () => {
		const result = await validateSkill({ skillPath: safePath.join(FIXTURE, 'SKILL.md') });
		const codes = result.issues.map(i => i.code);
		expect(codes).toContain('SKILL_BODY_NOT_IMPERATIVE');
	});

	it('all new codes ship at info severity by default', async () => {
		const pluginResult = await validatePlugin(FIXTURE);
		const skillResult = await validateSkill({ skillPath: safePath.join(FIXTURE, 'SKILL.md') });
		const newCodes = new Set([
			'PLUGIN_MISSING_DESCRIPTION',
			'PLUGIN_MISSING_AUTHOR',
			'PLUGIN_MISSING_LICENSE',
			'SKILL_REFERENCES_BUT_NO_LINKS',
			'SKILL_BODY_NOT_IMPERATIVE',
		]);
		for (const issue of [...pluginResult.issues, ...skillResult.issues]) {
			if (newCodes.has(issue.code)) {
				expect(issue.severity).toBe('info');
			}
		}
	});
});
