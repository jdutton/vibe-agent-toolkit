import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { ContentTransformOptions, LinkRewriteRule, ResourceLookup } from '../src/content-transform.js';
import { transformContent } from '../src/content-transform.js';
import type { LinkType, ResourceLink, ResourceMetadata } from '../src/schemas/resource-metadata.js';

// ============================================================================
// Shared test constants
// ============================================================================

const LOCAL_FILE: LinkType = 'local_file';
const EXTERNAL: LinkType = 'external';
const ANCHOR: LinkType = 'anchor';
const GUIDE_HREF = './guide.md';
const GUIDE_ID = 'guide';
const GUIDE_TEXT = 'Guide';
const GUIDE_FILE_PATH = '/project/docs/guide.md';
const EMAIL: LinkType = 'email';
const LINK_TEXT_VAR = '{{link.text}}';
const BOLD_LINK_TEXT_TEMPLATE = '**{{link.text}}**';
const LINK_TEXT_HREF_TEMPLATE = '{{link.text}} ({{link.href}})';
const API_HREF = './api.md';
const API_FILE_PATH_SRC = '/project/src/api.md';
const API_FILE_PATH_DOCS = '/project/docs/api.md';
const GUIDE_TITLE = 'User Guide';
const GUIDE_ORIGINAL_LINK = 'See [Guide](./guide.md).';
const GOOGLE_URL = 'https://google.com';
const GUIDE_AND_API_CONTENT = 'See [Guide](./guide.md) and [API](./api.md).';
const GUIDE_AND_GOOGLE_CONTENT = 'See [Guide](./guide.md) and [Google](https://google.com).';
const LOCAL_LINK_TEXT_TEMPLATE = 'LOCAL:{{link.text}}';
const EXT_LINK_TEXT_TEMPLATE = 'EXT:{{link.text}}';
const RELATIVE_PATH_TEMPLATE = '{{link.resource.relativePath}}';
const REWRITE_LINK_TEMPLATE = '[{{link.text}}]({{link.resource.relativePath}})';
const SOURCE_FILE_PATH = '/project/src/index.md';
const GUIDE_RELATIVE_FROM_SRC = '../docs/guide.md';

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Create a minimal ResourceLink for testing.
 * Defaults to a local_file link; override any field as needed.
 */
function createTestLink(
  overrides: Partial<ResourceLink> & Pick<ResourceLink, 'text' | 'href'>,
): ResourceLink {
  return {
    type: LOCAL_FILE,
    ...overrides,
  };
}

/**
 * Create a minimal ResourceMetadata for registry lookup testing.
 */
function createTestResource(overrides: Partial<ResourceMetadata> & Pick<ResourceMetadata, 'id' | 'filePath'>): ResourceMetadata {
  return {
    id: overrides.id,
    filePath: overrides.filePath,
    links: overrides.links ?? [],
    headings: overrides.headings ?? [],
    sizeBytes: overrides.sizeBytes ?? 1024,
    estimatedTokenCount: overrides.estimatedTokenCount ?? 256,
    modifiedAt: overrides.modifiedAt ?? new Date('2025-01-01'),
    checksum: overrides.checksum ?? ('abc123def456abc123def456abc123def456abc123def456abc123def456abcd' as ResourceMetadata['checksum']),
    ...(overrides.frontmatter !== undefined && { frontmatter: overrides.frontmatter }),
    ...(overrides.collections !== undefined && { collections: overrides.collections }),
  };
}

/**
 * Create a simple ResourceLookup (mock registry) from an array of resources.
 */
function createTestRegistry(resources: ResourceMetadata[]): ResourceLookup {
  const byId = new Map<string, ResourceMetadata>();
  for (const resource of resources) {
    byId.set(resource.id, resource);
  }
  return {
    getResourceById: (id: string) => byId.get(id),
  };
}

/**
 * Create a LinkRewriteRule that matches by type.
 */
function createTypeRule(type: LinkType | LinkType[], template: string): LinkRewriteRule {
  return { match: { type }, template };
}

/**
 * Create a single-link test scenario: content containing one markdown link,
 * and the corresponding parsed links array.
 *
 * @param text - Link display text
 * @param href - Link href
 * @param resolvedId - Optional resolved resource ID
 * @param type - Link type (defaults to 'local_file')
 * @returns Object with `content` string and `links` array
 */
function createScenario(
  text: string,
  href: string,
  resolvedId?: string,
  type: LinkType = LOCAL_FILE,
): { content: string; links: ResourceLink[] } {
  return {
    content: `See [${text}](${href}).`,
    links: [createTestLink({ text, href, type, ...(resolvedId !== undefined && { resolvedId }) })],
  };
}

/**
 * Create a guide resource + registry + single-link scenario.
 * Reused across pattern-based matching, filePath template, and no-frontmatter tests.
 */
function createGuideScenarioWithRegistry() {
  const resource = createTestResource({ id: GUIDE_ID, filePath: GUIDE_FILE_PATH });
  const registry = createTestRegistry([resource]);
  const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF, GUIDE_ID);
  return { resource, registry, content, links };
}

