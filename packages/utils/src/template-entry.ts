/**
 * @vibe-agent-toolkit/utils/template
 *
 * Cached Handlebars rendering with HTML escaping disabled. Pure with respect
 * to Node builtins, but it pulls in `handlebars` (and transitively
 * `source-map`) — roughly 239KB bundled. Quarantined behind its own subpath
 * so importing a path helper never pays for it.
 */

export * from './template.js';
