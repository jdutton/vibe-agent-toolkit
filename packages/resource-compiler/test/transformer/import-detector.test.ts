/**
 * Tests for import detector
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion -- Test code uses non-null assertions after explicit checks */

import { describe, it, expect } from 'vitest';

import {
  isMarkdownImport,
  extractImportInfo,
  findMarkdownImports,
} from '../../src/transformer/import-detector.js';

import { createSourceFile, getFirstImport, getImportInfo } from './test-helpers.js';

describe('isMarkdownImport', () => {
  it('should detect .md imports', () => {
    const code = `import * as Core from './core.md';`;
    const sourceFile = createSourceFile(code);
    const importNode = getFirstImport(sourceFile);

    expect(importNode).toBeDefined();
    expect(isMarkdownImport(importNode!)).toBe(true);
  });

  it('should reject non-.md imports', () => {
    const code = `import { readFile } from 'node:fs';`;
    const sourceFile = createSourceFile(code);
    const importNode = getFirstImport(sourceFile);

    expect(importNode).toBeDefined();
    expect(isMarkdownImport(importNode!)).toBe(false);
  });

  it('should handle .ts imports', () => {
    const code = `import { foo } from './utils.ts';`;
    const sourceFile = createSourceFile(code);
    const importNode = getFirstImport(sourceFile);

    expect(importNode).toBeDefined();
    expect(isMarkdownImport(importNode!)).toBe(false);
  });

  it('should handle .js imports', () => {
    const code = `import foo from './module.js';`;
    const sourceFile = createSourceFile(code);
    const importNode = getFirstImport(sourceFile);

    expect(importNode).toBeDefined();
    expect(isMarkdownImport(importNode!)).toBe(false);
  });

  it('should handle relative .md paths', () => {
    const code = `import * as Doc from '../docs/readme.md';`;
    const sourceFile = createSourceFile(code);
    const importNode = getFirstImport(sourceFile);

    expect(importNode).toBeDefined();
    expect(isMarkdownImport(importNode!)).toBe(true);
  });

  it('should handle node_modules .md paths', () => {
    const code = `import * as Prompts from '@pkg/prompts/core.md';`;
    const sourceFile = createSourceFile(code);
    const importNode = getFirstImport(sourceFile);

    expect(importNode).toBeDefined();
    expect(isMarkdownImport(importNode!)).toBe(true);
  });
});

describe('extractImportInfo', () => {
  it('should extract namespace import info', () => {
    const info = getImportInfo(`import * as Core from './core.md';`, extractImportInfo);

    expect(info.identifier).toBe('Core');
    expect(info.modulePath).toBe('./core.md');
    expect(info.importType).toBe('namespace');
  });

  it('should extract default import info', () => {
    const info = getImportInfo(`import Core from './core.md';`, extractImportInfo);

    expect(info.identifier).toBe('Core');
    expect(info.modulePath).toBe('./core.md');
    expect(info.importType).toBe('default');
  });

  it('should extract named import info', () => {
    const info = getImportInfo(`import { myDoc } from './core.md';`, extractImportInfo);

    expect(info.identifier).toBe('myDoc');
    expect(info.modulePath).toBe('./core.md');
    expect(info.importType).toBe('named');
  });

  it('should return null for non-.md imports', () => {
    const code = `import { foo } from './utils.ts';`;
    const sourceFile = createSourceFile(code);
    const importNode = getFirstImport(sourceFile);

    expect(importNode).toBeDefined();

    const info = extractImportInfo(importNode!);

    expect(info).toBeNull();
  });

  it('should handle import with no bindings', () => {
    const code = `import './side-effect.md';`;
    const sourceFile = createSourceFile(code);
    const importNode = getFirstImport(sourceFile);

    expect(importNode).toBeDefined();

    const info = extractImportInfo(importNode!);

    // Side-effect imports have no identifier
    expect(info).toBeNull();
  });

  it('should extract different identifier names', () => {
    const info = getImportInfo(`import * as MyCustomName from './doc.md';`, extractImportInfo);

    expect(info.identifier).toBe('MyCustomName');
  });
});

describe('findMarkdownImports', () => {
  it('should find single markdown import', () => {
    const code = `import * as Core from './core.md';`;
    const sourceFile = createSourceFile(code);

    const imports = findMarkdownImports(sourceFile);

    expect(imports).toHaveLength(1);
    expect(imports[0]!.identifier).toBe('Core');
    expect(imports[0]!.modulePath).toBe('./core.md');
  });

  it('should find multiple markdown imports', () => {
    const code = `
      import * as Core from './core.md';
      import * as Shared from './shared.md';
      import { readFile } from 'node:fs';
      import * as Docs from '../docs/readme.md';
    `;
    const sourceFile = createSourceFile(code);

    const imports = findMarkdownImports(sourceFile);

    expect(imports).toHaveLength(3);
    expect(imports[0]!.identifier).toBe('Core');
    expect(imports[1]!.identifier).toBe('Shared');
    expect(imports[2]!.identifier).toBe('Docs');
  });

  it('should ignore non-.md imports', () => {
    const code = `
      import { readFile } from 'node:fs';
      import * as path from 'node:path';
      import { foo } from './utils.ts';
    `;
    const sourceFile = createSourceFile(code);

    const imports = findMarkdownImports(sourceFile);

    expect(imports).toHaveLength(0);
  });

  it('should handle files with no imports', () => {
    const code = `
      const x = 5;
      function foo() {
        return x;
      }
    `;
    const sourceFile = createSourceFile(code);

    const imports = findMarkdownImports(sourceFile);

    expect(imports).toHaveLength(0);
  });

  it('should handle mixed import types', () => {
    const code = `
      import * as NS from './namespace.md';
      import Default from './default.md';
      import { named } from './named.md';
    `;
    const sourceFile = createSourceFile(code);

    const imports = findMarkdownImports(sourceFile);

    expect(imports).toHaveLength(3);
    expect(imports[0]!.importType).toBe('namespace');
    expect(imports[1]!.importType).toBe('default');
    expect(imports[2]!.importType).toBe('named');
  });

  it('should preserve import order', () => {
    const code = `
      import * as Third from './third.md';
      import * as First from './first.md';
      import * as Second from './second.md';
    `;
    const sourceFile = createSourceFile(code);

    const imports = findMarkdownImports(sourceFile);

    expect(imports).toHaveLength(3);
    expect(imports[0]!.modulePath).toBe('./third.md');
    expect(imports[1]!.modulePath).toBe('./first.md');
    expect(imports[2]!.modulePath).toBe('./second.md');
  });
});
