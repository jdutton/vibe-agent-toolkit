# Distributing VAT Skills

**Guide for package authors publishing VAT skills as an npm package.** The procedural runbook —
config keys, build phases, marketplace publishing, postinstall, `vat.replaces`, `--target claude-web`
— is owned by the `vat-skill-distribution` skill
([`packages/vat-development-agents/resources/skills/vat-skill-distribution.md`](../../packages/vat-development-agents/resources/skills/vat-skill-distribution.md)),
which ships in the `vibe-agent-toolkit` plugin and is dogfooded by `vat verify`. This page is the
orientation: what the pieces are, which command does what, and the mistakes the old version of this
page taught.

## The three surfaces

| Surface | Role | Owns |
|---|---|---|
| `SKILL.md` frontmatter | Portable skill metadata | Name, description, triggers — the standard schema, never a VAT field |
| `vibe-agent-toolkit.config.yaml` | VAT source of truth | Skill discovery globs, per-skill packaging (`skills.config.<name>`), plugins and marketplaces (`claude:`) |
| `package.json` `vat` | npm packaging hint | `vat.skills`: the **names** of the skills this package ships (strings, not objects); checked by `vat verify`, never read by `vat build` |

Rationale: [`architecture/skill-packaging.md`](../architecture/skill-packaging.md#who-owns-what-skillmd-configyaml-packagejson).

## Quick start

**1. `package.json`** — `vat.skills` lists skill names; `vibe-agent-toolkit` is a runtime dependency
so `vat` is on PATH during `postinstall`:

```json
{
  "name": "@your-org/your-skills",
  "version": "1.0.0",
  "vat": { "version": "1.0", "skills": ["my-skill"] },
  "dependencies": { "vibe-agent-toolkit": "latest" },
  "scripts": {
    "build": "vat build",
    "postinstall": "vat claude plugin install --npm-postinstall 2>/dev/null || exit 0"
  },
  "files": ["dist", "README.md"]
}
```

`vat.version` is the metadata schema version string (`"1.0"`). `vat.type` is deprecated, optional
and read by nothing — omit it. `vat.agents`, `vat.pureFunctions` and `vat.runtimes` are accepted by
the schema but no install path consumes them yet.

**2. `vibe-agent-toolkit.config.yaml`** — where every skill and plugin is declared:

```yaml
skills:
  include: ["resources/skills/**/SKILL.md"]
  config:
    my-skill:
      linkFollowDepth: 1          # packaging options live HERE, per skill
claude:
  marketplaces:
    my-marketplace:
      owner: { name: My Organization }
      plugins:
        - name: my-plugin
          skills: "*"             # required: "*" or a list of skill names
```

**3. Build and verify:** `vat build` (skills phase → claude plugin phase, into `dist/`), then
`vat verify` (validates the built artifacts and cross-checks `vat.skills` against config).

**4. Publish:** `npm publish` (`--tag next` for a pre-release), or publish the marketplace branch with
`vat claude marketplace publish` so users install with `/plugin marketplace add owner/repo#branch`.

## Which install command

Two installers exist and they write to different places:

| Command | Writes to | Use for |
|---|---|---|
| `vat claude plugin install <npm:pkg \| dir \| zip>` | `~/.claude/plugins/` when the package ships a built marketplace (`dist/.claude/plugins/marketplaces/`), else `~/.claude/skills/` | Claude Code. Runs automatically from `postinstall` (`--npm-postinstall`, global installs only). `--dev` symlinks `dist/skills/` so rebuilds show up after `/reload-plugins`; `--build` builds first. For a claude.ai upload, package instead: `vat skills package ./SKILL.md -o ./dist/ --target claude-web`. |
| `vat skills install <source> --target <t> --scope <user\|project>` | The target's skill directory (`claude`, `codex`, `copilot`, `gemini`, `cursor`, `windsurf`, `agents`; e.g. `~/.claude/skills/` or `.claude/skills/`) | Any of the seven platforms. **Both `--target` and `--scope` are required** — there are no defaults. |

Inspect what is installed with `vat skills list --user` (reads `~/.claude` only) and
`vat claude plugin list`. Remove a plugin with `vat claude plugin uninstall <plugin@marketplace>`
(`--all` for every plugin the current package installed); skills installed flat into a skills
directory are not registered as plugins — delete the directory. There is no `vat skills uninstall`.

## Packaging options

`skills.config.<name>` in `vibe-agent-toolkit.config.yaml` (never `package.json`) controls what a
skill bundles:

- `linkFollowDepth`: `0` (SKILL.md only), `1` (direct links), `2` (direct + one transitive level,
  the default), `N`, or `"full"`. Non-markdown assets linked from bundled files always ship.
- `excludeReferencesFromBundle`: ordered `rules` of glob `patterns` (relative to the **project**
  root) with a Handlebars `template` for the rewritten link, plus a `defaultTemplate` for
  depth-exceeded links (default `{{link.text}}`). Template context: `link.text`, `link.href`,
  `link.fragment`, `link.type`, `link.resource.id|fileName|relativePath`, `skill.name`.
- `files`: explicit source→dest entries for build artifacts and unlinked files.
- `publish: false` (per skill, or once under `skills.defaults`): an in-place skill — validated at
  source, never built into `dist/skills/`, never expected by `vat verify`. Plugin-local skills ship
  with their plugin regardless.
- `resourceNaming`, `validation` (severity overrides / allow entries), `targets`.

The full key reference is in the `vat-skill-authoring` skill; every finding a build can raise is in
[`validation-codes.md`](../validation-codes.md).

## Mistakes this page used to teach

- `vat.skills` as objects (`{name, source, path, packagingOptions}`) — the schema is an array of
  name strings; packaging lives in config.yaml.
- `vat skills install npm:pkg` with no flags — exits 2; `--target` and `--scope` are required, and
  `--dev` / `--build` / `--npm-postinstall` belong to `vat claude plugin install`.
- `vat skills uninstall`, `vat skills list --installed`, `--project` — none exist; see the table.
- "`vat skills build` reads `vat.skills`" — it reads the config.yaml globs.
- "Skills install to `~/.claude/plugins/<skill-name>`" — nothing writes there; plugins land under
  `~/.claude/plugins/marketplaces/<mp>/…` and flat skills under `~/.claude/skills/<name>`.

## References

- [`marketplace-distribution.md`](./marketplace-distribution.md) — marketplace publishing in depth
- [`packages/vat-development-agents`](../../packages/vat-development-agents/README.md) and
  [`packages/vat-example-cat-agents`](../../packages/vat-example-cat-agents/README.md) — real packages
- [Claude Code Skills](https://code.claude.com/docs/en/skills) · [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
