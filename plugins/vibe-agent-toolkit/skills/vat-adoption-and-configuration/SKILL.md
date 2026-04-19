---
name: vat-adoption-and-configuration
description: Use when starting a new VAT project, adding VAT to an existing repo, or orienting to `vibe-agent-toolkit.config.yaml`. Covers project setup, repo structure, package.json wiring, vibe-validate integration, and the npm postinstall hook.
---

# VAT Adoption and Configuration

This skill covers the top-level orientation for adopting VAT in a project: installing the CLI, the overall shape of `vibe-agent-toolkit.config.yaml`, repo structure conventions, vibe-validate integration, and how npm postinstall wires plugin registration. Per-section deep-dives live in the sibling skills listed below.

## Installing VAT

VAT ships as the `vibe-agent-toolkit` npm package with a `vat` CLI:

```bash
# Global install (most common during development)
npm install -g vibe-agent-toolkit

# Or run without installing
npx vibe-agent-toolkit <command>
bunx vibe-agent-toolkit <command>

# As a runtime dependency (recommended for published packages that ship skills)
npm install --save vibe-agent-toolkit
```

Once installed, `vat --help` lists the top-level command groups. `vat <group> --help` and `vat <group> <cmd> --help --verbose` cover the rest.

## Recommended Repo Structure

```
my-skills-project/
├── package.json                        # includes "vat" block (see below)
├── vibe-agent-toolkit.config.yaml      # single source of truth for VAT
├── resources/
│   ├── skills/                         # SKILL.md sources
│   │   ├── SKILL.md                    # router skill (optional, for multi-skill bundles)
│   │   └── my-skill.md
│   └── content/                        # non-skill markdown (RAG, collections)
├── agents/                             # TypeScript portable agents (optional)
│   └── my-agent/
│       ├── agent.yaml
│       └── src/
├── schemas/                            # JSON Schemas for resource collections
├── docs/                               # project documentation
└── dist/                               # generated (gitignored): vat build output
```

Three conventions are load-bearing:

1. **`vibe-agent-toolkit.config.yaml` at the project root** — VAT walks upward from the invocation directory to find it.
2. **SKILL.md files live under `resources/skills/`** — any path works, but this one is what `vat build` and `vat audit` expect by default.
3. **`dist/` is the only write target** — everything VAT generates goes there, and it's gitignored.

## `vibe-agent-toolkit.config.yaml` Shape

```yaml
version: 1

skills:
  include: ["resources/skills/SKILL.md", "resources/skills/*.md"]
  defaults:
    linkFollowDepth: 2
    excludeNavigationFiles: true
    targets: ['claude-code']
  config:
    my-skill:
      linkFollowDepth: 1

resources:
  collections:
    docs:
      include: ["docs/**/*.md"]
      validation:
        frontmatterSchema: "schemas/doc.schema.json"
        mode: permissive

claude:
  marketplaces:
    my-marketplace:
      owner: { name: "my-org" }
      publish:
        changelog: CHANGELOG.md
        readme: README.md
      plugins:
        - name: my-plugin
          description: "What this plugin does"
          skills: "*"

rag:
  stores:
    default:
      db: .rag-db/
      include: ["docs/**/*.md"]
```

Sections and the skills that own their details:

| Section | Owning skill |
|---|---|
| Top-level structure, `version`, section orientation | this skill (`vat-adoption-and-configuration`) |
| `skills:` (include, defaults, per-skill config, packagingOptions) | `vibe-agent-toolkit:vat-skill-authoring` |
| `resources:` (collections, schemas, validation modes) | `vibe-agent-toolkit:vat-knowledge-resources` |
| `claude:` (marketplaces, plugins, publish, owner) | `vibe-agent-toolkit:vat-skill-distribution` |
| `rag:` (stores, embedding providers) | `vibe-agent-toolkit:vat-rag` |

When adding to a section, load the owning skill rather than re-deriving the shape from this file.

## `package.json` Wiring

For projects that publish skills via npm, three fields tie VAT into the npm lifecycle:

