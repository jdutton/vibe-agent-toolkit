import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { JSON_SCHEMA_TARGETS } from '../src/json-schema-targets.js';
import { ValidationConfigSchema } from '../src/validation-config.js';
import { customCheckCode } from '../src/validation-issue.js';

/**
 * 🔑 **A generated artifact is a second consumer of every schema edit, and it
 * fails SILENTLY.**
 *
 * Nothing in this suite used to look at `schemas/*.json`, which is the only
 * reason this shipped: `SeverityOverrideCodeSchema` was widened from the
 * registry enum to a union (correctly — `CUSTOM:<name>` keys used to fail
 * `loadConfig` and brick every command), and `zod-to-json-schema` has no case
 * for a UNION record key, so the emitted `severity` silently lost its
 * `propertyNames` entirely while `allow`, in the same published file, kept its
 * full enum. One shipped artifact disagreed with itself about what a code is,
 * and an adopter validating `vibe-agent-toolkit.config.yaml` in their editor got
 * `LNIK_OUTSIDE_PROJECT: ignore` accepted by the schema and refused by
 * `loadConfig`.
 *
 * The runtime never broke, so no runtime test could have caught it. These cases
 * assert on the ARTIFACT, and they are written against the general property
 * rather than against `severity`, so the next key to lose its constraint —
 * whichever schema it is in — goes red too.
 */

type JsonNode = Record<string, unknown>;

const SCHEMAS_DIR = safePath.join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

/** A probe key, exercised against both contracts. */
const PROBE_KEYS = [
  'LINK_OUTSIDE_PROJECT',
  'ALWAYS_LOADED_CONTEXT_BUDGET',
  customCheckCode('my-check'),
  customCheckCode('a check with spaces'),
  'CUSTOM:',
  'LNIK_OUTSIDE_PROJECT',
  'RESOURCE_CHECK_BROKEN',
  'custom:my-check',
  'lowercase',
  '',
] as const;

/** RFC 6901 pointer separator. Not a filesystem path — these never touch disk. */
const JSON_POINTER_SEPARATOR = '/';

