import { describe, expect, it, vi } from 'vitest';

import { createAjvWithUriFormats } from '../src/ajv-factory.js';

const URI_REFERENCE_SCHEMA = {
  type: 'object',
  properties: {
    ref: { type: 'string', format: 'uri-reference' },
  },
} as const;

const URI_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', format: 'uri' },
  },
} as const;

const IRI_REFERENCE_SCHEMA = {
  type: 'object',
  properties: {
    ref: { type: 'string', format: 'iri-reference' },
  },
} as const;

const IRI_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', format: 'iri' },
  },
} as const;

describe('createAjvWithUriFormats', () => {
  it('returns an Ajv instance', () => {
    const ajv = createAjvWithUriFormats();
    expect(typeof ajv.compile).toBe('function');
    expect(typeof ajv.addFormat).toBe('function');
  });

  it('compiles a uri-reference schema without throwing (the adopter pain point)', () => {
    const ajv = createAjvWithUriFormats({ allErrors: true });
    expect(() => ajv.compile(URI_REFERENCE_SCHEMA)).not.toThrow();
  });

  it('compiles a uri schema without throwing', () => {
    const ajv = createAjvWithUriFormats({ allErrors: true });
    expect(() => ajv.compile(URI_SCHEMA)).not.toThrow();
  });

  it('compiles an iri-reference schema without throwing (no-op shim)', () => {
    const ajv = createAjvWithUriFormats({ allErrors: true });
    expect(() => ajv.compile(IRI_REFERENCE_SCHEMA)).not.toThrow();
  });

  it('compiles an iri schema without throwing (no-op shim)', () => {
    const ajv = createAjvWithUriFormats({ allErrors: true });
    expect(() => ajv.compile(IRI_SCHEMA)).not.toThrow();
  });

  it('does not log "unknown format" warnings on compile', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ajv = createAjvWithUriFormats({ allErrors: true });
      ajv.compile(URI_REFERENCE_SCHEMA);
      ajv.compile(IRI_REFERENCE_SCHEMA);
      const unknownFormatWarnings = warnSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((msg) => msg.includes('unknown format'));
      expect(unknownFormatWarnings).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('uri-reference values pass validation (ajv-formats validates them)', () => {
    const ajv = createAjvWithUriFormats({ allErrors: true });
    const validate = ajv.compile(URI_REFERENCE_SCHEMA);
    expect(validate({ ref: '/docs/foo.md' })).toBe(true);
    expect(validate({ ref: 'foo.md' })).toBe(true);
    expect(validate({ ref: '#section' })).toBe(true);
  });

  it('iri-reference values always pass (no-op shim does not validate semantics)', () => {
    const ajv = createAjvWithUriFormats({ allErrors: true });
    const validate = ajv.compile(IRI_REFERENCE_SCHEMA);
    // The no-op shim accepts everything — semantic validation is the caller's
    // job (VAT uses resolveLocalHref for that).
    expect(validate({ ref: 'literally-anything' })).toBe(true);
    expect(validate({ ref: '日本語/path' })).toBe(true);
  });

  it('passes user-supplied Ajv options through', () => {
    const ajv = createAjvWithUriFormats({ verbose: true, useDefaults: true });
    const validate = ajv.compile({
      type: 'object',
      properties: { name: { type: 'string', default: 'fallback' } },
    });
    const data: { name?: string } = {};
    validate(data);
    expect(data.name).toBe('fallback');
  });

  it('respects strict: true when caller asks for it (formats registered so no throw)', () => {
    // The adopter's failure case: vanilla `new Ajv({ allErrors: true })` has
    // strict-mode-equivalent behavior for unknown formats. With our factory,
    // explicit strict: true still works because formats are registered.
    const ajv = createAjvWithUriFormats({ allErrors: true, strict: true });
    expect(() => ajv.compile(URI_REFERENCE_SCHEMA)).not.toThrow();
  });
});