```json
{
  "name": "@myorg/my-skills",
  "dependencies": {
    "vibe-agent-toolkit": "latest"
  },
  "scripts": {
    "build": "vat build",
    "postinstall": "vat claude plugin install --npm-postinstall || exit 0"
  },
  "vat": {
    "skills": ["my-skill-one", "my-skill-two"]
  }
}
```

- **`dependencies.vibe-agent-toolkit`** — runtime dep, not dev. Needed so the postinstall hook can find `vat`.
- **`scripts.postinstall`** — registers the built plugin into the user's `~/.claude/plugins/` tree after `npm install -g` or any install that runs lifecycle scripts. The `|| exit 0` keeps `npm install` from aborting if the hook can't run (unusual but defensive).
- **`vat.skills`** — declares which skill names this package ships. `vat verify` cross-checks this list against `skills.include` in `vibe-agent-toolkit.config.yaml`; mismatches fire `PACKAGE_JSON_LISTS_UNKNOWN_SKILL` / `PACKAGE_JSON_MISSING_SKILL`. The list is a packaging contract with npm, not a build input — `vat build` discovers skills from the config globs.

The full distribution pipeline (build, verify, npm publish, marketplace layout, managed settings) lives in `vibe-agent-toolkit:vat-skill-distribution`.

## vibe-validate Integration

If the project uses vibe-validate (recommended), wire VAT into the validation config:

```yaml
# vibe-validate.config.yaml (or relevant section)
phases:
  - name: vat-build-and-verify
    parallel: false
    commands:
      - name: vat build
        run: vat build
      - name: vat verify
        run: vat verify
```

`vat verify` runs the full artifact check (resources → skills → marketplace → consistency); it's the authoritative gate before `npm publish`. In this repo's own config, `bun run validate` already does this — adopters typically mirror the pattern.

## First-Time Setup Checklist

1. `npm install -g vibe-agent-toolkit` (or add to local deps)
2. `vat --help` — confirm the CLI resolves
3. Create `vibe-agent-toolkit.config.yaml` with the minimal `version: 1` plus the sections you need
4. Add `resources/skills/SKILL.md` or a kebab-case SKILL.md file and stage it in git (the skill discovery crawler uses `git ls-files` by default — untracked new files are skipped)
5. `vat skills validate` — report any issues before building
6. `vat build` — produces `dist/` artifacts
7. `vat verify` — full consistency check; should be a no-op when clean
8. If publishing: add the `vat.skills`, `scripts.postinstall`, and `dependencies.vibe-agent-toolkit` entries in `package.json` before `npm publish`

## When Things Are Off

- **"No skills section in config yaml"** — either the file isn't at the project root, or `skills.include` is missing.
- **"Found 0 skills"** — glob doesn't match any SKILL.md files. Confirm the path and that the files are tracked by git (VAT's discovery respects `.gitignore` and `git ls-files`).
- **`PACKAGE_JSON_LISTS_UNKNOWN_SKILL`** — `vat.skills` mentions a name not produced by `skills.include` discovery. Either add the file or remove the name.
- **`vat audit` fires unexpected warnings** — load `vibe-agent-toolkit:vat-audit` for the full audit surface, including `--compat` and `--exclude` flags.

## References

- `vibe-agent-toolkit:vat-skill-authoring` — SKILL.md frontmatter, body structure, references, packagingOptions
- `vibe-agent-toolkit:vat-agent-authoring` — TypeScript agent archetypes and runtime adapters
- `vibe-agent-toolkit:vat-skill-distribution` — `vat build` / `vat verify` / marketplace / npm publish
- `vibe-agent-toolkit:vat-knowledge-resources` — `resources:` collections and frontmatter schemas
- `vibe-agent-toolkit:vat-rag` — `rag:` stores, embedding providers, `vat rag index/query`
- `vibe-agent-toolkit:vat-audit` — `vat audit` for plugins, marketplaces, and installed skills
- `vibe-agent-toolkit:vat-skill-review` — pre-publication quality checklist
- Getting Started Guide — full setup walkthrough
