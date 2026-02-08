/**
 * TypeScript transformer for markdown imports
 * Enables direct .md imports in TypeScript code
 */

export {
  isMarkdownImport,
  extractImportInfo,
  findMarkdownImports,
  type MarkdownImportInfo,
} from './import-detector.js';

export {
  resolveMarkdownPath,
  createDefaultCompilerOptions,
} from './path-resolver.js';

export {
  resourceToAst,
  createConstDeclaration,
} from './ast-helpers.js';

export {
  generateModuleReplacement,
  replaceImportWithConst,
} from './module-generator.js';

export {
  createTransformer,
  type TransformerOptions,
  default,
} from './transformer.js';

export {
  generateMarkdownDeclarationFile,
  getDeclarationPath,
} from './declaration-generator.js';
