### Breaking

- **`@vibe-agent-toolkit/runtime-openai` now builds on `openai` 6** (was 4). If you pass your own
  `client`, construct it from `openai@^6`; an `openai@4` client no longer type-checks.

### Changed

- **Bundled SDKs upgraded:** `@anthropic-ai/sdk` 0.127 (one version across the CLI, the Claude
  Agent SDK adapter and the examples), `@anthropic-ai/claude-agent-sdk` 0.3, `@lancedb/lancedb`
  0.39 (RAG backend). No action needed.
