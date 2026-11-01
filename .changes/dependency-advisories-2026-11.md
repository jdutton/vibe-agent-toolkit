### Security

- **`@vibe-agent-toolkit/agent-skills` and `@vibe-agent-toolkit/resource-compiler` now depend on
  `glob` ^14** (was ^10), clearing GHSA-3g3m-2fjr-6pw4 and, through glob's `minimatch` 11,
  GHSA-g3hv-75wg-m249. No action needed unless you pin `glob` or `minimatch` below those majors.
