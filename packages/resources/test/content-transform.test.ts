import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { ContentTransformOptions, LinkRewriteRule, ResourceLookup } from '../src/content-transform.js';
import { transformContent } from '../src/content-transform.js';
import { parseMarkdownContent } from '../src/link-parser.js';
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

// Common content/template constants for rawText + formatted-text tests
const CODE_LINK_CONTENT = 'See [`guide.md`](./guide.md).';
const EMPHASIS_LINK_CONTENT = 'See [**Guide**](./guide.md) and [_details_](./details.md).';
const PASSTHROUGH_LINK_TEMPLATE = '[{{link.rawText}}]({{link.href}})';

/**
 * Built from code points, never typed as an escape.
 *
 * A `\r` typed into a fixture is invisible in review and turns the file binary to
 * `grep`; `.claude/rules/tests-that-prove-nothing.md` records this repository
 * having been bitten by it inside a comment warning about it.
 */
const CR = String.fromCodePoint(0x0d);
const LF = String.fromCodePoint(0x0a);
const CRLF = `${CR}${LF}`;
/** A backtick, built from its code point so the fixtures below stay greppable. */
const TICK = String.fromCodePoint(0x60);

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
 * A `[ref]: href` definition carrying the span the parser would give it.
 *
 * The definition pass splices at `startOffset`/`endOffset`, as pass 1 does, so a
 * fixture has to locate the definition in `content` the way mdast would: the whole
 * `[ref]: href` construct, line ending excluded. `text` is the NORMALISED
 * identifier (lower-cased), which is what `remark-parser` puts there.
 *
 * @param content - The document the definition sits in
 * @param ref - The label as written in `content`
 * @param href - The destination as written in `content`
 * @param resolvedId - Optional resolved resource ID
 * @param type - Link type (defaults to 'local_file')
 * @returns The definition link, located in `content`
 */