/**
 * Create guide + API links array with the shared GUIDE_AND_API_CONTENT.
 */
function createGuideAndApiLinks(): { content: string; links: ResourceLink[] } {
  return {
    content: GUIDE_AND_API_CONTENT,
    links: [
      createTestLink({ text: GUIDE_TEXT, href: GUIDE_HREF, resolvedId: GUIDE_ID }),
      createTestLink({ text: 'API', href: API_HREF, resolvedId: 'api' }),
    ],
  };
}

/**
 * Create guide + API resources with registry, plus the shared links.
 * @param apiFilePath - File path for the API resource (varies between tests)
 */
function createGuideAndApiScenarioWithRegistry(apiFilePath: string) {
  const guideResource = createTestResource({ id: GUIDE_ID, filePath: GUIDE_FILE_PATH });
  const apiResource = createTestResource({ id: 'api', filePath: apiFilePath });
  const registry = createTestRegistry([guideResource, apiResource]);
  const { content, links } = createGuideAndApiLinks();
  return { guideResource, apiResource, registry, content, links };
}

/**
 * Create guide + Google (external) links scenario.
 */
function createGuideAndGoogleLinks(): { content: string; links: ResourceLink[] } {
  return {
    content: GUIDE_AND_GOOGLE_CONTENT,
    links: [
      createTestLink({ text: GUIDE_TEXT, href: GUIDE_HREF }),
      createTestLink({ text: 'Google', href: GOOGLE_URL, type: EXTERNAL }),
    ],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('transformContent', () => {
  describe('basic link rewriting with type match', () => {
    it('should rewrite local_file links matching a type rule', () => {
      const content = 'See [Guide](./guide.md) for details.';
      const links: ResourceLink[] = [
        createTestLink({ text: GUIDE_TEXT, href: GUIDE_HREF, resolvedId: GUIDE_ID }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, BOLD_LINK_TEXT_TEMPLATE)],
      });

      expect(result).toBe('See **Guide** for details.');
    });

    it('should rewrite external links matching a type rule', () => {
      const { content, links } = createScenario('Google', GOOGLE_URL, undefined, EXTERNAL);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(EXTERNAL, LINK_TEXT_HREF_TEMPLATE)],
      });

      expect(result).toBe('See Google (https://google.com).');
    });

    it('should match array of types', () => {
      const content = 'See [Guide](./guide.md) and [API](https://api.example.com).';
      const links: ResourceLink[] = [
        createTestLink({ text: GUIDE_TEXT, href: GUIDE_HREF }),
        createTestLink({ text: 'API', href: 'https://api.example.com', type: EXTERNAL }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule([LOCAL_FILE, EXTERNAL], LINK_TEXT_VAR)],
      });

      expect(result).toBe('See Guide and API.');
    });

    it('should not rewrite links when type does not match', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(EXTERNAL, LINK_TEXT_VAR)],
      });

      expect(result).toBe(GUIDE_ORIGINAL_LINK);
    });
  });

  describe('pattern-based matching (glob)', () => {
    it('should match links whose target resource matches a glob pattern', () => {
      const { registry, content, links } = createGuideScenarioWithRegistry();

      const result = transformContent(content, links, {
        linkRewriteRules: [{ match: { pattern: 'docs/**' }, template: 'DOC:{{link.resource.id}}' }],
        resourceRegistry: registry,
      });

      expect(result).toBe('See DOC:guide.');
    });

    it('should match links with array of patterns', () => {
      const resource = createTestResource({ id: 'api', filePath: '/project/src/api.md' });
      const registry = createTestRegistry([resource]);
      const { content, links } = createScenario('API', API_HREF, 'api');

      const result = transformContent(content, links, {
        linkRewriteRules: [{ match: { pattern: ['docs/**', 'src/**'] }, template: 'REF:{{link.resource.id}}' }],
        resourceRegistry: registry,
      });

      expect(result).toBe('See REF:api.');
    });

    it('should not match when link has no resolvedId (cannot look up resource for pattern)', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);
      // No resolvedId set

      const result = transformContent(content, links, {
        linkRewriteRules: [{ match: { pattern: 'docs/**' }, template: 'REPLACED' }],
      });

      expect(result).toBe(GUIDE_ORIGINAL_LINK);
    });

    it('should not match when resource is not found in registry', () => {
      const registry = createTestRegistry([]); // empty registry
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF, GUIDE_ID);

      const result = transformContent(content, links, {
        linkRewriteRules: [{ match: { pattern: 'docs/**' }, template: 'REPLACED' }],
        resourceRegistry: registry,
      });

      expect(result).toBe(GUIDE_ORIGINAL_LINK);
    });
  });

  describe('excludeResourceIds skipping', () => {
    it('should skip links whose resolvedId is in excludeResourceIds', () => {
      const { content, links } = createGuideAndApiLinks();
      const rules: LinkRewriteRule[] = [
        {
          match: { type: LOCAL_FILE, excludeResourceIds: [GUIDE_ID] },
          template: 'REWRITTEN:{{link.text}}',
        },
      ];

      const result = transformContent(content, links, { linkRewriteRules: rules });

      expect(result).toBe('See [Guide](./guide.md) and REWRITTEN:API.');
    });

    it('should not exclude links without a resolvedId', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);
      // No resolvedId - not excluded

      const result = transformContent(content, links, {
        linkRewriteRules: [{
          match: { type: LOCAL_FILE, excludeResourceIds: ['other'] },
          template: 'REWRITTEN',
        }],
      });

      expect(result).toBe('See REWRITTEN.');
    });
  });

  describe('fragment preservation and extraction', () => {
    it('should extract fragment from href and provide it in template context', () => {
      const content = 'See [API Section](./api.md#authentication) for auth.';
      const links: ResourceLink[] = [
        createTestLink({
          text: 'API Section',
          href: './api.md#authentication',
          resolvedId: 'api',
        }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, '{{link.text}} ({{link.href}}{{link.fragment}})')],
      });

      expect(result).toBe('See API Section (./api.md#authentication) for auth.');
    });

    it('should provide empty string for fragment when no anchor exists', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, '{{link.text}}{{link.fragment}}')],
      });

      expect(result).toBe('See Guide.');
    });

    it('should handle anchor-only links', () => {
      const { content, links } = createScenario('Section', '#my-section', undefined, ANCHOR);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(ANCHOR, '{{link.text}} (anchor: {{link.fragment}})')],
      });

      expect(result).toBe('See Section (anchor: #my-section).');
    });
  });

  describe('link.resource.* resolution from registry', () => {
    it('should populate resource fields in template context', () => {
      const resource = createTestResource({
        id: GUIDE_ID,
        filePath: GUIDE_FILE_PATH,
        sizeBytes: 2048,
        estimatedTokenCount: 512,
        frontmatter: { title: GUIDE_TITLE, category: 'docs' },
      });
      const registry = createTestRegistry([resource]);
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF, GUIDE_ID);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(
          LOCAL_FILE,
          '{{link.resource.id}} {{link.resource.fileName}} ({{link.resource.extension}}, {{link.resource.mimeType}}, {{link.resource.sizeBytes}} bytes, ~{{link.resource.estimatedTokenCount}} tokens)',
        )],
        resourceRegistry: registry,
      });

      expect(result).toBe('See guide guide.md (.md, text/markdown, 2048 bytes, ~512 tokens).');
    });

    it('should provide resource frontmatter fields in template', () => {
      const resource = createTestResource({
        id: GUIDE_ID,
        filePath: GUIDE_FILE_PATH,
        frontmatter: { title: 'My Guide', author: 'Alice' },
      });
      const registry = createTestRegistry([resource]);
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF, GUIDE_ID);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(
          LOCAL_FILE,
          '{{link.resource.frontmatter.title}} by {{link.resource.frontmatter.author}}',
        )],
        resourceRegistry: registry,
      });

      expect(result).toBe('See My Guide by Alice.');
    });

    it('should infer correct mimeType for various extensions', () => {
      const resources = [
        createTestResource({ id: 'ts-file', filePath: '/project/src/index.ts' }),
        createTestResource({ id: 'js-file', filePath: '/project/src/index.js' }),
        createTestResource({ id: 'json-file', filePath: '/project/config.json' }),
        createTestResource({ id: 'yaml-file', filePath: '/project/config.yaml' }),
        createTestResource({ id: 'yml-file', filePath: '/project/config.yml' }),
        createTestResource({ id: 'unknown-file', filePath: '/project/data.xyz' }),
      ];
      const registry = createTestRegistry(resources);

      const content = [
        '[TS](./index.ts)',
        '[JS](./index.js)',
        '[JSON](./config.json)',
        '[YAML](./config.yaml)',
        '[YML](./config.yml)',
        '[XYZ](./data.xyz)',
      ].join(' ');
      const links: ResourceLink[] = [
        createTestLink({ text: 'TS', href: './index.ts', resolvedId: 'ts-file' }),
        createTestLink({ text: 'JS', href: './index.js', resolvedId: 'js-file' }),
        createTestLink({ text: 'JSON', href: './config.json', resolvedId: 'json-file' }),
        createTestLink({ text: 'YAML', href: './config.yaml', resolvedId: 'yaml-file' }),
        createTestLink({ text: 'YML', href: './config.yml', resolvedId: 'yml-file' }),
        createTestLink({ text: 'XYZ', href: './data.xyz', resolvedId: 'unknown-file' }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, '{{link.resource.mimeType}}')],
        resourceRegistry: registry,
      });

      expect(result).toBe('text/typescript text/javascript application/json text/yaml text/yaml application/octet-stream');
    });

    it('should provide resource filePath in template', () => {
      const { registry, content, links } = createGuideScenarioWithRegistry();

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, '{{link.resource.filePath}}')],
        resourceRegistry: registry,
      });

      expect(result).toBe('See /project/docs/guide.md.');
    });
  });

  describe('edge cases', () => {
    it('should leave external links untouched when no rule matches', () => {
      const { content, links } = createScenario('Google', GOOGLE_URL, undefined, EXTERNAL);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'REWRITTEN')],
      });

      expect(result).toBe('See [Google](https://google.com).');
    });

    it('should handle anchor-only links that do not match any rule', () => {
      const { content, links } = createScenario('Section', '#overview', undefined, ANCHOR);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'REWRITTEN')],
      });

      expect(result).toBe('See [Section](#overview).');
    });

    it('should handle links with no registry provided', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF, GUIDE_ID);

      // No registry - link.resource.* fields will be undefined
      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, '{{link.text}} (id: {{link.resource.id}})')],
      });

      // Handlebars renders undefined as empty string
      expect(result).toBe('See Guide (id: ).');
    });

    it('should handle resource with no frontmatter', () => {
      const { registry, content, links } = createGuideScenarioWithRegistry();

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, '{{link.resource.id}}:{{link.resource.frontmatter.title}}')],
        resourceRegistry: registry,
      });

      // frontmatter is undefined, so frontmatter.title is empty
      expect(result).toBe('See guide:.');
    });

    it('should handle email links', () => {
      const { content, links } = createScenario('us', 'mailto:hello@example.com', undefined, EMAIL);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(EMAIL, '{{link.text}} at {{link.href}}')],
      });

      expect(result).toBe('See us at mailto:hello@example.com.');
    });

    it('should handle unknown link types', () => {
      const { content, links } = createScenario('Thing', 'ftp://example.com/file', undefined, 'unknown');

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule('unknown', '[UNKNOWN: {{link.text}}]')],
      });

      expect(result).toBe('See [UNKNOWN: Thing].');
    });

    it('should return content unchanged when links array is empty', () => {
      const content = 'No links here.';

      const result = transformContent(content, [], {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'REPLACED')],
      });

      expect(result).toBe('No links here.');
    });

    it('should return content unchanged when rules array is empty', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);

      const result = transformContent(content, links, { linkRewriteRules: [] });

      expect(result).toBe(GUIDE_ORIGINAL_LINK);
    });

    it('should handle content with no markdown links', () => {
      const content = 'Just plain text with no links at all.';

      const result = transformContent(content, [], {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'REPLACED')],
      });

      expect(result).toBe('Just plain text with no links at all.');
    });

    it('should handle link in content not present in links array (leave untouched)', () => {
      const content = 'See [Guide](./guide.md) and [Extra](./extra.md).';
      const links: ResourceLink[] = [
        // Only 'Guide' is in the parsed links
        createTestLink({ text: GUIDE_TEXT, href: GUIDE_HREF }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'REPLACED:{{link.text}}')],
      });

      // Guide is rewritten, Extra is left untouched because it's not in the links array
      expect(result).toBe('See REPLACED:Guide and [Extra](./extra.md).');
    });
  });

  describe('first-match-wins rule ordering', () => {
    it('should use the first matching rule when multiple rules match', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);
      const rules: LinkRewriteRule[] = [
        createTypeRule(LOCAL_FILE, 'FIRST:{{link.text}}'),
        createTypeRule(LOCAL_FILE, 'SECOND:{{link.text}}'),
      ];

      const result = transformContent(content, links, { linkRewriteRules: rules });

      expect(result).toBe('See FIRST:Guide.');
    });

    it('should fall through to later rules when earlier ones do not match', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);
      const rules: LinkRewriteRule[] = [
        createTypeRule(EXTERNAL, 'EXTERNAL:{{link.text}}'),
        createTypeRule(LOCAL_FILE, LOCAL_LINK_TEXT_TEMPLATE),
      ];

      const result = transformContent(content, links, { linkRewriteRules: rules });

      expect(result).toBe('See LOCAL:Guide.');
    });

    it('should use more specific rule before catch-all', () => {
      const { registry, content, links } = createGuideAndApiScenarioWithRegistry(API_FILE_PATH_SRC);
      const rules: LinkRewriteRule[] = [
        { match: { type: LOCAL_FILE, pattern: 'docs/**' }, template: 'DOC:{{link.text}}' },
        createTypeRule(LOCAL_FILE, 'OTHER:{{link.text}}'),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: rules,
        resourceRegistry: registry,
      });

      expect(result).toBe('See DOC:Guide and OTHER:API.');
    });
  });

  describe('consumer context variables in templates', () => {
    it('should merge consumer context into template rendering', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, '{{link.text}} (project: {{projectName}})')],
        context: { projectName: 'my-project' },
      });

      expect(result).toBe('See Guide (project: my-project).');
    });

    it('should provide nested context variables', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, '{{link.text}} (env: {{config.env}})')],
        context: { config: { env: 'production' } },
      });

      expect(result).toBe('See Guide (env: production).');
    });

    it('should not let context override link variables', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);

      // Context has a 'link' key - should be overridden by the actual link data
      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, LINK_TEXT_VAR)],
        context: { link: { text: 'OVERRIDDEN' } },
      });

      expect(result).toBe('See Guide.');
    });
  });

  describe('multiple links in same content', () => {
    it('should rewrite multiple links independently', () => {
      const content = 'See [Guide](./guide.md) and [API](./api.md) for reference.';
      const links: ResourceLink[] = [
        createTestLink({ text: GUIDE_TEXT, href: GUIDE_HREF, resolvedId: GUIDE_ID }),
        createTestLink({ text: 'API', href: API_HREF, resolvedId: 'api' }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, BOLD_LINK_TEXT_TEMPLATE)],
      });

      expect(result).toBe('See **Guide** and **API** for reference.');
    });

    it('should apply different rules to different links by type', () => {
      const { content, links } = createGuideAndGoogleLinks();
      const rules: LinkRewriteRule[] = [
        createTypeRule(LOCAL_FILE, LOCAL_LINK_TEXT_TEMPLATE),
        createTypeRule(EXTERNAL, EXT_LINK_TEXT_TEMPLATE),
      ];

      const result = transformContent(content, links, { linkRewriteRules: rules });

      expect(result).toBe('See LOCAL:Guide and EXT:Google.');
    });

    it('should handle duplicate links (same text+href appearing multiple times)', () => {
      const content = 'See [Guide](./guide.md) and later [Guide](./guide.md) again.';
      const links: ResourceLink[] = [
        createTestLink({ text: GUIDE_TEXT, href: GUIDE_HREF, line: 1 }),
        createTestLink({ text: GUIDE_TEXT, href: GUIDE_HREF, line: 3 }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, BOLD_LINK_TEXT_TEMPLATE)],
      });

      expect(result).toBe('See **Guide** and later **Guide** again.');
    });
  });

  describe('links matching no rule left untouched', () => {
    it('should leave all links untouched when no rules match', () => {
      const content = 'See [Guide](./guide.md) and [API](https://api.com).';
      const links: ResourceLink[] = [
        createTestLink({ text: GUIDE_TEXT, href: GUIDE_HREF }),
        createTestLink({ text: 'API', href: 'https://api.com', type: EXTERNAL }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(EMAIL, 'REWRITTEN')],
      });

      expect(result).toBe('See [Guide](./guide.md) and [API](https://api.com).');
    });

    it('should selectively rewrite only matching links', () => {
      const content = 'See [Guide](./guide.md), [API](https://api.com), and [Section](#overview).';
      const links: ResourceLink[] = [
        createTestLink({ text: GUIDE_TEXT, href: GUIDE_HREF }),
        createTestLink({ text: 'API', href: 'https://api.com', type: EXTERNAL }),
        createTestLink({ text: 'Section', href: '#overview', type: ANCHOR }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(EXTERNAL, EXT_LINK_TEXT_TEMPLATE)],
      });

      expect(result).toBe('See [Guide](./guide.md), EXT:API, and [Section](#overview).');
    });
  });

  describe('content with no links unchanged', () => {
    it('should return plain text unchanged', () => {
      const content = 'This is a simple paragraph with no links.';

      const result = transformContent(content, [], {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'REPLACED')],
      });

      expect(result).toBe('This is a simple paragraph with no links.');
    });

    it('should preserve multiline content without links', () => {
      const content = '# Title\n\nParagraph one.\n\nParagraph two.\n';

      const result = transformContent(content, [], {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'REPLACED')],
      });

      expect(result).toBe('# Title\n\nParagraph one.\n\nParagraph two.\n');
    });
  });

  describe('combined match criteria', () => {
    it('should require both type and pattern to match', () => {
      const { registry, content, links } = createGuideScenarioWithRegistry();

      // Type matches but pattern does not
      const result = transformContent(content, links, {
        linkRewriteRules: [{ match: { type: LOCAL_FILE, pattern: 'src/**' }, template: 'REPLACED' }],
        resourceRegistry: registry,
      });

      expect(result).toBe(GUIDE_ORIGINAL_LINK);
    });

    it('should match when both type and pattern match', () => {
      const { registry, content, links } = createGuideScenarioWithRegistry();

      const result = transformContent(content, links, {
        linkRewriteRules: [{ match: { type: LOCAL_FILE, pattern: 'docs/**' }, template: 'MATCHED:{{link.text}}' }],
        resourceRegistry: registry,
      });

      expect(result).toBe('See MATCHED:Guide.');
    });

    it('should apply type + pattern + excludeResourceIds together', () => {
      const { registry, content, links } = createGuideAndApiScenarioWithRegistry(API_FILE_PATH_DOCS);

      // Matches local_file in docs/**, but excludes 'guide'
      const result = transformContent(content, links, {
        linkRewriteRules: [{
          match: { type: LOCAL_FILE, pattern: 'docs/**', excludeResourceIds: [GUIDE_ID] },
          template: 'DOC:{{link.text}}',
        }],
        resourceRegistry: registry,
      });

      expect(result).toBe('See [Guide](./guide.md) and DOC:API.');
    });
  });

  describe('match with no type specified (wildcard type)', () => {
    it('should match any link type when type is omitted', () => {
      const { content, links } = createGuideAndGoogleLinks();

      const result = transformContent(content, links, {
        linkRewriteRules: [{ match: {}, template: 'ANY:{{link.text}}' }],
      });

      expect(result).toBe('See ANY:Guide and ANY:Google.');
    });
  });

  describe('real-world scenarios', () => {
    it('should rewrite local links to plain text references for RAG chunking', () => {
      const guideResource = createTestResource({
        id: 'user-guide',
        filePath: '/project/docs/user-guide.md',
        frontmatter: { title: GUIDE_TITLE },
      });
      const registry = createTestRegistry([guideResource]);

      const content = '# Getting Started\n\nRefer to [User Guide](./user-guide.md#setup) for setup instructions.\n';
      const links: ResourceLink[] = [
        createTestLink({
          text: GUIDE_TITLE,
          href: './user-guide.md#setup',
          resolvedId: 'user-guide',
        }),
      ];
      const rules: LinkRewriteRule[] = [
        createTypeRule(LOCAL_FILE, '{{link.text}} (see document: {{link.resource.frontmatter.title}}{{link.fragment}})'),
        createTypeRule(EXTERNAL, '[{{link.text}}]({{link.href}})'),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: rules,
        resourceRegistry: registry,
      });

      expect(result).toBe(
        '# Getting Started\n\nRefer to User Guide (see document: User Guide#setup) for setup instructions.\n'
      );
    });

    it('should handle mixed link types in a complex document', () => {
      const apiResource = createTestResource({
        id: 'api-reference',
        filePath: '/project/docs/api-reference.md',
        frontmatter: { title: 'API Reference' },
      });
      const registry = createTestRegistry([apiResource]);

      const content = [
        '# Overview',
        '',
        'See the [API Reference](./api-reference.md) for endpoint details.',
        'Visit [our website](https://example.com) for more info.',
        'Jump to [Configuration](#configuration) below.',
        'Contact [support](mailto:support@example.com).',
      ].join('\n');

      const links: ResourceLink[] = [
        createTestLink({ text: 'API Reference', href: './api-reference.md', resolvedId: 'api-reference' }),
        createTestLink({ text: 'our website', href: 'https://example.com', type: EXTERNAL }),
        createTestLink({ text: 'Configuration', href: '#configuration', type: ANCHOR }),
        createTestLink({ text: 'support', href: 'mailto:support@example.com', type: EMAIL }),
      ];

      const rules: LinkRewriteRule[] = [
        createTypeRule(LOCAL_FILE, '**{{link.text}}** (doc: {{link.resource.id}})'),
        createTypeRule(ANCHOR, BOLD_LINK_TEXT_TEMPLATE),
        // External and email links: no rule - left untouched
      ];

      const options: ContentTransformOptions = {
        linkRewriteRules: rules,
        resourceRegistry: registry,
      };

      const result = transformContent(content, links, options);

      const expected = [
        '# Overview',
        '',
        'See the **API Reference** (doc: api-reference) for endpoint details.',
        'Visit [our website](https://example.com) for more info.',
        'Jump to **Configuration** below.',
        'Contact [support](mailto:support@example.com).',
      ].join('\n');

      expect(result).toBe(expected);
    });
  });

  describe('sourceFilePath and link.resource.relativePath', () => {
    it('should compute relativePath from sourceFilePath to resource filePath', () => {
      const resource = createTestResource({ id: GUIDE_ID, filePath: GUIDE_FILE_PATH });
      const registry = createTestRegistry([resource]);
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF, GUIDE_ID);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, RELATIVE_PATH_TEMPLATE)],
        resourceRegistry: registry,
        sourceFilePath: SOURCE_FILE_PATH,
      });

      expect(result).toBe(`See ${toForwardSlash(GUIDE_RELATIVE_FROM_SRC)}.`);
    });

    it('should compute relativePath for same-directory resources', () => {
      const resource = createTestResource({ id: GUIDE_ID, filePath: GUIDE_FILE_PATH });
      const registry = createTestRegistry([resource]);
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF, GUIDE_ID);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, RELATIVE_PATH_TEMPLATE)],
        resourceRegistry: registry,
        sourceFilePath: '/project/docs/readme.md',
      });

      expect(result).toBe(`See ${toForwardSlash('guide.md')}.`);
    });

    it('should compute relativePath for deeply nested resources', () => {
      const resource = createTestResource({ id: 'deep', filePath: '/project/a/b/c/deep.md' });
      const registry = createTestRegistry([resource]);
      const { content, links } = createScenario('Deep', './deep.md', 'deep');

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, RELATIVE_PATH_TEMPLATE)],
        resourceRegistry: registry,
        sourceFilePath: '/project/x/y/source.md',
      });

      expect(result).toBe(`See ${toForwardSlash('../../a/b/c/deep.md')}.`);
    });

    it('should use forward slashes in relativePath for cross-platform compatibility', () => {
      // This test verifies that toForwardSlash is applied, which converts
      // backslashes (on Windows) to forward slashes
      const resource = createTestResource({ id: GUIDE_ID, filePath: '/project/docs/sub/guide.md' });
      const registry = createTestRegistry([resource]);
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF, GUIDE_ID);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, RELATIVE_PATH_TEMPLATE)],
        resourceRegistry: registry,
        sourceFilePath: SOURCE_FILE_PATH,
      });

      // The result must use forward slashes regardless of platform
      expect(result).not.toContain('\\');
      expect(result).toBe(`See ${toForwardSlash('../docs/sub/guide.md')}.`);
    });

    it('should leave relativePath undefined when sourceFilePath is not provided', () => {
      const { registry, content, links } = createGuideScenarioWithRegistry();

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'path:{{link.resource.relativePath}}')],
        resourceRegistry: registry,
        // No sourceFilePath
      });

      // Handlebars renders undefined as empty string
      expect(result).toBe('See path:.');
    });

    it('should leave relativePath undefined when resource is not resolved', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);
      // No resolvedId, no registry

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'path:{{link.resource.relativePath}}')],
        sourceFilePath: SOURCE_FILE_PATH,
      });

      // resource is undefined, so resource.relativePath is also undefined
      expect(result).toBe('See path:.');
    });

    it('should provide relativePath alongside other resource fields', () => {
      const resource = createTestResource({
        id: GUIDE_ID,
        filePath: GUIDE_FILE_PATH,
        frontmatter: { title: GUIDE_TITLE },
      });
      const registry = createTestRegistry([resource]);
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF, GUIDE_ID);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(
          LOCAL_FILE,
          '{{link.resource.frontmatter.title}} at {{link.resource.relativePath}}',
        )],
        resourceRegistry: registry,
        sourceFilePath: SOURCE_FILE_PATH,
      });

      expect(result).toBe(`See ${GUIDE_TITLE} at ${toForwardSlash(GUIDE_RELATIVE_FROM_SRC)}.`);
    });
  });

  describe('defaultTemplate for unmatched links', () => {
    it('should render unmatched links through defaultTemplate', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(EXTERNAL, EXT_LINK_TEXT_TEMPLATE)],
        defaultTemplate: '**{{link.text}}**',
      });

      // Guide is local_file, no external rule matches, so defaultTemplate applies
      expect(result).toBe('See **Guide**.');
    });

    it('should not apply defaultTemplate when a rule matches', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'MATCHED:{{link.text}}')],
        defaultTemplate: 'DEFAULT:{{link.text}}',
      });

      // The local_file rule matches, so defaultTemplate is NOT used
      expect(result).toBe('See MATCHED:Guide.');
    });

    it('should not apply defaultTemplate when not provided (backward compat)', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(EXTERNAL, EXT_LINK_TEXT_TEMPLATE)],
        // No defaultTemplate
      });

      // No rule matches, no defaultTemplate - original markdown preserved
      expect(result).toBe(GUIDE_ORIGINAL_LINK);
    });

    it('should apply defaultTemplate with resource context when available', () => {
      const { registry, content, links } = createGuideScenarioWithRegistry();

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(EXTERNAL, EXT_LINK_TEXT_TEMPLATE)],
        defaultTemplate: '{{link.text}} ({{link.resource.id}})',
        resourceRegistry: registry,
      });

      // No external rule matches, defaultTemplate renders with resource data
      expect(result).toBe('See Guide (guide).');
    });

    it('should apply defaultTemplate to some links and rules to others', () => {
      const { content, links } = createGuideAndGoogleLinks();

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, LOCAL_LINK_TEXT_TEMPLATE)],
        defaultTemplate: 'DEFAULT:{{link.text}}',
      });

      // Guide matches local_file rule, Google (external) falls through to defaultTemplate
      expect(result).toBe('See LOCAL:Guide and DEFAULT:Google.');
    });

    it('should work with defaultTemplate and no rules', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);

      const result = transformContent(content, links, {
        linkRewriteRules: [],
        defaultTemplate: 'FALLBACK:{{link.text}}',
      });

      // Empty rules, but defaultTemplate catches everything
      expect(result).toBe('See FALLBACK:Guide.');
    });

    it('should support defaultTemplate with sourceFilePath for relativePath', () => {
      const resource = createTestResource({ id: GUIDE_ID, filePath: GUIDE_FILE_PATH });
      const registry = createTestRegistry([resource]);
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF, GUIDE_ID);

      const result = transformContent(content, links, {
        linkRewriteRules: [],
        defaultTemplate: REWRITE_LINK_TEMPLATE,
        resourceRegistry: registry,
        sourceFilePath: SOURCE_FILE_PATH,
      });

      expect(result).toBe(`See [Guide](${toForwardSlash(GUIDE_RELATIVE_FROM_SRC)}).`);
    });
  });

  describe('reference-style definition rewriting', () => {
    const DEF_GUIDE_ID = 'guide';
    const DEF_GUIDE_HREF = './guide.md';
    const DEF_GUIDE_OUTPUT_PATH = '/output/resources/guide.md';
    const DEF_SOURCE_OUTPUT = '/output/SKILL.md';
    const DEF_EXPECTED_REL = 'resources/guide.md';

    function createDefinitionLink(
      ref: string,
      href: string,
      resolvedId?: string,
      type: LinkType = LOCAL_FILE,
    ): ResourceLink {
      return createTestLink({
        text: ref,
        href,
        type,
        nodeType: 'definition',
        ...(resolvedId !== undefined && { resolvedId }),
      });
    }

    it('should rewrite bundled definition to new relative path', () => {
      const content = `See [Guide][guide-ref] for details.\n\n[guide-ref]: ./guide.md`;
      const links: ResourceLink[] = [
        createTestLink({ text: 'Guide', href: 'guide-ref', type: 'unknown', nodeType: 'linkReference' }),
        createDefinitionLink('guide-ref', DEF_GUIDE_HREF, DEF_GUIDE_ID),
      ];

      const resource = createTestResource({ id: DEF_GUIDE_ID, filePath: DEF_GUIDE_OUTPUT_PATH });
      const registry = createTestRegistry([resource]);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, REWRITE_LINK_TEMPLATE)],
        resourceRegistry: registry,
        sourceFilePath: DEF_SOURCE_OUTPUT,
      });

      expect(result).toContain(`[guide-ref]: ${DEF_EXPECTED_REL}`);
    });

    it('should preserve definition fragment when rewriting', () => {
      const content = `[guide-ref]: ./guide.md#getting-started`;
      const links: ResourceLink[] = [
        createDefinitionLink('guide-ref', './guide.md#getting-started', DEF_GUIDE_ID),
      ];

      const resource = createTestResource({ id: DEF_GUIDE_ID, filePath: DEF_GUIDE_OUTPUT_PATH });
      const registry = createTestRegistry([resource]);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, REWRITE_LINK_TEMPLATE)],
        resourceRegistry: registry,
        sourceFilePath: DEF_SOURCE_OUTPUT,
      });

      expect(result).toBe(`[guide-ref]: ${DEF_EXPECTED_REL}#getting-started`);
    });

    it('should remove excluded definition (orphaned after inline link stripped)', () => {
      const content = `Some text.\n\n[excluded-ref]: ./excluded.md`;
      const links: ResourceLink[] = [
        createDefinitionLink('excluded-ref', './excluded.md', undefined, LOCAL_FILE),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, LINK_TEXT_VAR)],
      });

      // Definition line should be removed (no resource in registry)
      expect(result).not.toContain('[excluded-ref]');
      // Should not have triple newlines
      expect(result).not.toMatch(/\n{3,}/);
    });

    it('should leave external definition untouched', () => {
      const content = `[ext-ref]: https://example.com`;
      const links: ResourceLink[] = [
        createDefinitionLink('ext-ref', 'https://example.com', undefined, EXTERNAL),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, LINK_TEXT_VAR)],
      });

      expect(result).toBe(`[ext-ref]: https://example.com`);
    });

    it('should handle mixed inline and definition links together', () => {
      const content = `See [Guide](./guide.md) and [API Ref][api-ref].\n\n[api-ref]: ./api.md`;

      const apiOutputPath = '/output/resources/api.md';
      const links: ResourceLink[] = [
        createTestLink({ text: GUIDE_TEXT, href: DEF_GUIDE_HREF, resolvedId: DEF_GUIDE_ID, nodeType: 'link' }),
        createTestLink({ text: 'API Ref', href: 'api-ref', type: 'unknown', nodeType: 'linkReference' }),
        createDefinitionLink('api-ref', './api.md', 'api'),
      ];

      const guideResource = createTestResource({ id: DEF_GUIDE_ID, filePath: DEF_GUIDE_OUTPUT_PATH });
      const apiResource = createTestResource({ id: 'api', filePath: apiOutputPath });
      const registry = createTestRegistry([guideResource, apiResource]);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, REWRITE_LINK_TEMPLATE)],
        resourceRegistry: registry,
        sourceFilePath: DEF_SOURCE_OUTPUT,
      });

      expect(result).toContain(`[Guide](${DEF_EXPECTED_REL})`);
      expect(result).toContain(`[api-ref]: resources/api.md`);
    });

    it('should not rewrite definitions when no nodeType is set (backward compat)', () => {
      const content = `[ref]: ./guide.md`;
      // Old-style link without nodeType — should be skipped by definition pass
      const links: ResourceLink[] = [
        createTestLink({ text: 'ref', href: DEF_GUIDE_HREF, resolvedId: DEF_GUIDE_ID }),
      ];

      const resource = createTestResource({ id: DEF_GUIDE_ID, filePath: DEF_GUIDE_OUTPUT_PATH });
      const registry = createTestRegistry([resource]);

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, REWRITE_LINK_TEMPLATE)],
        resourceRegistry: registry,
        sourceFilePath: DEF_SOURCE_OUTPUT,
      });

      // Without nodeType: 'definition', the link is NOT matched by definition pass
      expect(result).toBe(`[ref]: ./guide.md`);
    });
  });
});
