/**
 * The pure halves of `vendor-typescript.ts`: the pin check that refuses a TypeScript other than the
 * one `resources` declares, the strip of the trailing source-map line, and the write that skips
 * equal bytes. The file I/O is an injected port, so no test here touches the disk; the real
 * resolution path, run on a temp package, is `integration/vendor-typescript.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  assertPinnedTypescript,
  replaceIfChanged,
  stripTrailingSourceMapLine,
  type ReplaceIo,
  VendorTypescriptRefusal,
} from '../src/vendor-typescript.js';

const MANIFEST = '/pkg/package.json';
const TARGET = '/pkg/src/vendor/typescript.cjs';

/** An in-memory {@link ReplaceIo} that records every replace. */
function memoryIo(initial: Record<string, string> = {}): ReplaceIo & { files: Map<string, string>; replaced: string[] } {
  const files = new Map(Object.entries(initial));
  const replaced: string[] = [];
  return {
    files,
    replaced,
    read: (path) => {
      const text = files.get(path);
      return Promise.resolve(text === undefined ? undefined : Buffer.from(text));
    },
    replace: (path, bytes) => {
      replaced.push(path);
      files.set(path, bytes.toString('utf8'));
      return Promise.resolve();
    },
  };
}

describe('assertPinnedTypescript', () => {
  it('accepts a resolved version equal to the exact declared one', () => {
    expect(() => assertPinnedTypescript('6.0.3', '6.0.3', MANIFEST)).not.toThrow();
  });

  it('refuses a resolved version other than the declared one, naming both and the devDependency', () => {
    expect(() => assertPinnedTypescript('6.0.3', '6.0.2', MANIFEST)).toThrow(VendorTypescriptRefusal);
    expect(() => assertPinnedTypescript('6.0.3', '6.0.2', MANIFEST)).toThrow(/6\.0\.2.*6\.0\.3|6\.0\.3.*6\.0\.2/s);
    expect(() => assertPinnedTypescript('6.0.3', '6.0.2', MANIFEST)).toThrow(/devDependencies/);
  });

  it('refuses a range spec even when the resolved version satisfies it', () => {
    expect(() => assertPinnedTypescript('^6.0.3', '6.0.3', MANIFEST)).toThrow(VendorTypescriptRefusal);
    expect(() => assertPinnedTypescript('~6.0.3', '6.0.3', MANIFEST)).toThrow(/"~6\.0\.3", not an exact version/);
  });

  it('refuses when the manifest declares no typescript devDependency', () => {
    expect(() => assertPinnedTypescript(undefined, '6.0.3', MANIFEST)).toThrow(/devDependencies/);
  });

  it('refuses when the resolved manifest carries no version', () => {
    expect(() => assertPinnedTypescript('6.0.3', undefined, MANIFEST)).toThrow(VendorTypescriptRefusal);
  });
});

describe('stripTrailingSourceMapLine', () => {
  const strip = (text: string): string => stripTrailingSourceMapLine(Buffer.from(text)).toString('utf8');

  it('removes only the trailing sourceMappingURL line, keeping the newline before it', () => {
    expect(strip('a\nb\n//# sourceMappingURL=typescript.js.map\n')).toBe('a\nb\n');
  });

  it('removes a trailing map line that has no final newline', () => {
    expect(strip('a\n//# sourceMappingURL=typescript.js.map')).toBe('a\n');
  });

  it('leaves the bytes unchanged when the last line is not a map line', () => {
    expect(strip('a\n//# sourceMappingURL=x.map\nb\n')).toBe('a\n//# sourceMappingURL=x.map\nb\n');
    expect(strip('a\nb')).toBe('a\nb');
    expect(strip('')).toBe('');
  });

  it('keeps every byte before the map line, multi-byte text included', () => {
    const body = 'const s = "é中";\n';
    expect(stripTrailingSourceMapLine(Buffer.from(`${body}//# sourceMappingURL=t.js.map\n`)).equals(Buffer.from(body))).toBe(true);
  });
});

describe('replaceIfChanged', () => {
  it('skips the write when the target already holds the same bytes', async () => {
    const io = memoryIo({ [TARGET]: 'same' });
    await expect(replaceIfChanged(TARGET, Buffer.from('same'), io)).resolves.toBe(false);
    expect(io.replaced).toEqual([]);
  });

  it('replaces a target holding different bytes', async () => {
    const io = memoryIo({ [TARGET]: 'old' });
    await expect(replaceIfChanged(TARGET, Buffer.from('new'), io)).resolves.toBe(true);
    expect(io.replaced).toEqual([TARGET]);
    expect(io.files.get(TARGET)).toBe('new');
  });

  it('writes a target that does not exist yet', async () => {
    const io = memoryIo();
    await expect(replaceIfChanged(TARGET, Buffer.from('new'), io)).resolves.toBe(true);
    expect(io.files.get(TARGET)).toBe('new');
  });
});
