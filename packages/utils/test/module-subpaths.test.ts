import { describe, expect, it } from 'vitest';

interface EslintPlugin {
  rules: Record<string, { create?: unknown } | undefined>;
  configs: { recommended: { rules: Record<string, string> } };
}

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

  /**
   * ONE root finder, everywhere — not one per entry.
   *
   * `findGitRoot` was a body-for-body alias: `export function findGitRoot(startDir)
   * { return gitFindRoot(startDir); }`. Keeping it off `./git` fixed the symptom
   * (adopters of the narrow entry could only find one name) while leaving the cause
   * in place: the `.` barrel — the entry with the most consumers — still offered
   * both, so the coin-flip just moved. Its own hiding place was the tell, too:
   * `findGitRoot` was one of the 22 symbols reachable ONLY from the wide barrel,
   * which is precisely the shape "import the one you need" is supposed to rule out.
   *
   * Under the pre-1.0 policy (CLAUDE.md: "DO NOT maintain old APIs alongside new
   * ones", "DO remove old code completely"), the alias is deleted rather than
   * relocated. No production code in this repo ever called it.
   */
  it('./git ships exactly one root finder, and the barrel agrees', async () => {
    const mod = await import('../src/git.js');
    expect('findGitRoot' in mod).toBe(false);
    expect('gitFindRoot' in mod).toBe(true);

    const barrel: Record<string, unknown> = await import('../src/index.js');
    expect('findGitRoot' in barrel).toBe(false);
    expect(typeof barrel['gitFindRoot']).toBe('function');
  });

  it('./crawl exposes directory crawling and the crawl-exclusion globs', async () => {
    const mod = await import('../src/crawl.js');
    expect(typeof mod.crawlDirectory).toBe('function');
    expect(typeof mod.crawlDirectorySync).toBe('function');
    expect(Array.isArray(mod.NEVER_CRAWL_GLOBS)).toBe(true);
    expect(Array.isArray(mod.BUILD_OUTPUT_GLOBS)).toBe(true);
  });

  /**
   * `./project` exists so these four are reachable WITHOUT the barrel.
   *
   * They were briefly barrel-only, which made a capability whose own code imports
   * nothing but `node:fs` and `node:path` cost five third-party packages to reach.
   * Both routes are asserted: the subpath, because that is the point, and the
   * barrel, because removing them from it would be a separate breaking change.
   */
  it('./project exposes project-root discovery, and the barrel still agrees', async () => {
    const mod = await import('../src/project.js');
    expect(typeof mod.findProjectRoot).toBe('function');
    expect(typeof mod.findConfigFile).toBe('function');
    expect(typeof mod.findNodeWorkspaceRoot).toBe('function');
    expect(typeof mod.resetProjectRootCaches).toBe('function');

    const barrel: Record<string, unknown> = await import('../src/index.js');
    expect(typeof barrel['findProjectRoot']).toBe('function');
    expect(typeof barrel['findConfigFile']).toBe('function');
    expect(typeof barrel['findNodeWorkspaceRoot']).toBe('function');
    expect(typeof barrel['resetProjectRootCaches']).toBe('function');
  });

  /**
   * `./text` exists so the one bytes-to-text seam can be reached without
   * `node:fs` — see `subpath-purity.test.ts` for the assertion that it stays
   * pure. The file-reading half is asserted on `./fs`, deliberately not here.
   */
  it('./text exposes the content-decoding seam, and only the pure half', async () => {
    const mod: Record<string, unknown> = await import('../src/text.js');
    expect(typeof mod['decodeTextContent']).toBe('function');
    expect('readTextContent' in mod).toBe(false);
    expect('readTextContentSync' in mod).toBe(false);
  });

  it('./fs exposes the file-reading half of the same seam', async () => {
    const mod = await import('../src/fs.js');
    expect(typeof mod.readTextContent).toBe('function');
    expect(typeof mod.readTextContentSync).toBe('function');
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

  /**
   * `./eslint` is the one subpath not compiled from `src/`, so it is imported here
   * the way an adopter's `eslint.config.js` does — through the exports map, by
   * specifier — rather than by relative source path like every case above. That
   * makes this the only test in the repo that would fail if the `./eslint` key
   * were dropped from the manifest while the files stayed put.
   *
   * Rule-by-rule coverage lives in `test/eslint/`; this asserts the entry exists
   * and has the shape ESLint requires of a plugin.
   */
  it('./eslint exposes the rule pack and its recommended config', async () => {
    const mod: unknown = await import('@vibe-agent-toolkit/utils/eslint');
    const plugin = (mod as { default: EslintPlugin }).default;
    expect(typeof plugin.rules['no-path-join']?.create).toBe('function');
    expect(plugin.configs.recommended.rules['@vibe-agent-toolkit/no-path-join']).toBe('warn');
  });
});
