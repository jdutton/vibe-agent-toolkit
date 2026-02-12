import { describe, it, expect } from 'vitest';

import { detectFormat } from '../src/detectors/format-detector.js';

const AGENT_SKILL_FORMAT = 'agent-skill';

describe('detectFormat', () => {
  it('should detect SKILL.md as agent-skill', () => {
    expect(detectFormat('SKILL.md')).toBe(AGENT_SKILL_FORMAT);
    expect(detectFormat('/path/to/SKILL.md')).toBe(AGENT_SKILL_FORMAT);
    expect(detectFormat('./my-skill/SKILL.md')).toBe(AGENT_SKILL_FORMAT);
  });

  it('should detect agent.yaml as vat-agent', () => {
    expect(detectFormat('agent.yaml')).toBe('vat-agent');
    expect(detectFormat('/path/to/agent.yaml')).toBe('vat-agent');
  });

  it('should detect agent.yml as vat-agent', () => {
    expect(detectFormat('agent.yml')).toBe('vat-agent');
  });

  it('should detect .md files as markdown', () => {
    expect(detectFormat('README.md')).toBe('markdown');
    expect(detectFormat('docs/guide.md')).toBe('markdown');
    expect(detectFormat('reference/api.md')).toBe('markdown');
  });

  it('should not detect SKILL.md as markdown', () => {
    expect(detectFormat('SKILL.md')).not.toBe('markdown');
    expect(detectFormat('SKILL.md')).toBe(AGENT_SKILL_FORMAT);
  });

  it('should return unknown for other files', () => {
    expect(detectFormat('package.json')).toBe('unknown');
    expect(detectFormat('index.ts')).toBe('unknown');
    expect(detectFormat('test.txt')).toBe('unknown');
  });

  it('should be case-sensitive for SKILL.md', () => {
    expect(detectFormat('skill.md')).toBe('markdown');
    expect(detectFormat('Skill.md')).toBe('markdown');
    expect(detectFormat('SKILL.MD')).toBe('markdown');
  });
});
