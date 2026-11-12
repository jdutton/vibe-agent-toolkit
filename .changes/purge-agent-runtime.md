### Breaking

- **VAT is a toolkit for skills, plugins, marketplaces and knowledge resources (audit, build and
  distribution, RAG, the resource projection), not an agent runtime: everything that defined, ran,
  adapted, transported or exposed agents is removed, and nothing replaces it.** Drop these from your
  dependencies, scripts and CI:
  - Packages, no longer published: `@vibe-agent-toolkit/agent-runtime`,
    `@vibe-agent-toolkit/runtime-claude-agent-sdk`, `@vibe-agent-toolkit/runtime-langchain`,
    `@vibe-agent-toolkit/runtime-openai`, `@vibe-agent-toolkit/runtime-vercel-ai-sdk`,
    `@vibe-agent-toolkit/transports`, `@vibe-agent-toolkit/vat-example-cat-agents`,
    `@vibe-agent-toolkit/agent-config`, `@vibe-agent-toolkit/gateway-mcp`.
  - Commands: `vat agent build`, `vat agent import`, `vat agent install`, `vat agent installed`,
    `vat agent list`, `vat agent run`, `vat agent uninstall`, `vat agent validate`,
    `vat mcp serve` and `vat mcp list-collections`.
  - `@vibe-agent-toolkit/agent-skills` exports (library only): `buildAgentSkill`,
    `importSkillToAgent`, `AGENT_PACKAGE_ROOT_MISSING_CODE`.
  - `@vibe-agent-toolkit/agent-skills` also drops `BuildOptions`, `BuildResult`, `ImportOptions`,
    `ImportResult`, `ValidateOptions.isVATGenerated` and the `'vat-agent'` result type.
  - `@vibe-agent-toolkit/schema` agent exports (library only): the agent manifest
    (`AgentManifestSchema`, `AgentSpecSchema`, `CompositionConfigSchema`, `CredentialsConfigSchema`,
    `MemoryConfigSchema`, `PromptConfigSchema`, `PromptsConfigSchema`, `RAGConfigSchema`,
    `TestConfigSchema`), `AgentMetadataSchema`, `BuildMetadataSchema`, `LLMConfigSchema`,
    `AgentInterfaceSchema`, `SchemaRefSchema`, `Agent`, `ToolSchema`, `ToolAlternativeSchema`,
    `ResourceRegistrySchema`, `ResourceSchema`, `PackagingOptionsSchema`, `VatAgentMetadataSchema`,
    `VatPureFunctionMetadataSchema` (each with its type); the agent result envelope
    (`AgentResult`, `StatefulAgentResult`, `OneShotAgentOutput`, `ConversationalAgentOutput`,
    `ExecutionMetadata`, `createSuccess`, `createError`, `createInProgress`, `RESULT_SUCCESS`,
    `RESULT_ERROR`, `RESULT_IN_PROGRESS`, `ResultStatus`, `StatefulResultStatus`); and the LLM and
    external-event error vocabularies (`LLM_*`, `LLMError`, `RETRYABLE_LLM_ERRORS`,
    `NON_RETRYABLE_LLM_ERRORS`, `EVENT_*`, `ExternalEventError`, `RETRYABLE_EVENT_ERRORS`,
    `NON_RETRYABLE_EVENT_ERRORS`). The published JSON Schemas `agent-manifest.json`,
    `agent-metadata.json`, `agent-interface.json`, `llm-config.json`, `tool.json` and
    `resource-registry.json` are gone. `VatPackageMetadataSchema` no longer models `vat.agents`,
    `vat.pureFunctions` or `vat.runtimes`.
  - `@vibe-agent-toolkit/discovery`: `'vat-agent'` is gone from `DetectedFormat`; an `agent.yaml`
    is detected as `unknown`.
  - `vat audit` no longer classifies `agent.yaml`: the `vat-agent` format is gone from audit output
    (`type: vat-agent` results and the audit report schemas). A tree holding an `agent.yaml` audits
    as if the file were not there.
  - Report schemas `agent-build`, `agent-import`, `agent-install`, `agent-installed`, `agent-list`,
    `agent-uninstall`, `agent-validate` and `mcp-list-collections`, and the `claude-desktop-config`
    artifact (`vat mcp serve --print-config`), are no longer published.
  - The `vat-agent-authoring` skill is gone from the `vibe-agent-toolkit` plugin
    (`@vibe-agent-toolkit/vat-development-agents`).
  - Validation and refusal codes: `AGENT_MANIFEST_INVALID`, `AGENT_REFERENCE_MISSING`,
    `AGENT_REFERENCE_UNREADABLE`, `AGENT_RAG_NO_SOURCES`, `AGENT_MANIFEST_NOT_FOUND`,
    `AGENT_MANIFEST_UNREADABLE`, `AGENT_PACKAGE_ROOT_MISSING`, `AGENT_NAME_ESCAPES_SCOPE`.
  - `@vibe-agent-toolkit/utils/eslint`: `no-stdout-outside-writer` drops its `allowFiles` option
    (and the `staleAllow` message), and `no-literal-process-exit` drops its `allow` option; each
    rule's schema now refuses the key.