function createDefinitionLink(
  content: string,
  ref: string,
  href: string,
  resolvedId?: string,
  type: LinkType = LOCAL_FILE,
): ResourceLink {
  const startOffset = content.indexOf(`[${ref}]:`);
  if (startOffset === -1) throw new Error(`fixture has no definition for ${ref}`);
  const lineEnd = content.indexOf(LF, startOffset);
  const rawEnd = lineEnd === -1 ? content.length : lineEnd;
  const endOffset = content.charAt(rawEnd - 1) === CR ? rawEnd - 1 : rawEnd;
  return createTestLink({
    text: ref.toLowerCase(),
    href,
    type,
    nodeType: 'definition',
    startOffset,
    endOffset,
    ...(resolvedId !== undefined && { resolvedId }),
  });
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

    it('should rewrite links whose text contains inline code formatting', () => {
      // The markdown parser strips backticks from link text (remark produces
      // `text: "guide.md"` for `[\`guide.md\`](...)`), but the regex that
      // rewrites inline links captures the raw source including backticks.
      // The lookup must still succeed so authors can safely code-format paths.
      const content = 'See [`guide.md`](./guide.md) for details.';
      const links: ResourceLink[] = [
        createTestLink({ text: 'guide.md', href: GUIDE_HREF, resolvedId: GUIDE_ID }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'REWRITTEN:{{link.href}}')],
      });

      expect(result).toBe('See REWRITTEN:./guide.md for details.');
    });

    it('should rewrite links whose text contains emphasis formatting', () => {
      const content = 'See [**Guide**](./guide.md) and [_details_](./details.md).';
      const links: ResourceLink[] = [
        createTestLink({ text: 'Guide', href: GUIDE_HREF }),
        createTestLink({ text: 'details', href: './details.md' }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'REWRITTEN:{{link.href}}')],
      });

      expect(result).toBe('See REWRITTEN:./guide.md and REWRITTEN:./details.md.');
    });

    it('should expose raw (formatted) link text via link.rawText for inline code', () => {
      // Authors often write `[`path.yaml`](path.yaml)` to render the path as
      // inline code. The bundled-link rewrite must preserve the backticks so
      // the packaged output still renders as a code-styled link.
      const links: ResourceLink[] = [
        createTestLink({ text: 'guide.md', href: GUIDE_HREF }),
      ];

      const result = transformContent(CODE_LINK_CONTENT, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, PASSTHROUGH_LINK_TEMPLATE)],
      });

      expect(result).toBe(CODE_LINK_CONTENT);
    });

    it('should expose raw text with emphasis formatting via link.rawText', () => {
      const links: ResourceLink[] = [
        createTestLink({ text: 'Guide', href: GUIDE_HREF }),
        createTestLink({ text: 'details', href: './details.md' }),
      ];

      const result = transformContent(EMPHASIS_LINK_CONTENT, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, PASSTHROUGH_LINK_TEMPLATE)],
      });

      expect(result).toBe(EMPHASIS_LINK_CONTENT);
    });

    it('should expose link.rawText equal to link.text for plain links', () => {
      const content = 'See [Guide](./guide.md).';
      const links: ResourceLink[] = [
        createTestLink({ text: GUIDE_TEXT, href: GUIDE_HREF }),
      ];

      const result = transformContent(content, links, {
        // Render both fields and confirm they're the same for a plain link
        linkRewriteRules: [createTypeRule(LOCAL_FILE, '{{link.text}}|{{link.rawText}}')],
      });

      expect(result).toBe('See Guide|Guide.');
    });

    it('should keep link.text stripped of formatting (backward compat)', () => {
      // Users with existing templates referencing {{link.text}} must continue
      // to receive plain (rendered) text, not raw markdown.
      const links: ResourceLink[] = [
        createTestLink({ text: 'guide.md', href: GUIDE_HREF }),
      ];

      const result = transformContent(CODE_LINK_CONTENT, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, 'Search KB for {{link.text}}')],
      });

      expect(result).toBe('See Search KB for guide.md.');
    });

    it('should preserve raw text when the link is nested inside outer formatting', () => {
      // The inline regex matches the inner [text](href); outer formatting
      // surrounds it in the content but is irrelevant to link capture.
      const content = 'Bold link: **[`foo.yaml`](./foo.yaml)**.';
      const links: ResourceLink[] = [
        createTestLink({ text: 'foo.yaml', href: './foo.yaml' }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [createTypeRule(LOCAL_FILE, PASSTHROUGH_LINK_TEMPLATE)],
      });

      expect(result).toBe(content);
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

    it('should not match when link has no resolvedId and pattern does not match the href', () => {
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF);
      // No resolvedId set and `docs/**` does not match `./guide.md`

      const result = transformContent(content, links, {
        linkRewriteRules: [{ match: { pattern: 'docs/**' }, template: 'REPLACED' }],
      });

      expect(result).toBe(GUIDE_ORIGINAL_LINK);
    });

    it('should not match when resource is not found in registry and pattern does not match the href', () => {
      const registry = createTestRegistry([]); // empty registry
      const { content, links } = createScenario(GUIDE_TEXT, GUIDE_HREF, GUIDE_ID);

      const result = transformContent(content, links, {
        linkRewriteRules: [{ match: { pattern: 'docs/**' }, template: 'REPLACED' }],
        resourceRegistry: registry,
      });

      expect(result).toBe(GUIDE_ORIGINAL_LINK);
    });

    it('should fall back to matching pattern against href when link has no resolvedId', () => {
      // Simulates a terminal (non-markdown) link that was never indexed.
      const content = 'Roster: [IT](../../../data/teams/it.yaml).';
      const links: ResourceLink[] = [
        createTestLink({ text: 'IT', href: '../../../data/teams/it.yaml' }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [{
          match: { type: LOCAL_FILE, pattern: '**/data/teams/**' },
          template: 'Search KB for {{link.text}}',
        }],
      });

      expect(result).toBe('Roster: Search KB for IT.');
    });

    it('should fall back to href matching even when an anchor fragment is present', () => {
      const content = 'See [schema](./config.yaml#section).';
      const links: ResourceLink[] = [
        createTestLink({ text: 'schema', href: './config.yaml#section' }),
      ];

      const result = transformContent(content, links, {
        linkRewriteRules: [{
          match: { type: LOCAL_FILE, pattern: '**/*.yaml' },
          template: '[STRIPPED: {{link.text}}]',
        }],
      });

      expect(result).toBe('See [STRIPPED: schema].');
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

    it('should rewrite bundled definition to new relative path', () => {
      const content = `See [Guide][guide-ref] for details.\n\n[guide-ref]: ./guide.md`;
      const links: ResourceLink[] = [
        createTestLink({ text: 'Guide', href: 'guide-ref', type: 'unknown', nodeType: 'linkReference' }),
        createDefinitionLink(content, 'guide-ref', DEF_GUIDE_HREF, DEF_GUIDE_ID),
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
        createDefinitionLink(content, 'guide-ref', './guide.md#getting-started', DEF_GUIDE_ID),
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
        createDefinitionLink(content, 'excluded-ref', './excluded.md', undefined, LOCAL_FILE),
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
        createDefinitionLink(content, 'ext-ref', 'https://example.com', undefined, EXTERNAL),
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
        createDefinitionLink(content, 'api-ref', './api.md', 'api'),
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

/** The packager's own strip template, which re-emits only the link text. */
const STRIP_TEMPLATE = '{{link.rawText}}';
/** One href shared by a link and an image, which is what makes the replay reach the image. */
const SHARED_IMG_HREF = 'evals/diagram.png';

/**
 * A link and an image sharing one href, with the link's real span.
 *
 * @param destination - What the link's span actually contains
 * @returns The content and the link carrying offsets into it
 */
function neighbourFixture(destination: string): { content: string; links: ResourceLink[] } {
  const content = `Spec: [Diagram spec](${destination})\nImage: ![diagram](${SHARED_IMG_HREF})`;
  const start = content.indexOf('[Diagram');
  const end = content.indexOf(')', start) + 1;
  return {
    content,
    links: [createTestLink({
      text: 'Diagram spec', href: SHARED_IMG_HREF, startOffset: start, endOffset: end,
    })],
  };
}

describe('a link this refuses to re-emit must not disturb its NEIGHBOURS', () => {
  it('leaves the whole document alone when the destination carries a title', () => {
    // 🚨 The regression this pins. The destination guard was added so a titled
    // link would decline instead of losing its title — but declining put it in
    // `fallbackByHref`, which turned the href-keyed regex replay back on. The
    // replay then matched the IMAGE, whose href is the same, and rewrote it
    // through the strip template: `![diagram](evals/diagram.png)` became
    // `!diagram` — the image destroyed and the bang orphaned, which is exactly
    // the defect this file's sibling probe test is named for. The link itself
    // was left unrewritten either way, so the guard's only observable effect
    // was to damage a neighbour.
    const { content, links } = neighbourFixture(`${SHARED_IMG_HREF} "Spec"`);

    const result = transformContent(content, links, {
      linkRewriteRules: [createTypeRule(LOCAL_FILE, STRIP_TEMPLATE)],
    });

    expect(result).toBe(content);
  });

  it('still splices, and still spares the image, when the destination is bare', () => {
    // The positive control. Without it the assertion above would also pass if
    // the splice path had simply stopped working altogether.
    const { content, links } = neighbourFixture(SHARED_IMG_HREF);

    const result = transformContent(content, links, {
      linkRewriteRules: [createTypeRule(LOCAL_FILE, STRIP_TEMPLATE)],
    });

    expect(result).toBe(`Spec: Diagram spec\nImage: ![diagram](${SHARED_IMG_HREF})`);
  });

  it('splices a destination padded with whitespace, which is legal CommonMark', () => {
    // `renderLink` reproduces this destination exactly, so refusing it would
    // cost a correct rewrite for nothing.
    const { content, links } = neighbourFixture(` ${SHARED_IMG_HREF} `);

    const result = transformContent(content, links, {
      linkRewriteRules: [createTypeRule(LOCAL_FILE, STRIP_TEMPLATE)],
    });

    expect(result).toBe(`Spec: Diagram spec\nImage: ![diagram](${SHARED_IMG_HREF})`);
  });
});

describe('stray unpaired "[" in prose', () => {
  it('does not swallow the text between a stray "[" and the next real link', () => {
    // A sentence listing glob metacharacters ends up with an unpaired `[` inside
    // inline code. With a link-text class that excluded only `]`, the regex started
    // matching AT that stray bracket and ran forward to the NEXT link's `](`,
    // capturing every character in between as "link text". Any template that does
    // not re-emit that text verbatim then DELETED the intervening prose from the
    // rewritten file — silently, and only in files that happen to contain a `[`.
    const content = 'A glob may use (`*`, `**`, `?`, `[`) — see [guide](./guide.md) for details.';
    const links = [createTestLink({ text: 'guide', href: GUIDE_HREF })];

    const result = transformContent(content, links, {
      linkRewriteRules: [createTypeRule(LOCAL_FILE, LINK_TEXT_VAR)],
    });

    // Only the genuine link is replaced; every other character survives.
    expect(result).toBe('A glob may use (`*`, `**`, `?`, `[`) — see guide for details.');
  });
});

/** An external href, so an autolink over it is a construct CommonMark really produces. */
const AUTOLINK_HREF = 'https://example.com/d.png';

/**
 * A construct the parser LOCATED but `MARKDOWN_LINK_REGEX` cannot express, an
 * inline link, and an image — the construct and the image sharing one href.
 *
 * The construct carries a real span, so the parser found it; it simply is not an
 * inline `[...](...)`. The `[Guide]` link is the positive control that keeps the
 * assertions below from passing merely because the whole pass stopped working.
 *
 * @param construct - The located non-inline construct, verbatim
 * @param href - The href it and the image share
 * @param overrides - Fields distinguishing the construct's kind (nodeType, type)
 */
function locatedNonInlineFixture(
  construct: string,
  href: string,
  overrides: Partial<ResourceLink>,
): { content: string; links: ResourceLink[] } {
  const content =
    `Spec: ${construct}\nAlso: [${GUIDE_TEXT}](${GUIDE_HREF})\nImage: ![diagram](${href})`;
  const start = content.indexOf(construct);
  const guideStart = content.indexOf(`[${GUIDE_TEXT}]`);
  return {
    content,
    links: [
      createTestLink({
        text: 'Diagram spec',
        href,
        startOffset: start,
        endOffset: start + construct.length,
        ...overrides,
      }),
      createTestLink({
        text: GUIDE_TEXT,
        href: GUIDE_HREF,
        nodeType: 'link',
        startOffset: guideStart,
        endOffset: content.indexOf(')', guideStart) + 1,
      }),
    ],
  };
}

/** Strip both kinds, so the external autolink case has a rule to match. */
const STRIP_LOCAL_AND_EXTERNAL = createTypeRule([LOCAL_FILE, EXTERNAL], STRIP_TEMPLATE);

describe('a LOCATED construct the replay cannot express must not disturb its NEIGHBOURS', () => {
  it('spares an image sharing an href with a reference-style USE', () => {
    // 🚨 The same corruption the titled-link case above pins, reached through the
    // other verdict. A reference-style use `[t][id]` HAS a span, so the parser
    // located it — but it is not `[...](...)`, so the splice pass declined it as
    // UNRECOGNISED, which put it into `fallbackByHref`. `MARKDOWN_LINK_REGEX` can
    // never match `[t][id]`, so that map entry could only ever fire on a DIFFERENT
    // construct sharing the href — and images are never `ResourceLink`s (pinned in
    // `link-grammar-divergence.test.ts`), so they are never candidates and never
    // refused: pure prey. Measured against `dist` before the fix,
    // `![diagram](evals/diagram.png)` was rewritten through the strip template
    // while the use itself shipped unrewritten either way.
    const { content, links } = locatedNonInlineFixture(
      '[Diagram spec][id]',
      SHARED_IMG_HREF,
      { nodeType: 'linkReference' },
    );

    const result = transformContent(content, links, {
      linkRewriteRules: [STRIP_LOCAL_AND_EXTERNAL],
    });

    expect(result).toBe(
      `Spec: [Diagram spec][id]\nAlso: ${GUIDE_TEXT}\nImage: ![diagram](${SHARED_IMG_HREF})`,
    );
  });

  it('spares an image sharing an href with an AUTOLINK', () => {
    // The other located-but-inexpressible shape, and the reason the discriminator
    // is the span rather than `nodeType`: mdast reports an autolink as a `link`
    // node, indistinguishable by type from an inline link, and only the bytes at
    // the span say `<…>`. An `<a href>` reaches the same branch — its span is the
    // ATTRIBUTE (`html-link-parser.ts › makeLink`), which also does not open `[`.
    const { content, links } = locatedNonInlineFixture(
      `<${AUTOLINK_HREF}>`,
      AUTOLINK_HREF,
      { type: EXTERNAL, nodeType: 'link' },
    );

    const result = transformContent(content, links, {
      linkRewriteRules: [STRIP_LOCAL_AND_EXTERNAL],
    });

    expect(result).toBe(
      `Spec: <${AUTOLINK_HREF}>\nAlso: ${GUIDE_TEXT}\nImage: ![diagram](${AUTOLINK_HREF})`,
    );
  });

  it('spares an image when a located span has no closing bracket', () => {
    // The span is in bounds and opens `[`, so the parser placed it, but the
    // brackets never balance — this is `content` and `links` disagreeing, e.g.
    // a span measured against different bytes. Failing CLOSED (leave it alone)
    // is the only safe answer: handing the href to the replay would again reach
    // for whatever else carries it, and here that is the image.
    const { content, links } = locatedNonInlineFixture(
      '[Diagram spec (unclosed',
      SHARED_IMG_HREF,
      { nodeType: 'link' },
    );

    const result = transformContent(content, links, {
      linkRewriteRules: [STRIP_LOCAL_AND_EXTERNAL],
    });

    expect(result).toBe(
      `Spec: [Diagram spec (unclosed\nAlso: ${GUIDE_TEXT}\nImage: ![diagram](${SHARED_IMG_HREF})`,
    );
  });
});

describe('a link with NO usable span must still reach the regex replay', () => {
  it('rewrites a link whose span runs past the end of the content', () => {
    // ⚠️ The guard against fixing the neighbour-corruption too broadly. Excluding
    // every declined link from `fallbackByHref` would silently stop rewriting the
    // links the fallback exists FOR — and this is the second such shape, beside
    // the offset-less link pinned in `link-grammar-divergence.test.ts`. A span
    // that does not address these bytes is not a location, so the parser has told
    // us nothing about where the construct is and the replay is the only thing
    // that can find it.
    const content = `See [${GUIDE_TEXT}](${GUIDE_HREF}).`;
    const links = [createTestLink({
      text: GUIDE_TEXT, href: GUIDE_HREF, nodeType: 'link', startOffset: 4, endOffset: 9999,
    })];

    const result = transformContent(content, links, {
      linkRewriteRules: [createTypeRule(LOCAL_FILE, STRIP_TEMPLATE)],
    });

    expect(result).toBe(`See ${GUIDE_TEXT}.`);
  });
});

// ============================================================================
// Line endings — a rewriter returns the file it was given
// ============================================================================


const EOL_REF = 'guide-ref';
const EOL_ID = 'eol-guide';
const EOL_SOURCE_OUTPUT = '/output/SKILL.md';
const EOL_TARGET_PATH = '/output/resources/guide.md';
const EOL_EXPECTED_REL = 'resources/guide.md';

/**
 * The definition pass, with a registry that resolves `GUIDE_HREF`.
 *
 * @param content - The document to rewrite, line endings included
 * @returns The rewritten document
 */
function rewriteDefinitions(content: string): string {
  return transformContent(content, [createDefinitionLink(content, EOL_REF, GUIDE_HREF, EOL_ID)], {
    linkRewriteRules: [createTypeRule(LOCAL_FILE, REWRITE_LINK_TEMPLATE)],
    resourceRegistry: createTestRegistry([
      createTestResource({ id: EOL_ID, filePath: EOL_TARGET_PATH }),
    ]),
    sourceFilePath: EOL_SOURCE_OUTPUT,
  });
}

/**
 * How many line feeds are NOT preceded by a carriage return.
 *
 * The mechanism assertion. `toBe` on the whole string proves this one document is
 * right; this proves the property the rewriter owes every document, and it is the
 * one a future edit to the regex would break without changing the fixture.
 *
 * @param text - The rewritten document
 * @returns The count of bare line feeds
 */
function bareLineFeeds(text: string): number {
  const total = [...text].filter((character) => character === LF).length;
  const paired = text.split(CRLF).length - 1;
  return total - paired;
}

describe('a rewritten definition keeps the line ending it was written with', () => {
  it('leaves a CRLF file entirely CRLF', () => {
    // 🚨 The defect. `MARKDOWN_DEFINITION_REGEX` ended `(\S[^\n]*)$`, and JS's
    // multiline `$` asserts before a CR as well as before an LF — so the greedy
    // class swallowed the CR into the captured destination, the whole match
    // included it, and the replacement put back a line with no CR at all. The
    // rewritten definition shipped LF-terminated inside an otherwise CRLF file.
    // `href.trim()` then hid it: the registry lookup still succeeded, so nothing
    // failed, and the only evidence was a file that no longer round-trips a diff
    // or a checksum.
    const content = `Intro.${CRLF}${CRLF}[${EOL_REF}]: ${GUIDE_HREF}${CRLF}Trailing.${CRLF}`;

    const result = rewriteDefinitions(content);

    expect(result).toBe(
      `Intro.${CRLF}${CRLF}[${EOL_REF}]: ${EOL_EXPECTED_REL}${CRLF}Trailing.${CRLF}`,
    );
    expect(bareLineFeeds(result)).toBe(0);
  });

  it('leaves an LF file entirely LF', () => {
    // The control. Preserving CRLF must not be done by NORMALIZING to it — a
    // rewriter that "fixed" every file to CRLF would pass the assertion above.
    const content = `Intro.${LF}${LF}[${EOL_REF}]: ${GUIDE_HREF}${LF}Trailing.${LF}`;

    const result = rewriteDefinitions(content);

    expect(result).toBe(
      `Intro.${LF}${LF}[${EOL_REF}]: ${EOL_EXPECTED_REL}${LF}Trailing.${LF}`,
    );
    expect(result).not.toContain(CR);
  });

  it('rewrites a definition on the last line, which has no ending at all', () => {
    const content = `Intro.${CRLF}${CRLF}[${EOL_REF}]: ${GUIDE_HREF}`;

    expect(rewriteDefinitions(content)).toBe(
      `Intro.${CRLF}${CRLF}[${EOL_REF}]: ${EOL_EXPECTED_REL}`,
    );
  });

  it('collapses the blank lines left by a REMOVED definition in CRLF too', () => {
    // The other half. Removing an orphaned definition leaves its line ending
    // behind, and the tidy-up that collapses the resulting run was written
    // `/\n{3,}/` — which cannot match `\r\n\r\n\r\n` at all, so a CRLF file kept
    // every blank line an LF file had cleaned up. Same rule, both endings.
    const content = `A.${CRLF}${CRLF}[${EOL_REF}]: ${GUIDE_HREF}${CRLF}${CRLF}B.${CRLF}`;

    const result = transformContent(content, [createDefinitionLink(content, EOL_REF, GUIDE_HREF)], {
      linkRewriteRules: [createTypeRule(LOCAL_FILE, LINK_TEXT_VAR)],
    });

    expect(result).toBe(`A.${CRLF}${CRLF}B.${CRLF}`);
    expect(bareLineFeeds(result)).toBe(0);
  });

  it('collapses the same run in LF, unchanged', () => {
    const content = `A.${LF}${LF}[${EOL_REF}]: ${GUIDE_HREF}${LF}${LF}B.${LF}`;

    const result = transformContent(content, [createDefinitionLink(content, EOL_REF, GUIDE_HREF)], {
      linkRewriteRules: [createTypeRule(LOCAL_FILE, LINK_TEXT_VAR)],
    });

    expect(result).toBe(`A.${LF}${LF}B.${LF}`);
  });
});

// ============================================================================
// Definitions are SPLICED at their span, not correlated by label
// ============================================================================

/**
 * The definition pass over links the REAL parser produced, every definition
 * resolving to the `EOL_ID` resource.
 *
 * mdast puts the NORMALISED identifier in `text` (lower-cased, whitespace
 * collapsed), so a hand-built fixture whose `text` equals the label as written
 * cannot see a correlation-by-label defect. The parser has to be the producer.
 *
 * @param content - The document, definitions included
 * @param resolve - Whether the registry resolves the definitions
 * @returns The rewritten document
 */
function rewriteParsedDefinitions(content: string, resolve = true): string {
  const links = parseMarkdownContent(content, Buffer.byteLength(content)).links
    .map((link) => (link.nodeType === 'definition' && resolve ? { ...link, resolvedId: EOL_ID } : link));
  return transformContent(content, links, {
    linkRewriteRules: [createTypeRule(LOCAL_FILE, resolve ? REWRITE_LINK_TEMPLATE : LINK_TEXT_VAR)],
    ...(resolve && {
      resourceRegistry: createTestRegistry([createTestResource({ id: EOL_ID, filePath: EOL_TARGET_PATH })]),
    }),
    sourceFilePath: EOL_SOURCE_OUTPUT,
  });
}

describe('a definition is spliced at its own span, whatever its label\'s spelling', () => {
  it.each([
    // 🚨 The finding. Pass 2 keyed a definition on `link.text`, which for a
    // `definition` is mdast's NORMALISED identifier (`api`), and looked it up
    // with the label the regex captured as WRITTEN (`API`). Any label with an
    // upper-case letter missed the map and shipped with the unpackaged path.
    ['an upper-case letter', 'API'],
    ['a doubled space, which mdast collapses', 'my  guide'],
    ['a mixed-case multi-word label', 'User Guide'],
  ])('rewrites a definition whose label has %s', (_name, label) => {
    const content = `See [ref][${label}].${LF}${LF}[${label}]: ${GUIDE_HREF}${LF}`;

    expect(rewriteParsedDefinitions(content)).toBe(
      `See [ref][${label}].${LF}${LF}[${label}]: ${EOL_EXPECTED_REL}${LF}`,
    );
  });

  it('removes an orphaned definition whose label has an upper-case letter', () => {
    // The strip half of the same defect: the orphan was left in place.
    const content = `Text.${LF}${LF}[API]: ${GUIDE_HREF}${LF}`;

    expect(rewriteParsedDefinitions(content, false)).toBe(`Text.${LF}${LF}`);
  });

  it('leaves a definition whose destination it cannot re-emit exactly as written', () => {
    // A title, or angle brackets, are not in `[ref]: href` — re-emitting would
    // destroy them, so the splice declines, as pass 1 does for the same shapes.
    const content = `[a]: ${GUIDE_HREF} "Title"${LF}[b]: <${GUIDE_HREF}>${LF}`;

    expect(rewriteParsedDefinitions(content)).toBe(content);
  });
});

describe('the blank-line collapse touches ONLY the line a removed definition left', () => {
  it('keeps two consecutive blank lines inside a fenced block', () => {
    // 🚨 The finding. The collapse ran over the WHOLE document whenever any
    // definition existed, code fences included — so a Python example carrying
    // PEP 8's two blank lines between top-level defs shipped with one. The
    // rewriter's contract is the file it was given with the intended edit
    // applied; a blank line inside a fence is content.
    const fence = `${TICK}${TICK}${TICK}python${LF}def a():${LF}    pass${LF}${LF}${LF}def b():${LF}    pass${LF}${TICK}${TICK}${TICK}${LF}`;
    const content = `Intro.${LF}${LF}[ref]: ${GUIDE_HREF}${LF}${LF}${fence}`;

    expect(rewriteParsedDefinitions(content, false)).toBe(`Intro.${LF}${LF}${fence}`);
  });

  it('keeps a run of blank lines in PROSE that no removal created', () => {
    // The mechanism, not the instance: it is not that fences are exempt, it is
    // that nothing but the removed line's own run is collapsed.
    const content = `A.${LF}${LF}${LF}${LF}B.${LF}${LF}[ref]: ${GUIDE_HREF}${LF}${LF}C.${LF}`;

    expect(rewriteParsedDefinitions(content, false)).toBe(`A.${LF}${LF}${LF}${LF}B.${LF}${LF}C.${LF}`);
  });

  it('collapses nothing when the definition was rewritten rather than removed', () => {
    const content = `A.${LF}${LF}${LF}${LF}[ref]: ${GUIDE_HREF}${LF}`;

    expect(rewriteParsedDefinitions(content)).toBe(`A.${LF}${LF}${LF}${LF}[ref]: ${EOL_EXPECTED_REL}${LF}`);
  });
});

// ============================================================================
// Bracket matching inside a link's TEXT
// ============================================================================

const SPAN_HREF = 'refs/guide.md';
const SPAN_TEMPLATE = '[{{link.rawText}}](REWRITTEN/{{link.href}})';

/**
 * Rewrite one line through the REAL parser, so the spans are the parser's own.
 *
 * Hand-written offsets would let this file assert whatever it assumed mdast says.
 * The whole question here is what mdast reports for a link whose text contains a
 * code span, so the parser has to be the one answering it.
 *
 * @param markdown - A single line of markdown
 * @returns The rewritten line
 */
function spliceThroughParser(markdown: string): string {
  const document = `${markdown}${LF}`;
  const links = parseMarkdownContent(document, Buffer.byteLength(document)).links;
  return transformContent(markdown, links, {
    linkRewriteRules: [],
    defaultTemplate: SPAN_TEMPLATE,
    context: {},
  });
}

/**
 * A link whose TEXT contains `text`, and the rewrite it is owed.
 *
 * @param text - Raw markdown for the link's text
 * @returns The source line and the line the splice must produce
 */
function spanCase(text: string): { source: string; rewritten: string } {
  return {
    source: `[${text}](${SPAN_HREF})`,
    rewritten: `[${text}](REWRITTEN/${SPAN_HREF})`,
  };
}

describe('a bracket inside a CODE SPAN is not a bracket', () => {
  it.each([
    // 🚨 The finding. `matchingBracketEnd` counted raw brackets, so the `[` inside
    // the code span opened a nesting level that never closed — the function ran
    // off the end, returned undefined, and the link was REFUSED. It then shipped
    // unrewritten and `post-build-checks` reported it as PACKAGED_BROKEN_LINK:
    // the author blamed for a rewriter miss, over a line CommonMark is entirely
    // happy with.
    ['an unbalanced [ in a code span', `the ${TICK}[${TICK} matcher`],
    // The mirror image, and it failed differently: the `]` inside the span closed
    // the construct EARLY, so `close + 1` was not `(` and the link was refused
    // there instead. Two symptoms, one cause.
    ['an unbalanced ] in a code span', `the ${TICK}]${TICK} closer`],
    // The whole link-closing sequence inside a code span — the case the
    // destination check was catching, and describing as a truncating splice.
    ['a whole ]( in a code span', `see ${TICK}](${TICK} here`],
    // A double-backtick span, so the fix cannot be "skip one character after a
    // backtick": the run length decides where the span ends.
    ['a bracket in a double-backtick span', `a ${TICK}${TICK}[not a link](x)${TICK}${TICK} b`],
    // A code span with the brackets BALANCED inside it. Counting them happened to
    // work here, which is why the defect was never noticed on this shape.
    ['balanced brackets in a code span', `the ${TICK}[x]${TICK} form`],
  ])('splices a link whose text carries %s', (_name, text) => {
    const { source, rewritten } = spanCase(text);
    expect(spliceThroughParser(source)).toBe(rewritten);
  });

  it.each([
    // The controls. Every one of these already worked, and a code-span-aware
    // scanner must not cost any of them.
    ['balanced nested brackets', 'a [b] c'],
    ['an escaped opening bracket', String.raw`a \[ b`],
    ['an escaped closing bracket', String.raw`a \] b`],
    ['an image', '![alt](img.png)'],
    ['nested emphasis', '**a** _b_'],
    // An UNCLOSED backtick is prose, not a code span — CommonMark leaves it as a
    // literal. A scanner that treated it as opening a span would swallow the rest
    // of the line and lose the link entirely.
    ['an unclosed backtick', `a ${TICK} b`],
    // Two runs of different lengths: the single tick does not close the double.
    ['mismatched backtick runs', `a ${TICK}${TICK} b ${TICK} c ${TICK}${TICK} d`],
  ])('still splices a link whose text carries %s', (_name, text) => {
    const { source, rewritten } = spanCase(text);
    expect(spliceThroughParser(source)).toBe(rewritten);
  });

  it('leaves a code span that FOLLOWS the link alone', () => {
    // The scanner stops at the link's own closing bracket, so a span later on the
    // line is never consulted — and must not be rewritten either, since mdast
    // yields no link node inside code.
    const source = `[Guide](${SPAN_HREF}) — compare ${TICK}[Guide](${SPAN_HREF})${TICK}`;

    expect(spliceThroughParser(source)).toBe(
      `[Guide](REWRITTEN/${SPAN_HREF}) — compare ${TICK}[Guide](${SPAN_HREF})${TICK}`,
    );
  });

  it.each([
    // 🚨 The finding, one line-break over. A CommonMark code span crosses a
    // single line ending — only a BLANK line ends it — but both scanners bounded
    // the closing-run search at the newline, so the `[` inside a span that wraps
    // at a soft break opened a nesting level that never closed, the link was
    // refused, shipped unrewritten, and was reported PACKAGED_BROKEN_LINK. Prose
    // reflowed to 80 columns produces this shape without anyone writing it.
    ['an unbalanced [ in a code span that wraps a line', `the ${TICK}on${LF}this [ line${TICK} here`],
    ['a code span whose closer is on the next line', `the ${TICK}[ on${LF}this${TICK} line`],
  ])('splices a link whose text carries %s', (_name, text) => {
    const { source, rewritten } = spanCase(text);
    expect(spliceThroughParser(source)).toBe(rewritten);
  });

  it('does not let a code span cross a BLANK line', () => {
    // The bound the scanner keeps. A blank line ends the paragraph, so a
    // backtick after it cannot close a span opened before it — the run before
    // the blank line is prose, and the link there is an ordinary link.
    const source = `[a ${TICK} b](${SPAN_HREF})${LF}${LF}${TICK}[not](x)${TICK}`;

    expect(spliceThroughParser(source)).toBe(
      `[a ${TICK} b](REWRITTEN/${SPAN_HREF})${LF}${LF}${TICK}[not](x)${TICK}`,
    );
  });
});

// ============================================================================
// The fallback mask and the bracket matcher share ONE code-span rule
// ============================================================================

/** A backslash, built from its code point for the same reason `TICK` is. */
const BACKSLASH = String.fromCodePoint(0x5c);

/**
 * The regex replay over a link with NO span — the only lane the code-span MASK
 * still guards — with the same href written twice.
 *
 * @param content - The document, carrying `dup.md` twice
 * @returns The rewritten document
 */
function replayOverMask(content: string): string {
  const spanless: ResourceLink[] = [
    { text: 'x', href: 'dup.md', type: LOCAL_FILE, line: 1, nodeType: 'link' },
  ];
  return transformContent(content, spanless, {
    linkRewriteRules: [],
    defaultTemplate: SPAN_TEMPLATE,
    context: {},
  });
}

describe('the fallback mask ends a code span where the bracket matcher does', () => {
  it('masks an example whose code span wraps a line', () => {
    // The mask side of the same finding: `collectInlineSpans` was fed one line
    // at a time, so an example whose closing backtick sat on the next line was
    // not masked, and the replay rewrote the example as well as the link.
    const content = `${TICK}[x](dup.md)${LF}${TICK} and [x](dup.md)`;

    expect(replayOverMask(content)).toBe(`${TICK}[x](dup.md)${LF}${TICK} and [x](REWRITTEN/dup.md)`);
  });

  it('does not treat an ESCAPED backtick as opening a code span', () => {
    // 🚨 `matchingBracketEnd` honoured backslash escapes and the mask did not,
    // so on this line the matcher saw two links and the mask saw one example
    // plus one link — two scanners disagreeing about where a code span is, which
    // is the divergence the module says it exists to stop. mdast agrees with the
    // matcher: an escaped backtick is a literal, the run it would have opened is
    // unclosed prose, and both `[x](dup.md)` are links.
    const content = BACKSLASH + `${TICK}[x](dup.md)${TICK} and [x](dup.md)`;

    expect(replayOverMask(content)).toBe(
      BACKSLASH + `${TICK}[x](REWRITTEN/dup.md)${TICK} and [x](REWRITTEN/dup.md)`,
    );
  });
});

// ============================================================================
// What the destination check does NOT buy
// ============================================================================

/**
 * A frontmatter block of EXACTLY the byte distance between the two links below.
 *
 * The length is load-bearing, not decorative: the historical misalignment shifted
 * every span by the frontmatter's length, and a shift only lands one link on top
 * of ANOTHER link when it happens to equal the distance between them. Tuning it
 * is what turns "unlikely" into "here it is". `title: TTT` is padding chosen for
 * its length and nothing else.
 */
const SHIFT_FRONTMATTER = `---${LF}title: TTT${LF}---${LF}${LF}`;
/**
 * Two links, one href, and the SAME LENGTH.
 *
 * Equal length is required for the same reason the frontmatter's length is: the
 * stale span has to end on the second link's `)` for the splice to be attempted
 * at all. Equal-length neighbours are not contrived — `[Alpha](x)` and
 * `[Omega](x)` is the shape of any two same-target links whose labels happen to
 * match in width.
 */
const SHIFT_BODY = `[Alpha](${GUIDE_HREF})${LF}[Omega](${GUIDE_HREF})${LF}`;

describe('two links sharing an href defeat the destination comparison', () => {
  it('places the FIRST link\'s stale span exactly on the SECOND link', () => {
    // The premise, asserted rather than assumed. If mdast's offsets move, the
    // demonstration below stops demonstrating anything, and this is the assertion
    // that says so instead of the test quietly passing for a new reason.
    const document = `${SHIFT_FRONTMATTER}${SHIFT_BODY}`;
    const links = parseMarkdownContent(document, Buffer.byteLength(document)).links;

    expect(links).toHaveLength(2);
    // Whole-DOCUMENT offsets, which is what the parser reports and what the
    // packager used to hand to `transformContent` alongside the stripped body.
    expect(links[0]?.startOffset).toBe(SHIFT_FRONTMATTER.length);
    // Applied to the BODY, the first link's span names the second link exactly.
    const [start, end] = [links[0]?.startOffset ?? 0, links[0]?.endOffset ?? 0];
    expect(SHIFT_BODY.slice(start, end)).toBe(`[Omega](${GUIDE_HREF})`);
  });

  it('rewrites the SECOND link through the FIRST link\'s metadata', () => {
    // 🚨 The finding, constructed. `splicableFrom`'s docstring claimed that
    // comparing the span's destination to the parser's href made this
    // "unconstructible rather than merely unlikely". It does not: the comparison
    // is keyed on a value the two links HAVE IN COMMON, so it passes, and the
    // splice writes the first link's rendering over the second link's span.
    //
    // The observable result is a SWAP — `Omega` where `Alpha` was written and
    // `Alpha` where `Omega` was — because the second link, whose own stale span
    // runs off the end of the body, is unlocatable and falls through to the
    // href-keyed replay, which finds the first link's text.
    //
    // ⚠️ This is characterization, not a wish. The comparison is a MITIGATION and
    // the guarantee is the documented precondition — `links` must come from the
    // same bytes as `content` — which only a caller can establish. The one
    // production caller now VERIFIES it (`skill-packager.ts › bodyRelativeLinks`
    // checks that the body is a suffix of the content it re-bases against)
    // instead of resting on this comparison. Do not "fix" a failure here by
    // editing the expectation: a change means the mitigation's reach moved.
    const document = `${SHIFT_FRONTMATTER}${SHIFT_BODY}`;
    const links = parseMarkdownContent(document, Buffer.byteLength(document)).links;

    const result = transformContent(SHIFT_BODY, links, {
      linkRewriteRules: [createTypeRule(LOCAL_FILE, LINK_TEXT_VAR)],
    });

    expect(result).toBe(`Omega${LF}Alpha${LF}`);
  });

  it('produces the right answer when the spans DO address the content', () => {
    // The control, and the whole point of the precondition. The same two links,
    // parsed from the bytes they are then applied to, rewrite correctly.
    const links = parseMarkdownContent(SHIFT_BODY, Buffer.byteLength(SHIFT_BODY)).links;

    const result = transformContent(SHIFT_BODY, links, {
      linkRewriteRules: [createTypeRule(LOCAL_FILE, LINK_TEXT_VAR)],
    });

    expect(result).toBe(`Alpha${LF}Omega${LF}`);
  });
});
