import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { validateSkill } from '../../src/validators/skill-validator.js';
import { runValidationFramework } from '../../src/validators/validation-framework.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = safePath.join(__dirname, '..', 'fixtures', 'compat-scenarios');

describe('compat detectors in validateSkill (integration)', () => {
  it('emits zero CAPABILITY_* issues for a portable skill', async () => {
    const skillPath = safePath.join(FIXTURES, 'portable-skill', 'SKILL.md');
    const result = await validateSkill({ skillPath });
    const capability = result.issues.filter(i => i.code.startsWith('CAPABILITY_'));
    expect(capability, `unexpected capability issues: ${JSON.stringify(capability, null, 2)}`).toHaveLength(0);
  });

  it('emits CAPABILITY_BROWSER_AUTH for an MSAL-based skill', async () => {
    const skillPath = safePath.join(FIXTURES, 'browser-auth-skill', 'SKILL.md');
    const result = await validateSkill({ skillPath });
    const codes = result.issues.filter(i => i.code.startsWith('CAPABILITY_')).map(i => i.code);
    expect(codes).toContain('CAPABILITY_BROWSER_AUTH');
  });

  it('emits CAPABILITY_EXTERNAL_CLI and CAPABILITY_LOCAL_SHELL for an az-cli skill', async () => {
    const skillPath = safePath.join(FIXTURES, 'external-cli-skill', 'SKILL.md');
    const result = await validateSkill({ skillPath });
    const codes = result.issues.filter(i => i.code.startsWith('CAPABILITY_')).map(i => i.code);
    expect(codes).toContain('CAPABILITY_EXTERNAL_CLI');
    expect(codes).toContain('CAPABILITY_LOCAL_SHELL');
  });

  it('suppresses CAPABILITY_EXTERNAL_CLI and CAPABILITY_LOCAL_SHELL when validation.allow matches', async () => {
    const skillPath = safePath.join(FIXTURES, 'external-cli-skill-with-allow', 'SKILL.md');
    const result = await validateSkill({ skillPath });
    const framework = runValidationFramework(result.issues, {
      allow: {
        CAPABILITY_EXTERNAL_CLI: [{
          paths: ['**/*'],
          reason: 'Uses `az` CLI to query Azure resources',
        }],
        CAPABILITY_LOCAL_SHELL: [{
          paths: ['**/*'],
          reason: 'Shells out via Bash; Code surface provides this',
        }],
      },
    });
    const remainingCapability = framework.emitted.filter(i => i.code.startsWith('CAPABILITY_'));
    expect(remainingCapability).toHaveLength(0);
    expect(framework.allowed.filter(a => a.code.startsWith('CAPABILITY_'))).toHaveLength(2);
  });
});
