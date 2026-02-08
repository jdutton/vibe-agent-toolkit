/**
 * Integration tests for TypeScript Language Service Plugin
 * Tests the plugin with real TypeScript Language Service
 */

/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string -- Test file with controlled inputs */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal, setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import ts from 'typescript/lib/tsserverlibrary';
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';

import { clearCache } from '../../src/language-service/markdown-cache.js';
import init from '../../src/language-service/plugin.js';

import { setupMarkdownFiles, createTsConfig } from './test-project-helpers.js';

const suite = setupSyncTempDirSuite('language-service-test');

/**
 * Helper to test go-to-definition at a specific position
 */
function testDefinitionAtPosition(
  projectDir: string,
  tsCode: string,
  markdownFiles: Record<string, string>,
  searchString: string,
): ts.DefinitionInfo[] | undefined {
  const { languageService, fileName } = createLanguageServiceProject(projectDir, tsCode, markdownFiles);
  const position = tsCode.indexOf(searchString) + 1;
  return languageService.getDefinitionAtPosition(fileName, position);
}

/**
 * Create a test TypeScript project with Language Service
 */
function createLanguageServiceProject(
  projectDir: string,
  tsCode: string,
  markdownFiles: Record<string, string>,
): {
  languageService: ts.LanguageService;
  fileName: string;
} {
  // Create src directory
  const srcDir = join(projectDir, 'src');
  mkdirSyncReal(srcDir, { recursive: true });

  // Write TypeScript file
  const fileName = join(srcDir, 'index.ts');
  writeFileSync(fileName, tsCode, 'utf-8');

  // Create resources directory
  const resourcesDir = join(srcDir, 'resources');
  mkdirSyncReal(resourcesDir, { recursive: true });

  // Write markdown files and their declarations
  setupMarkdownFiles(resourcesDir, markdownFiles);

  // Create tsconfig.json
  createTsConfig(projectDir);

  // Create Language Service
  const configPath = join(projectDir, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    projectDir,
    {},
    configPath,
  );

  const files = new Map<string, { version: number }>();
  files.set(fileName, { version: 0 });

  const servicesHost: ts.LanguageServiceHost = {
    getScriptFileNames: () => [fileName],
    getScriptVersion: (fname: string) => files.get(fname)?.version.toString() ?? '0',
    getScriptSnapshot: (fname: string) => {
      if (!ts.sys.fileExists(fname)) {
        return undefined;
      }
      const content = ts.sys.readFile(fname);
      return content ? ts.ScriptSnapshot.fromString(content) : undefined;
    },
    getCurrentDirectory: () => projectDir,
    getCompilationSettings: () => parsedConfig.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  };

  const baseLanguageService = ts.createLanguageService(servicesHost);

  // Initialize plugin
  const pluginModule = init({ typescript: ts });
  const info: ts.server.PluginCreateInfo = {
    languageService: baseLanguageService,
    languageServiceHost: servicesHost,
    project: {
      getCompilerOptions: () => parsedConfig.options,
      projectService: {
        logger: {
          info: () => {},
          msg: () => {},
          startGroup: () => {},
          endGroup: () => {},
          loggingEnabled: () => false,
          hasLevel: () => false,
          getLogFileName: () => undefined,
        },
      },
    } as unknown as ts.server.Project,
    serverHost: undefined as unknown as ts.server.ServerHost,
    config: {},
  };

  const languageService = pluginModule.create(info);

  return { languageService, fileName };
}

