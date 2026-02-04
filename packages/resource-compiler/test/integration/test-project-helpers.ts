/**
 * Shared helpers for setting up test projects in integration tests
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test file with controlled inputs */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseMarkdown } from '../../src/compiler/markdown-parser.js';
import { generateMarkdownDeclarationFile, getDeclarationPath } from '../../src/transformer/declaration-generator.js';

/**
 * Setup markdown files and their declarations in a project directory
 */
export function setupMarkdownFiles(
  resourcesDir: string,
  markdownFiles: Record<string, string>,
): void {
  for (const [mdFileName, content] of Object.entries(markdownFiles)) {
    const mdPath = join(resourcesDir, mdFileName);
    writeFileSync(mdPath, content, 'utf-8');

    // Generate and write declaration file
    const resource = parseMarkdown(content);
    const declaration = generateMarkdownDeclarationFile(mdPath, resource);
    const dtsPath = getDeclarationPath(mdPath);
    writeFileSync(dtsPath, declaration, 'utf-8');
  }
}

/**
 * Create a standard tsconfig.json for test projects
 */
export function createTsConfig(
  projectDir: string,
  options: { forceConsistentCasingInFileNames?: boolean } = {},
): void {
  const tsConfig = {
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: './dist',
      rootDir: './src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      ...(options.forceConsistentCasingInFileNames ? { forceConsistentCasingInFileNames: true } : {}),
    },
    include: ['src/**/*'],
  };
  writeFileSync(join(projectDir, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2), 'utf-8');
}
