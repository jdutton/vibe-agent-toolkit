/**
 * @vibe-agent-toolkit/utils/yaml
 *
 * Byte-surgical YAML value updates that replace or insert without reflowing
 * the surrounding document. Pure with respect to Node builtins, but it pulls
 * in `yaml` — roughly 271KB bundled. Quarantined behind its own subpath.
 */

export * from './yaml/surgical-yaml.js';
