import { describe, expect, it } from 'vitest';

import { renderTemplate } from '../src/template.js';

describe('renderTemplate', () => {
  it('renders simple property access', () => {
    expect(renderTemplate('{{link.text}}', { link: { text: 'Hello' } })).toBe('Hello');
  });

  it('renders multiple properties', () => {
    const ctx = { link: { text: 'Guide' }, skill: { name: 'manuscript' } };
    expect(renderTemplate('{{link.text}} (search {{skill.name}})', ctx)).toBe('Guide (search manuscript)');
  });

  it('does not HTML-escape special characters', () => {
    expect(renderTemplate('{{link.text}}', { link: { text: 'a & b <c>' } })).toBe('a & b <c>');
  });

  it('returns empty string for missing property', () => {
    expect(renderTemplate('{{link.missing}}', { link: { text: 'x' } })).toBe('');
  });
});
