# Scope and migration

What belongs in the lab, what stays in vat, and the backlog of things to move.

Nothing here moves all at once. Each row is an independent migration with its own evidence, and the
lab is useful before any of them land.

## The boundary

One question decides it: **does this need vat's internals, or only vat's command line?**

| | Needs internals | Command line only |
|---|---|---|
| **Can compare two vat versions** | No — it lives inside exactly one | Yes |
| **Can measure a repo with no vat config** | Sometimes | Yes |
| **Can be stabilised and published** | No | Yes |
| **Where it lives** | vat's own test infrastructure | **the lab** |

That single test is why the lab is a separate CLI rather than a `vat` subcommand, and it is the test
to apply to anything proposed for either side.

## Migration backlog

### Moves into the lab

**`vat corpus scan` → the `sweep` facet.** Runs vat audit (and optionally skill review) across a
tracked plugin seed. Contributor research shipped in the adopter CLI.

> Evidence that it does not belong in the published CLI: its default seed path is `corpus/seed.yaml`,
> a repo-root path that ships in no package (`cli`'s `files` is `["dist", "docs", "README.md"]`). Run
> from any directory outside this repo it fails with `Seed file not found` and exit 2. It is in the
> default `vat --help`, has no entry in `packages/cli/docs/`, and is named in no agent-facing skill.
> It cannot work for anyone who installs vat.

**`corpus/seed.yaml` → the lab's corpus registry.** 236 tracked plugins, currently owned by nobody:
the Zod schema lives in `cli`, the generator lives in `dev-tools`, and the data sits at the repo
root in neither. `import-marketplace.ts` hand-mirrors the `PluginEntry` schema rather than importing
it — an accepted duplication exception sitting exactly on this seam, which the move either fixes or
entrenches.

**`packages/dev-tools/src/compat-empirical/` → the `calibrate` facet.** Already private, already has
its own corpus and its own `predict | run | judge | report` pipeline. Its corpus pins full 40-char
commit SHAs, which is the provenance discipline the lab wants everywhere.

**`import-marketplace.ts` → the lab, alongside the registry.** It is the registry's generator; it
should live with what it generates.

### Moves out of the CLI, but *not* into the lab

**`vat pipeline` → vat's own test infrastructure, and the public verb is deleted. ✅ Done.** The five
enumeration lanes and the parse-fact oracle reach internal builders directly —
`pipeline-oracles/lanes.ts` imports `crawlAndResolveRegistry` and `createProjectRegistry` from
agent-skills, `crawlSkillLinkRegistry` from claude-marketplace, and the resource loaders from cli.
That coupling is the instrument's whole purpose, and it means the oracle **can never compare two vat
versions**. Putting it in the lab would be putting a version-pinned tool inside a version-agnostic
one. So the three subcommands were removed from the CLI and nothing moved here: `src/pipeline-oracles/`
and `src/qa-snapshot/` stay exactly where they are, reachable only by writing a test, and stay under
`src/` rather than under `test/` because no test file in this repo is typechecked and their
compile-time exhaustiveness guards would assert nothing from there.

> Its three whole-command stdout/exit captures already go through `spawnSync` of the vat binary, so
> that third of the instrument *is* lab-shaped and is the piece still to move here, as an output-diff
> facet. The split is already latent in the existing artifact set. ⚠️ It has no caller at all today —
> `captureSnapshot`'s `includeCommands` is now only ever passed `false`, because `vat pipeline
> snapshot` was the one caller that passed `true`.
>
> Removing the verb recovers `dist/pipeline-oracles` + `dist/qa-snapshot` + `dist/commands/pipeline`
> from the published tarball. Measured with `npm pack --dry-run --json`, not `du -sk` — which pads
> every file to a 4 KB block and is what inflated the earlier estimate to "580 KB of 3,840 KB, 15%".
> The real figures: 36 files / 173 KB, 28 files / 162 KB and 16 files / 58 KB, against a whole
> `@vibe-agent-toolkit/cli` of 616 files / 2,401 KB unpacked. **393 KB of 2,401 KB — 16.4%** of what
> every adopter installs, for an instrument that by construction can never be stable. The first two
> are held out by `!dist/pipeline-oracles` / `!dist/qa-snapshot` in `cli`'s `files` array; the third
> is gone because its source is.

### Explicitly stays in vat

- **`packages/agent-skills/src/skill-source/git-clone.ts`** — a genuinely adopter-facing exported
  primitive that happens to be the engine of the corpus scanner. The lab consumes it; it does not
  move.
- **`packages/claude-marketplace/src/runtime-profiles.ts`** — load-bearing for the shipped
  `vat audit --compat` path. It does not move with the calibration harness, and the harness cannot
  falsify it (a `RuntimeObservation` carries no capability inventory). Closing that gap is a separate
  problem from this migration.
- **Everything adopter-facing** — `audit`, `validate`, `verify`, `build`, `resources`, `skills`,
  `rag`, `doctor`. The lab measures these; it does not absorb them.

## Instrumentation: where wall time and I/O counting live

These are two different answers, and the difference is not stylistic.

**Wall timings belong in vat**, as an adopter-facing flag. They cost nothing to collect, they are
meaningful without any lab-side interpretation, and "which phase is slow on my repo?" is a real user
question. vat already captures `wallMs` per command internally.

**I/O counting belongs in the lab**, via a `NODE_OPTIONS` preload, and *not* as a vat flag. Two
reasons, both structural:

1. A flag is parsed after the module graph has loaded, so it cannot observe the filesystem calls made
   during loading — and it would under-report silently, which is worse than not counting.
2. The raw count is uninterpretable without bucketing Node's own module loader out of it. Measured on
   `vat resources scan docs/`: 3,451 `realpathSync` calls, of which **3,450 are the ESM loader** and
   one is vat. The bucketing and call-site attribution are lab logic, not CLI logic.

What the preload counts is **Node `fs` calls, not kernel syscalls** — one `readFileSync` is several
syscalls and `readdirSync` is many. It is the layer vat can act on, which is the layer that matters,
but the reports must never call them syscalls loosely.
