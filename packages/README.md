# Vibe Agent Toolkit Packages

Every package in the monorepo, with its npm name, whether it publishes, and the workspace packages
it depends on (`dependencies` only — `workspace:*` edges as declared in each `package.json`). The
publish order is derived from those edges by `publishedPackagesInDependencyOrder()` in
`packages/dev-tools/src/workspace-graph.ts`; the layered
shape and the evolution plan are in [`docs/architecture/README.md`](../docs/architecture/README.md).
All packages share one version ([`docs/publishing.md`](../docs/publishing.md)).

| Package | npm name | Ships | Purpose | Depends on (workspace) |
|---|---|---|---|---|
| [`schema`](./schema/README.md) | `@vibe-agent-toolkit/schema` | yes | JSON Schema definitions and TypeScript types for the VAT agent manifest format; the validation-code registry | — |
| [`utils`](./utils/README.md) | `@vibe-agent-toolkit/utils` | yes | Core utilities shared by every package, plus the ESLint rule pack on the `/eslint` subpath | — |
| [`discovery`](./discovery/README.md) | `@vibe-agent-toolkit/discovery` | yes | File discovery for VAT agents and Agent Skills | utils |
| [`resources`](./resources/README.md) | `@vibe-agent-toolkit/resources` | yes | Markdown resource parsing, validation, link integrity, the resource projection | schema, utils |
| [`projection-sqlite`](./projection-sqlite/README.md) | `@vibe-agent-toolkit/projection-sqlite` | yes | SQLite-backed projection store on Node's built-in `node:sqlite` | resources, utils |
| [`resource-compiler`](./resource-compiler/README.md) | `@vibe-agent-toolkit/resource-compiler` | yes | Compile markdown resources to TypeScript with full IDE support | resources, utils |
| [`rag`](./rag/README.md) | `@vibe-agent-toolkit/rag` | yes | Abstract RAG interfaces and shared implementations | resources, utils |
| [`rag-lancedb`](./rag-lancedb/README.md) | `@vibe-agent-toolkit/rag-lancedb` | yes | LanceDB implementation of the RAG interfaces (opt-in backend) | rag, resources, utils |
| [`agent-config`](./agent-config/README.md) | `@vibe-agent-toolkit/agent-config` | yes | Agent manifest loading and validation | schema, utils |
| [`agent-runtime`](./agent-runtime/README.md) | `@vibe-agent-toolkit/agent-runtime` | yes | Runtime framework for building and executing portable agents | schema, utils |
| [`runtime-claude-agent-sdk`](./runtime-claude-agent-sdk/README.md) | `@vibe-agent-toolkit/runtime-claude-agent-sdk` | yes | Claude Agent SDK runtime adapter | agent-runtime, claude-marketplace |
| [`runtime-langchain`](./runtime-langchain/README.md) | `@vibe-agent-toolkit/runtime-langchain` | yes | LangChain.js runtime adapter | agent-runtime |
| [`runtime-openai`](./runtime-openai/README.md) | `@vibe-agent-toolkit/runtime-openai` | yes | OpenAI SDK runtime adapter | agent-runtime |
| [`runtime-vercel-ai-sdk`](./runtime-vercel-ai-sdk/README.md) | `@vibe-agent-toolkit/runtime-vercel-ai-sdk` | yes | Vercel AI SDK runtime adapter | agent-runtime |
| [`agent-skills`](./agent-skills/README.md) | `@vibe-agent-toolkit/agent-skills` | yes | Build, validate and package skills in the Agent Skills format | agent-config, resources, schema, utils |
| [`claude-marketplace`](./claude-marketplace/) | `@vibe-agent-toolkit/claude-marketplace` | yes | Claude plugin marketplace tools: compatibility analysis, provenance, enterprise settings (no README yet) | agent-skills, resources, schema, utils |
| [`transports`](./transports/README.md) | `@vibe-agent-toolkit/transports` | yes | Transport adapters for conversational agents | agent-runtime |
| [`gateway-mcp`](./gateway-mcp/README.md) | `@vibe-agent-toolkit/gateway-mcp` | yes | MCP gateway exposing VAT agents through the Model Context Protocol | schema |
| [`cli`](./cli/README.md) | `@vibe-agent-toolkit/cli` | yes | The `vat` command-line interface — orchestrates the packages above | agent-config, agent-skills, claude-marketplace, discovery, gateway-mcp, projection-sqlite, resources, schema, utils |
| [`vat-development-agents`](./vat-development-agents/README.md) | `@vibe-agent-toolkit/vat-development-agents` | yes | The `vibe-agent-toolkit` plugin of agent-facing skills — VAT dogfooding itself | cli, schema |
| [`vat-example-cat-agents`](./vat-example-cat-agents/README.md) | `@vibe-agent-toolkit/vat-example-cat-agents` | yes | Example agents demonstrating VAT patterns across every runtime adapter | agent-runtime, schema, transports |
| [`vibe-agent-toolkit`](./vibe-agent-toolkit/README.md) | `vibe-agent-toolkit` | yes | Umbrella package — installs the CLI and the development agents | cli, vat-development-agents |
| [`dev-tools`](./dev-tools/) | `@vibe-agent-toolkit/dev-tools` | **private** | Monorepo tooling: validation gates, version bumps, publishing, duplication checks (no README; `src/` is the index) | agent-skills, claude-marketplace, resources, utils |
| [`lab`](./lab/README.md) | `@vibe-agent-toolkit/lab` | **private** | Quality lab — `vat-lab`: report on a project and compare across projects, versions and vat builds | utils |
| [`test-agents`](./test-agents/README.md) | `@vibe-agent-toolkit/test-agents` | **private** | Minimal agents for exercising the runtime adapters in tests | agent-runtime |

The dependency direction is one way: `utils`/`schema` at the bottom, `resources` and the runtime
core above them, `agent-skills`/`claude-marketplace` above those, and `cli` at the top — no package
depends on `cli` except the two that ship it (`vat-development-agents`, the umbrella).

## Installation

```bash
npm install -g vibe-agent-toolkit          # everything, including the vat CLI
npm install -g @vibe-agent-toolkit/cli     # the CLI alone
```

RAG backends are opt-in: `@vibe-agent-toolkit/rag-lancedb` installs separately (see the
[RAG usage guide](../docs/guides/rag-usage-guide.md)).

## Adding a package

[`docs/contributing/extending-the-monorepo.md`](../docs/contributing/extending-the-monorepo.md) —
including the standard script set and generated tsconfig references `validate-structure` enforces.
