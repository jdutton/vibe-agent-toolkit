import { describe, expect, it } from 'vitest';

import {
  renderTemplate,
  TemplateMissingVarError,
  TemplateSyntaxError,
} from '../../src/link-auth/template.js';
import { UnknownTransformError } from '../../src/link-auth/transforms.js';

describe('renderTemplate', () => {
  describe('literal substitution', () => {
    it('passes literal text through unchanged', () => {
      expect(renderTemplate('just literal text', {})).toBe('just literal text');
    });

    it('returns empty string for empty template', () => {
      expect(renderTemplate('', {})).toBe('');
    });

    it('substitutes ${name} with context value', () => {
      expect(renderTemplate('hello ${name}', { name: 'world' })).toBe('hello world');
    });

    it('substitutes multiple variables in one template', () => {
      expect(renderTemplate('${greeting} ${name}!', { greeting: 'hi', name: 'world' })).toBe(
        'hi world!',
      );
    });

    it('substitutes the same variable referenced multiple times', () => {
      expect(renderTemplate('${x}-${x}', { x: 'a' })).toBe('a-a');
    });

    it('substitutes empty-string values', () => {
      expect(renderTemplate('a${x}b', { x: '' })).toBe('ab');
    });
  });

  describe('transform calls', () => {
    it('applies a transform to a referenced variable', () => {
      expect(renderTemplate('${lower(host)}', { host: 'GITHUB.COM' })).toBe('github.com');
    });

    it('renders the SharePoint share-id form (externally pinned: base64url("foobar")="Zm9vYmFy")', () => {
      expect(renderTemplate('u!${base64url(u)}', { u: 'foobar' })).toBe('u!Zm9vYmFy');
    });

    it('renders mixed literal + plain var + transform call', () => {
      expect(
        renderTemplate('https://${host}/${urlencode(path)}', {
          host: 'example.com',
          path: 'a b',
        }),
      ).toBe('https://example.com/a%20b');
    });

    it('throws UnknownTransformError for an unknown transform name (delegates to applyTransform)', () => {
      expect(() => renderTemplate('${eval(x)}', { x: 'y' })).toThrow(UnknownTransformError);
    });
  });

  describe('missing variables', () => {
    it('throws TemplateMissingVarError when a referenced var is not in context', () => {
      expect(() => renderTemplate('${missing}', {})).toThrow(TemplateMissingVarError);
    });

    it('error message names the missing variable and the template', () => {
      let err: unknown;
      try {
        renderTemplate('https://${owner}/${repo}', { owner: 'acme' });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TemplateMissingVarError);
      const message = (err as Error).message;
      expect(message).toContain('repo');
      expect(message).toContain('https://${owner}/${repo}');
    });

    it('throws TemplateMissingVarError when a transform-arg var is missing', () => {
      expect(() => renderTemplate('${base64url(missing)}', { other: 'x' })).toThrow(
        TemplateMissingVarError,
      );
    });

    it('rejects Object.prototype keys as variable names — load-bearing: the lookup uses Object.hasOwn', () => {
      // Without Object.hasOwn, context["__proto__"] returns Object.prototype
      // (not undefined), and the renderer would silently substitute
      // "[object Object]" into the output. This test mirrors the equivalent
      // adversarial-key test in transforms.test.ts.
      const adversarial = ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf'];
      for (const name of adversarial) {
        expect(() => renderTemplate(`\${${name}}`, {})).toThrow(TemplateMissingVarError);
        expect(() => renderTemplate(`\${base64url(${name})}`, {})).toThrow(
          TemplateMissingVarError,
        );
      }
    });
  });

  describe('syntax errors', () => {
    it('throws TemplateSyntaxError for an empty expression ${}', () => {
      expect(() => renderTemplate('${}', {})).toThrow(TemplateSyntaxError);
    });

    it('throws TemplateSyntaxError for whitespace inside ${ name }', () => {
      expect(() => renderTemplate('${ name }', { name: 'x' })).toThrow(TemplateSyntaxError);
    });

    it('throws TemplateSyntaxError for an unterminated ${ (no matching })', () => {
      expect(() => renderTemplate('hello ${name', { name: 'x' })).toThrow(TemplateSyntaxError);
    });

    it('throws TemplateSyntaxError for unrecognized inner syntax', () => {
      expect(() => renderTemplate('${foo + bar}', { foo: 'a', bar: 'b' })).toThrow(
        TemplateSyntaxError,
      );
    });

    it('throws TemplateSyntaxError for nested ${a${b}} (greedy-match guard)', () => {
      expect(() => renderTemplate('${a${b}}', { a: '1', b: '2' })).toThrow(TemplateSyntaxError);
    });
  });
});
