import { describe, expect, it } from 'vitest';

describe('whole-module subpath entries', () => {
  it('./git exposes git root discovery, ls-files, ignore checking, and URL parsing', async () => {
    const mod = await import('../src/git.js');
    expect(typeof mod.gitFindRoot).toBe('function');
    expect(typeof mod.gitLsFiles).toBe('function');
    expect(typeof mod.isGitIgnored).toBe('function');
    expect(typeof mod.loadGitignoreRules).toBe('function');
    expect(typeof mod.GitTracker).toBe('function');
    expect(typeof mod.parseGitUrl).toBe('function');
    expect(typeof mod.isGitUrl).toBe('function');
    expect(typeof mod.nonInteractiveGitOverrides).toBe('function');
  });

  // Two names for one root finder guarantees half of adopters pick each. The
  // `./git` entry ships exactly one: `gitFindRoot`. The deprecated
  // `findGitRoot` alias stays reachable on the `.` barrel only.
  it('./git ships exactly one root finder — findGitRoot is not on it', async () => {
    const mod = await import('../src/git.js');
    expect('findGitRoot' in mod).toBe(false);
    expect('gitFindRoot' in mod).toBe(true);

    // Referenced by string, not by identifier: `findGitRoot` is deprecated and
    // a direct property access trips the deprecation lint.
    const barrel: Record<string, unknown> = await import('../src/index.js');
    expect(typeof barrel['findGitRoot']).toBe('function');
  });

  it('./crawl exposes directory crawling and the crawl-exclusion globs', async () => {
    const mod = await import('../src/crawl.js');
    expect(typeof mod.crawlDirectory).toBe('function');
    expect(typeof mod.crawlDirectorySync).toBe('function');
    expect(Array.isArray(mod.NEVER_CRAWL_GLOBS)).toBe(true);
    expect(Array.isArray(mod.BUILD_OUTPUT_GLOBS)).toBe(true);
  });

  it('./project exposes project-root discovery', async () => {
    const mod = await import('../src/project.js');
    expect(typeof mod.findProjectRoot).toBe('function');
  });

  it('./glob exposes the glob pattern helpers', async () => {
    const mod = await import('../src/glob.js');
    expect(typeof mod.isGlob).toBe('function');
  });

  it('./zod exposes version-agnostic Zod introspection', async () => {
    const mod = await import('../src/zod.js');
    expect(typeof mod.getZodTypeName).toBe('function');
    expect(mod.ZodTypeNames).toBeDefined();
  });

  it('./template exposes Handlebars rendering', async () => {
    const mod = await import('../src/template-entry.js');
    expect(typeof mod.renderTemplate).toBe('function');
  });

  it('./yaml exposes the surgical YAML updater', async () => {
    const mod = await import('../src/yaml.js');
    expect(typeof mod.updateYamlIn).toBe('function');
  });

  it('./testing exposes the temp-dir suite helpers', async () => {
    const mod = await import('../src/testing.js');
    expect(typeof mod.getTestOutputDir).toBe('function');
    expect(typeof mod.setupAsyncTempDirSuite).toBe('function');
    expect(typeof mod.setupSyncTempDirSuite).toBe('function');
  });

  it('./asset exposes asset reference resolution', async () => {
    const mod = await import('../src/asset.js');
    expect(typeof mod.resolveAssetReference).toBe('function');
  });
});