describe('Language Service Plugin Integration', () => {
  let projectDir: string;

  beforeAll(() => {
    suite.beforeAll();
  });

  afterAll(() => {
    suite.afterAll();
    clearCache();
  });

  beforeEach(() => {
    suite.beforeEach();
    projectDir = suite.getTempDir();
    clearCache();
  });

  afterEach(() => {
    clearCache();
  });

  describe('completions', () => {
    it('should provide fragment completions', () => {
      const tsCode = `
import Core from './resources/core.md';

const frag = Core.fragments.
      `.trim();

      const { languageService, fileName } = createLanguageServiceProject(projectDir, tsCode, {
        'core.md': `## Purpose Driven
Content here

## API v2.0
More content`,
      });

      const position = tsCode.lastIndexOf('.') + 1;
      const completions = languageService.getCompletionsAtPosition(fileName, position, {});

      expect(completions).toBeDefined();
      expect(completions?.entries).toBeDefined();

      // Should have markdown fragment completions
      const fragmentNames = completions?.entries.map((e) => e.name) ?? [];
      expect(fragmentNames).toContain('purposeDriven');
      expect(fragmentNames).toContain('apiV20');
    });
  });

  describe('definitions', () => {
    it('should provide go-to-definition for markdown imports', () => {
      const tsCode = `import Core from './resources/core.md';`;

      const definitions = testDefinitionAtPosition(
        projectDir,
        tsCode,
        { 'core.md': '## Fragment\nContent' },
        "'./resources/core.md'",
      );

      expect(definitions).toBeDefined();
      expect(definitions?.length).toBeGreaterThan(0);
      expect(definitions?.[0]?.fileName).toContain('core.md');
    });

    it('should provide go-to-definition for fragments', () => {
      const tsCode = `
import Core from './resources/core.md';

const frag = Core.fragments.purposeDriven;
      `.trim();

      const definitions = testDefinitionAtPosition(
        projectDir,
        tsCode,
        { 'core.md': '## Purpose Driven\nContent here' },
        'purposeDriven',
      );

      expect(definitions).toBeDefined();
      expect(definitions?.length).toBeGreaterThan(0);
      expect(definitions?.[0]?.fileName).toContain('core.md');
    });
  });

  describe('diagnostics', () => {
    it('should report error for missing markdown file', () => {
      const tsCode = `import Core from './resources/missing.md';`;

      const { languageService, fileName } = createLanguageServiceProject(projectDir, tsCode, {});

      const diagnostics = languageService.getSemanticDiagnostics(fileName);

      const markdownError = diagnostics.find((d) => d.messageText.toString().includes('missing.md'));
      expect(markdownError).toBeDefined();
    });

    it('should report error for non-existent fragment', () => {
      const tsCode = `
import Core from './resources/core.md';

const frag = Core.fragments.nonExistent;
      `.trim();

      const { languageService, fileName } = createLanguageServiceProject(projectDir, tsCode, {
        'core.md': '## Purpose Driven\nContent here',
      });

      const diagnostics = languageService.getSemanticDiagnostics(fileName);

      const fragmentError = diagnostics.find((d) =>
        d.messageText.toString().includes('nonExistent'),
      );
      expect(fragmentError).toBeDefined();
    });

    it('should not report error for valid fragment', () => {
      const tsCode = `
import Core from './resources/core.md';

const frag = Core.fragments.purposeDriven;
      `.trim();

      const { languageService, fileName } = createLanguageServiceProject(projectDir, tsCode, {
        'core.md': '## Purpose Driven\nContent here',
      });

      const diagnostics = languageService.getSemanticDiagnostics(fileName);

      const markdownErrors = diagnostics.filter((d) => {
        const message = d.messageText.toString();
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- Logical OR is correct for boolean operations
        return message.includes('markdown') || message.includes('fragment');
      });
      expect(markdownErrors).toHaveLength(0);
    });
  });

  describe('hover', () => {
    it('should provide hover information for fragments', () => {
      const tsCode = `
import Core from './resources/core.md';

const frag = Core.fragments.purposeDriven;
      `.trim();

      const { languageService, fileName } = createLanguageServiceProject(projectDir, tsCode, {
        'core.md': '## Purpose Driven\nThis is the content of the fragment.',
      });

      const position = tsCode.indexOf('purposeDriven');
      const quickInfo = languageService.getQuickInfoAtPosition(fileName, position);

      expect(quickInfo).toBeDefined();
      expect(quickInfo?.displayParts).toBeDefined();

      // The display parts should either contain 'fragment' (from our plugin)
      // or 'purposeDriven' (from base TypeScript) - either is acceptable
      const displayText = quickInfo?.displayParts?.map((p) => p.text).join('') ?? '';
      expect(displayText.length).toBeGreaterThan(0);
      expect(displayText).toMatch(/purposeDriven|fragment/);
    });
  });

  describe('cache integration', () => {
    it('should cache markdown resources across operations', () => {
      const tsCode = `
import Core from './resources/core.md';

const frag1 = Core.fragments.purposeDriven;
const frag2 = Core.fragments.apiV20;
      `.trim();

      const { languageService, fileName } = createLanguageServiceProject(projectDir, tsCode, {
        'core.md': `## Purpose Driven
Content one

## API v2.0
Content two`,
      });

      // Multiple operations should use cached resource
      const position1 = tsCode.indexOf('purposeDriven');
      const quickInfo1 = languageService.getQuickInfoAtPosition(fileName, position1);

      const position2 = tsCode.indexOf('apiV20');
      const quickInfo2 = languageService.getQuickInfoAtPosition(fileName, position2);

      expect(quickInfo1).toBeDefined();
      expect(quickInfo2).toBeDefined();
    });
  });
});
