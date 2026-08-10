# Content routing: where a new statement belongs

When you're about to add a sentence to a `CLAUDE.md`, this is the decision procedure. Without it,
placement is improvisation — and improvisation is how root `CLAUDE.md` ends up carrying content that
belongs in a package doc, paying its cost on every session in the repo regardless of what that session
touches.

⚠️ **Not the same "routing" as [`docs/guides/skill-files-and-routing.md`](../guides/skill-files-and-routing.md).**
That doc routes file *types* into packaged-skill subdirectories at build time. This doc routes *prose
statements* to their home in the source tree. Don't let the shared word cause a session to open the
wrong one.

## The routing table

| Content kind | Home | Loads | Ships outside the repo |
| --- | --- | --- | --- |
| Universal engineering rule | root [`CLAUDE.md`](../../CLAUDE.md) | always | no |
| Subtree-scoped rule | `.claude/rules/<name>.md` with `paths:` | on glob match | no |
| Local code seam / footgun for one directory | that directory's `CLAUDE.md` | lazily, on subtree read | no |
| Cross-cutting or component concept — "what is X" | `docs/concepts/` | on demand | no |
| Engineering practice — "how we do X" | `docs/guides/` | on demand | no |
| Architectural shape and evolution plan | `docs/architecture/` | on demand | no |
| Design authority with history | `docs/superpowers/specs/` | on demand | no |
| Implementation plan / phase state | `docs/superpowers/plans/` or git history | n/a | no |
| Working-on-VAT-itself material (debugging, install internals) | `docs/contributing/` | on demand | no |
| Deep mechanics, worked examples, long code samples for one package | `packages/<pkg>/docs/<topic>.md` | on demand | no |
| Author-facing capability | the skill — `SKILL.md` + `resources/` | on demand | **yes** |
| One-run metric, personal attribution, PR reference, commit SHA, status date | **delete** | n/a | n/a |

VAT has no ADR directory today — an architectural *decision* (as opposed to the current shape) has no
dedicated home yet and currently lands as prose in `docs/architecture/*.md` or the owning spec. That's
a known gap, not a resolved routing choice; don't invent an ADR mechanism to fill it as a side effect
of a routing pass.

## The extraction procedure

**A block is not the unit of routing; a statement is.** Split any block that mixes kinds — a rule
wrapped in status narrative, a footgun warning next to a worked example — into its statements first,
then route each one independently.

For any statement in a `CLAUDE.md`, apply in order. First match wins **per statement**, so a block
whose opening line is contraband never carries a rule out with it.

1. **Contraband** — planning reference, personal attribution, PR/issue reference, commit SHA, bare
   status date, one-run metric? → **delete it.** Git holds it.
2. **A rule applying beyond this directory?** → root `CLAUDE.md`, or `.claude/rules/<name>.md` if it's
   scoped to files matching a glob. Leave a one-line pointer behind only when the local reader needs
   the reminder to find it.
3. **"What is X" / cross-cutting concept orientation?** → `docs/concepts/`.
4. **"How we do X" engineering practice?** → `docs/guides/`.
5. **Deep mechanics, worked examples, long code for one package?** → that package's `docs/<topic>.md`.
6. **An author-facing capability that ships?** → the skill, never hand-authored into a second place.
7. **A guard governing *creation* of a new file?** → stays inline in the CLAUDE.md nearest the
   creation point. A `paths:` rule fires on a *read* of an existing matching file — it can never fire
   at the moment a new file is being written, so this class can never move to `.claude/rules/`.
8. **None of the above?** → it stays **only** if it prevents a specific mistake someone editing this
   directory makes. Otherwise delete it — after confirming the statement still has a home a real
   session would reach.

The order is load-bearing: contraband is removed first because removing it frequently brings an
over-budget file back under budget without touching a single rule.

## Two rulings, carried over unchanged

- **Decision history that isn't in a spec isn't a category.** Design exploration folds into the spec
  that owns it; a decision with no spec home is a signal the spec is incomplete, not that `CLAUDE.md`
  should hold it.
- **A contract number is not a one-run metric.** A durable invariant — a count code enforces — belongs
  in code as a named constant, and docs cite the constant, never the number. A measurement that must
  persist belongs in the owning spec's evidence trail, dated.

## Reachability is the gate this depends on

Relocating a statement out of an always-loaded file only helps if something still reaches it. Two
failure modes to check before relocating:

- **The destination is itself unreachable.** A page linked from nowhere is functionally deleted, not
  relocated — verify the destination has an inbound link from a page a real session opens.
- **The trigger doesn't actually fire.** A `.claude/rules/<name>.md` file with a typo'd or missing
  `paths:` glob validates as a normal markdown file and silently never activates — see
  [`docs/guides/collection-validation.md`](../guides/collection-validation.md) for the `claude-rules`
  collection that now catches this at `vat resources validate` time.