function isNode(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The committed artifact for one target.
 *
 * @param name - The target's basename under `schemas/`
 * @returns The parsed document
 */
function readCommitted(name: string): JsonNode {
  const path = safePath.join(SCHEMAS_DIR, `${name}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from JSON_SCHEMA_TARGETS, a module-private list of literals
  return JSON.parse(readFileSync(path, 'utf8')) as JsonNode;
}

/**
 * Follow a `#/`-rooted JSON pointer.
 *
 * @param root - The whole document
 * @param ref - The pointer
 * @returns The node it names, or undefined if it names nothing
 */
function resolvePointer(root: JsonNode, ref: string): JsonNode | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split(JSON_POINTER_SEPARATOR)) {
    if (!isNode(node)) return undefined;
    node = node[raw.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return isNode(node) ? node : undefined;
}

/**
 * Resolve `$ref` indirection so a walk pairs Zod nodes with real schema nodes.
 *
 * `zod-to-json-schema` emits a `$ref` for any Zod instance it has already
 * serialized, so the same record can be reached under several pointers.
 *
 * @param root - The whole document
 * @param node - The node to resolve
 * @returns The referent, or the node itself when it is not a reference
 */
function deref(root: JsonNode, node: JsonNode | undefined): JsonNode | undefined {
  let current = node;
  for (let hop = 0; hop < 10; hop += 1) {
    if (current === undefined) return undefined;
    const ref = current['$ref'];
    // A `$ref` PROPERTY (SchemaRefSchema has one) holds an object, not a string.
    if (typeof ref !== 'string') return current;
    current = resolvePointer(root, ref);
  }
  return undefined;
}

/**
 * Step into a child node by keys, resolving any reference on the way out.
 *
 * @param root - The whole document
 * @param node - The node to descend from
 * @param keys - Property names to follow in order
 * @returns The child, or undefined if the path does not exist
 */
function childNode(root: JsonNode, node: JsonNode | undefined, keys: string[]): JsonNode | undefined {
  let current: unknown = node;
  for (const key of keys) {
    // Keyword values are sometimes arrays (`anyOf`, `allOf`, tuple `items`), so
    // an index is a legitimate step and `isNode` alone would refuse it.
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isNode(current)) current = current[key];
    else return undefined;
  }
  return isNode(current) ? deref(root, current) : undefined;
}

/** One Zod node and the emitted node it produced. */
interface Site {
  zod: ZodTypeAny;
  json: JsonNode | undefined;
  path: string;
}

interface ZodDef {
  typeName?: string;
  [key: string]: unknown;
}

/**
 * The Zod sub-schemas of one node, each paired with the JSON node it emitted.
 *
 * A type this does not know is treated as a leaf. That is safe rather than
 * silent: `walk` reports what it reached, and the coverage case below fails if
 * anything with an open key space was never visited.
 *
 * @param site - The node to descend from
 * @param root - The whole document
 * @returns The child sites
 */
function childrenOf(site: Site, root: JsonNode): Site[] {
  const def = (site.zod as unknown as { _def: ZodDef })._def;
  const step = (keys: string[]): JsonNode | undefined => childNode(root, site.json, keys);
  const inner = (schema: unknown, json: JsonNode | undefined, suffix = ''): Site[] =>
    [{ zod: schema as ZodTypeAny, json, path: site.path + suffix }];

  switch (def.typeName ?? '') {
    case 'ZodObject': {
      const shape = (def['shape'] as () => Record<string, ZodTypeAny>)();
      return Object.entries(shape).map(([key, schema]) => ({
        zod: schema,
        json: step(['properties', key]),
        path: `${site.path}.${key}`,
      }));
    }
    case 'ZodRecord':
      return inner(def['valueType'], step(['additionalProperties']), '[*]');
    case 'ZodArray':
      return inner(def['type'], step(['items']), '[]');
    case 'ZodTuple':
      return (def['items'] as ZodTypeAny[]).map((schema, index) => ({
        zod: schema,
        json: step(['items', String(index)]),
        path: `${site.path}[${index}]`,
      }));
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return [...(def['options'] as ZodTypeAny[])].map((schema, index) => ({
        zod: schema,
        json: step(['anyOf', String(index)]),
        path: `${site.path}|${index}`,
      }));
    case 'ZodIntersection':
      return [
        { zod: def['left'] as ZodTypeAny, json: step(['allOf', '0']), path: `${site.path}&0` },
        { zod: def['right'] as ZodTypeAny, json: step(['allOf', '1']), path: `${site.path}&1` },
      ];
    case 'ZodNullable':
      return inner(def['innerType'], step(['anyOf', '0']) ?? site.json);
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
      return inner(def['innerType'], site.json);
    case 'ZodEffects':
      return inner(def['schema'], site.json);
    case 'ZodBranded':
    case 'ZodPromise':
      return inner(def['type'], site.json);
    case 'ZodLazy':
      return inner((def['getter'] as () => ZodTypeAny)(), site.json);
    default:
      return [];
  }
}

/** A `z.record(...)` found in a Zod schema, with the node it emitted. */
interface RecordSite {
  path: string;
  /** True when the Zod key schema is narrower than a bare `z.string()`. */
  keyNarrowed: boolean;
  json: JsonNode | undefined;
}

/**
 * Whether a record's key schema promises anything beyond "some string".
 *
 * `z.record(value)` defaults its key to a bare `z.string()` — a deliberately
 * open key space (resource names, LLM names) with nothing to emit. Anything
 * else — an enum, a union, a string carrying checks, a refinement — is a
 * NARROWING the adopter's copy of the contract has to be told about.
 *
 * @param keyType - The record's key schema
 * @returns True when the key space is narrowed
 */
function keyIsNarrowed(keyType: unknown): boolean {
  const def = (keyType as { _def?: ZodDef } | undefined)?._def;
  if (def === undefined) return false;
  const checks = def['checks'];
  return def.typeName !== 'ZodString' || (Array.isArray(checks) && checks.length > 0);
}

/**
 * Every `z.record(...)` reachable from a schema, paired with its emitted node.
 *
 * @param schema - The Zod schema
 * @param root - The document generated from it
 * @returns One entry per reachable record
 */
function walkRecords(schema: ZodTypeAny, root: JsonNode): RecordSite[] {
  const found: RecordSite[] = [];
  const seen = new Set<ZodTypeAny>();
  const rootRef = root['$ref'];
  const start = typeof rootRef === 'string' ? resolvePointer(root, rootRef) : root;
  const stack: Site[] = [{ zod: schema, json: start, path: '' }];

  while (stack.length > 0) {
    const site = stack.pop();
    if (site === undefined || seen.has(site.zod)) continue;
    seen.add(site.zod);
    const def = (site.zod as unknown as { _def: ZodDef })._def;
    if (def.typeName === 'ZodRecord') {
      found.push({ path: site.path, keyNarrowed: keyIsNarrowed(def['keyType']), json: site.json });
    }
    stack.push(...childrenOf(site, root));
  }
  return found;
}

/**
 * Every emitted node that looks like a record, found without the Zod side.
 *
 * The independent half of the coverage case: a walker that quietly reached
 * nothing would otherwise pass every assertion in this file.
 *
 * @param value - Any part of the document
 * @param out - Accumulator, keyed by node identity
 */
function collectEmittedRecords(value: unknown, out: Set<JsonNode>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEmittedRecords(item, out);
    return;
  }
  if (!isNode(value)) return;
  if (value['type'] === 'object' && isNode(value['additionalProperties'])) out.add(value);
  for (const child of Object.values(value)) collectEmittedRecords(child, out);
}

/**
 * The verdict the SHIPPED JSON Schema gives a property name.
 *
 * Only the keywords `propertyNames` can carry here — an absent constraint
 * accepts everything, which is precisely the defect being pinned.
 *
 * @param propertyNames - The emitted `propertyNames` subschema, if any
 * @param key - The property name to test
 * @returns Whether the artifact accepts the key
 */
function artifactAcceptsKey(propertyNames: unknown, key: string): boolean {
  if (!isNode(propertyNames)) return true;
  const values = propertyNames['enum'];
  if (Array.isArray(values) && !values.includes(key)) return false;
  const pattern = propertyNames['pattern'];
  // eslint-disable-next-line security/detect-non-literal-regexp -- the pattern comes from this package's own generated artifact
  if (typeof pattern === 'string' && !new RegExp(pattern).test(key)) return false;
  return true;
}

describe.each(JSON_SCHEMA_TARGETS.map((target) => [target.name, target] as const))(
  'schemas/%s.json',
  (name, target) => {
    it('is committed in the state the generator produces', () => {
      // Both halves of "commit the .ts and the .schema.json" (CLAUDE.md) — an
      // artifact regenerated but not committed, or edited by hand, fails here.
      expect(readCommitted(name)).toEqual(zodToJsonSchema(target.schema, name));
    });

    it('constrains the key space of every record whose Zod key is not a bare string', () => {
      // 🔑 THE case. It does not name `severity`: any record that narrows its
      // keys in Zod and says nothing about it in the artifact fails here.
      const root = readCommitted(name);
      const unconstrained = walkRecords(target.schema, root)
        .filter((record) => record.keyNarrowed && !isNode(record.json?.['propertyNames']))
        .map((record) => record.path);

      expect(unconstrained, 'emitted records whose narrowed key space is not declared').toEqual([]);
    });

    it('is walked completely, so a silent under-walk cannot pass the case above', () => {
      const root = readCommitted(name);
      const reached = new Set(
        walkRecords(target.schema, root)
          .map((record) => record.json)
          .filter((node): node is JsonNode => node !== undefined),
      );
      const emitted = new Set<JsonNode>();
      collectEmittedRecords(root, emitted);

      expect([...emitted].filter((node) => !reached.has(node))).toEqual([]);
    });
  },
);

describe('schemas/validation-config.json — severity and allow agree about what a code is', () => {
  it.each(PROBE_KEYS)('gives %j the same verdict at runtime and in the artifact', (key) => {
    // The adopter-facing failure, stated as the property it violates: an editor
    // or CI validating the config against the shipped schema must reach the same
    // answer `loadConfig` will. A typo accepted here and refused there is two
    // shipped contracts disagreeing.
    const root = readCommitted('validation-config');
    const properties = root['definitions'] as Record<string, JsonNode>;
    const fields = (properties['validation-config'] as JsonNode)['properties'] as Record<string, JsonNode>;

    const severityVerdicts = {
      zod: ValidationConfigSchema.safeParse({ severity: { [key]: 'ignore' } }).success,
      artifact: artifactAcceptsKey(fields['severity']?.['propertyNames'], key),
    };
    const allowEntry = [{ paths: ['docs/**'], reason: 'probe' }];
    const allowVerdicts = {
      zod: ValidationConfigSchema.safeParse({ allow: { [key]: allowEntry } }).success,
      artifact: artifactAcceptsKey(fields['allow']?.['propertyNames'], key),
    };

    expect(severityVerdicts.artifact, `severity disagrees about ${JSON.stringify(key)}`)
      .toBe(severityVerdicts.zod);
    expect(allowVerdicts.artifact, `allow disagrees about ${JSON.stringify(key)}`)
      .toBe(allowVerdicts.zod);
  });
});
