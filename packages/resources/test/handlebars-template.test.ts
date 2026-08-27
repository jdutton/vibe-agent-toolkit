import { describe, expect, it } from 'vitest';

import { renderHandlebarsTemplate } from '../src/handlebars-template.js';

describe('renderHandlebarsTemplate', () => {
  it('renders simple property access', () => {
    expect(renderHandlebarsTemplate('{{link.text}}', { link: { text: 'Hello' } })).toBe('Hello');
  });

  it('renders multiple properties', () => {
    const ctx = { link: { text: 'Guide' }, skill: { name: 'my-toolkit' } };
    expect(renderHandlebarsTemplate('{{link.text}} (search {{skill.name}})', ctx)).toBe('Guide (search my-toolkit)');
  });

  it('does not HTML-escape special characters', () => {
    expect(renderHandlebarsTemplate('{{link.text}}', { link: { text: 'a & b <c>' } })).toBe('a & b <c>');
  });

  it('returns empty string for missing property', () => {
    expect(renderHandlebarsTemplate('{{link.missing}}', { link: { text: 'x' } })).toBe('');
  });
});
