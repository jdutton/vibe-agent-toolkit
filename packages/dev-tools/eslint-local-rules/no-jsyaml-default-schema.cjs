/**
 * ESLint rule: no-jsyaml-default-schema
 *
 * Disallow `js-yaml`'s `yaml.load(...)` / `yaml.loadAll(...)` without an
 * explicit `schema` option. The package's default `DEFAULT_SCHEMA` still
 * applies the YAML 1.1 `!!timestamp` tag, auto-promoting unquoted ISO
 * dates (`2026-04-15`) to JavaScript `Date` objects — which then fail
 * JSON Schema string validators and confuse downstream code that expects
 * the raw YAML text.
 *
 * Pass `{ schema: CORE_SCHEMA }` (YAML 1.2 spec) — or `JSON_SCHEMA` /
 * `FAILSAFE_SCHEMA` if you have a reason — so dates and other YAML 1.1
 * quirks stay as strings. eemeli/yaml (`import yaml from 'yaml'`) is
 * already YAML 1.2 by default and is not flagged.
 *
 * @example
 * // ❌ BAD — js-yaml defaults promote ISO dates to Date objects
 * import yaml from 'js-yaml';
 * const data = yaml.load(content);
 *
 * // ✅ GOOD
 * import yaml from 'js-yaml';
 * const data = yaml.load(content, { schema: yaml.CORE_SCHEMA });
 *
 * // ✅ Also GOOD — different lib that's already 1.2
 * import yaml from 'yaml';
 * const data = yaml.parse(content);
 */

'use strict';

const FLAGGED_METHODS = new Set(['load', 'loadAll']);

function hasSchemaProperty(optionsNode) {
  if (!optionsNode || optionsNode.type !== 'ObjectExpression') return false;
  return optionsNode.properties.some(
    (p) => p.type === 'Property' && !p.computed && p.key && (
      (p.key.type === 'Identifier' && p.key.name === 'schema') ||
      (p.key.type === 'Literal' && p.key.value === 'schema')
    ),
  );
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow js-yaml `load`/`loadAll` without an explicit `schema` — js-yaml's default still applies YAML 1.1 `!!timestamp` promotion, auto-converting unquoted ISO dates to JS Date objects.",
      category: 'Correctness',
      recommended: true,
    },
    messages: {
      requireSchema:
        "js-yaml's default schema still promotes unquoted ISO dates to JS Date objects (a YAML 1.1 tag). Pass `{ schema: yaml.CORE_SCHEMA }` (YAML 1.2 spec) — or JSON_SCHEMA / FAILSAFE_SCHEMA if you need stricter — so dates stay strings.",
    },
    schema: [],
  },

  create(context) {
    // Track which local identifiers were imported from 'js-yaml' so we
    // don't flag `yaml.load(...)` from the eemeli/yaml library (different
    // package, different defaults — already YAML 1.2 spec-compliant).
    const jsYamlBindings = new Set();
    const namedLoadBindings = new Set();

    function checkCall(node) {
      // Method form: yaml.load(x) / jsYaml.load(x)
      if (
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.object.type === 'Identifier' &&
        jsYamlBindings.has(node.callee.object.name) &&
        node.callee.property.type === 'Identifier' &&
        FLAGGED_METHODS.has(node.callee.property.name)
      ) {
        if (node.arguments.length < 2 || !hasSchemaProperty(node.arguments[1])) {
          context.report({ node, messageId: 'requireSchema' });
        }
        return;
      }

      // Named form: load(x) / loadAll(x) imported from 'js-yaml'
      if (
        node.callee.type === 'Identifier' &&
        namedLoadBindings.has(node.callee.name)
      ) {
        if (node.arguments.length < 2 || !hasSchemaProperty(node.arguments[1])) {
          context.report({ node, messageId: 'requireSchema' });
        }
      }
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'js-yaml') return;
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportDefaultSpecifier') {
            jsYamlBindings.add(spec.local.name);
          } else if (spec.type === 'ImportNamespaceSpecifier') {
            jsYamlBindings.add(spec.local.name);
          } else if (spec.type === 'ImportSpecifier') {
            const imported = spec.imported.type === 'Identifier' ? spec.imported.name : null;
            if (imported === 'load' || imported === 'loadAll') {
              namedLoadBindings.add(spec.local.name);
            }
          }
        }
      },
      CallExpression: checkCall,
    };
  },
};
