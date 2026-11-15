# Vibe Agent Toolkit Packages

Every package in the monorepo, with its npm name, whether it publishes, and the workspace packages
it depends on (`dependencies` only — `workspace:*` edges as declared in each `package.json`). The
publish order is derived from those edges by `publishedPackagesInDependencyOrder()` in
`packages/dev-tools/src/workspace-graph.ts`; the layered
shape and the evolution plan are in [`docs/architecture/README.md`](../docs/architecture/README.md).
All packages share one version ([`docs/publishing.md`](../docs/publishing.md)).

| Package | npm name | Ships | Purpose | Depends on (workspace) |
|---|---|---|---|---|
| [`schema`](./schema/README.md) | `@vibe-agent-toolkit/schema` | yes | Shared VAT contracts: validation codes, issues, reports, exit codes, validation config and `package.json` `vat` metadata | — |
| [`utils`](./utils/README.md) | `@vibe-agent-toolkit/utils` | yes | Core utilities shared by every package, plus the ESLint rule pack on the `/eslint` subpath | — |
| [`discovery`](./discovery/README.md) | `@vibe-agent-toolkit/discovery` | yes | File discovery for Agent Skills and markdown resources | utils |
| [`resources`](./resources/README.md) | `@vibe-agent-toolkit/resources` | yes | Markdown resource parsing, validation, link integrity, the resource projection | schema, utils |
| [`projection-sqlite`](./projection-sqlite/README.md) | `@vibe-agent-toolkit/projection-sqlite` | yes | SQLite-backed projection store on Node's built-in `node:sqlite` | resources, utils |
| [`resource-compiler`](./resource-compiler/README.md) | `@vibe-agent-toolkit/resource-compiler` | yes | Compile markdown resources to TypeScript with full IDE support | resources, utils |
| [`rag`](./rag/README.md) | `@vibe-agent-toolkit/rag` | yes | Abstract RAG interfaces and shared implementations | resources, utils |
| [`rag-lancedb`](./rag-lancedb/README.md) | `@vibe-agent-toolkit/rag-lancedb` | yes | LanceDB implementation of the RAG interfaces (opt-in backend) | rag, resources, utils |
| [`agent-skills`](./agent-skills/README.md) | `@vibe-agent-toolkit/agent-skills` | yes | Build, validate and package skills in the Agent Skills format | resources, schema, utils |
| [`claude-marketplace`](./claude-marketplace/) | `@vibe-agent-toolkit/claude-marketplace` | yes | Claude plugin marketplace tools: compatibility analysis, provenance, enterprise settings (no README yet) | agent-skills, resources, schema, utils |
| [`cli`](./cli/README.md) | `@vibe-agent-toolkit/cli` | yes | The `vat` command-line interface — orchestrates the packages above | agent-skills, claude-marketplace, discovery, projection-sqlite, resources, schema, utils |
| [`vat-development-agents`](./vat-development-agents/README.md) | `@vibe-agent-toolkit/vat-development-agents` | yes | The `vibe-agent-toolkit` plugin of agent-facing skills — VAT dogfooding itself | cli, schema |
| [`vibe-agent-toolkit`](./vibe-agent-toolkit/README.md) | `vibe-agent-toolkit` | yes | Umbrella package — installs the CLI and the VAT skills plugin | cli, vat-development-agents |
| [`dev-tools`](./dev-tools/) | `@vibe-agent-toolkit/dev-tools` | **private** | Monorepo tooling: validation gates, version bumps, publishing, duplication checks (no README; `src/` is the index) | agent-skills, claude-marketplace, resources, utils |
| [`lab`](./lab/README.md) | `@vibe-agent-toolkit/lab` | **private** | Quality lab — `vat-lab`: report on a project and compare across projects, versions and vat builds | utils |

The dependency direction is one way: `utils`/`schema` at the bottom, `resources` above them, `agent-skills`/`claude-marketplace` above those, and `cli` at the top — no package
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
