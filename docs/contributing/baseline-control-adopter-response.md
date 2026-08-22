# Response: `--baseline` control arm can execute the skill under test

**Status:** fixed on `worktree-baseline-control-isolation` (commit `7f1747d0`), unreleased.
**Your report:** `vat-baseline-control-defect-report.md`, 2026-08-22.
**Verdict:** confirmed on every load-bearing claim. Two causes you didn't find were worse than the ones you did, and both were vat's.

---

## 1. What you got right

Everything material. Verified against source, not taken on trust:

| Your claim | Confirmed |
|---|---|
Cited by symbol, not line number — the commit that fixes these rewrites the files, so line
citations rot the moment they are written.

| Only `pluginDirs` distinguished the arms | `runEvalWorker` in `run-harness.ts` |
| `staged/`, the assembled plugin dir and `workspaces/` were siblings under `--out` | `stageOneItem`/`buildResolveCtx` in `staging.ts`, `stageWorkspacesForRun` in `run-harness.ts` |
| No `--workdir`/`--out` combination mitigates it | `resolveHarnessLocation` in `run-harness.ts` |
| The control arm has unrestricted Bash | `assembleClaudeArgs` in `spawn-claude.ts` — `--permission-mode bypassPermissions`, no allow/denylist |
| The docs overclaim | the `toolExpectations` section of `vat-skill-testing.md`; the `--baseline` option in `run.ts` |

Your §7 was also right on all three counts, including the retraction: `pluginDirs: []` + `--setting-sources ""` *does* correctly suppress the installed plugin cache. Your first hypothesis was wrong and you caught it yourself.

## 2. What you missed — and it lets you stop blaming your own prompts

You concluded the control arm went looking and found the bundle. It didn't have to. **vat handed it the address.**

`buildExecutorPrompt` (`executor-prompt.ts:27`) appended, unconditionally, to *both* arms:

```
The relevant files are located at <staged subject dir>.
```

And when an eval declares no input `files`, `resolvePerEvalWorkspaceDir` returned `undefined`, so `eval-executor.ts:62` fell back to `workDir = subjectStagedDir` — **the control arm's working directory was the staged skill.**

The consequence is stronger than either of us stated. The staged dir holds the SKILL.md *and* the executable. A control arm that is told that path, or parked in it, can recover the **entire treatment** — instructions included — with one `cat`. The old setup didn't weakly isolate the prose; it isolated neither half. The measurement wasn't degraded, it was undefined.

**So drop the self-blame in your §4.** You wrote that one of your suites named a path and that this was "partly the consumer's fault." For the suite that named nothing, vat was writing that line into your prompt for you. That is the whole explanation for the contaminated result you couldn't account for.

## 3. What changed

1. **The skill-absent arm is no longer told where the subject is staged.** Its prompt carries the task and its own workspace, nothing else.
2. **Every eval gets a workspace**, empty when it declares no `files`, and **each arm gets its own copy** at `<workspacesRoot>/<arm>/<id>`. Both arms start byte-identical, so cwd is never a confound — and it is never the skill.

   The per-arm split was added in a third round, after a review found the sharpest defect in this whole report and one that no amount of auditing "what does vat hand this process" would have surfaced. The two arms of an eval are queued adjacently into a bounded-parallel pool, so **they run at the same time**. While they shared one directory, the control arm could `ls`, find whatever the treatment arm had just written, and answer from it — scoring like the treatment, collapsing the delta to zero, and leaving a transcript with no harness path anywhere in it for the detector to catch. Each arm's cwd was correct in isolation and wrong as a pair. If your Suite 2 inversion (control 24 vs treatment 22) has a mechanical explanation rather than grader variance, **this is the first candidate worth testing** — a control arm reading a half-written treatment artifact can plausibly score anywhere, including above it.
3. **Workspaces moved out of the harness root** to `<tmp>/vat-skill-test-ws-<token>/`, joining the grader and eval-hold dirs. They were a *child* of the harness root; they are now a *sibling* of it under the OS temp dir. To be precise about what that does and does not buy: `ls ..` from the control arm still shows the temp dir, which contains `vat-skill-test/` — this raises the cost of a reach from "look down" to "climb and guess a name", it does not make the skill unreachable. That residual relative reach is exactly what the contamination detector in (4) is matched against. Returned as `workspacesPath` on the run result and printed by the CLI, since the token is random and cannot be derived.

4. **The control arm's environment is scrubbed.** Added after review: the first version of this fix closed the prompt, argv and cwd channels and left the fourth open. The run assembles one environment and handed it to both arms, `CLAUDE_PLUGIN_ROOT` included — which points at the staged plugin root, so `env | grep CLAUDE` recovered the whole treatment for any plugin-distributed skill. The control arm now drops that key and any declared `env:` value containing the harness root.
5. **`baselineIntegrity` in `baseline.json`** — your §9, the thing you said would have saved you. The WITHOUT arm's transcript is scanned for harness paths and declared executable names; findings land in `baseline.json` with per-eval evidence excerpts, plus a stderr warning. Written on **every** baseline run, so its absence means "predates this check", never "checked and clean". Both sides of the match are normalized, and the harness signal matches a path *suffix* rather than one literal spelling — without that it was dead on Windows (separator direction), a coin-flip on macOS (`$TMPDIR` vs the realpath), and blind to the relative reach described in (3) everywhere.

   Round three widened this again, and the reason is worth stating because it bears on how much the flag is worth to you. The suffix needle was `vat-skill-test/<8-hex-key>` — which requires the control arm to *spell the key*. It has no way to know it and no reason to type it; every natural reach enumerates instead (`cat ../../vat-skill-test/*/staged/SKILL.md`, `find ../../vat-skill-test -name SKILL.md`, `K=$(ls ../../vat-skill-test)`). **A single `*` defeated the entire scheme.** The needle set now also carries vat's own harness directory name, matched at a path boundary so the arm's legitimate `vat-skill-test-ws-<token>` workspace is not evidence against it. Case is folded on every platform, not just Windows — macOS ships case-insensitive APFS, so a case-shifted reach *succeeds on the filesystem* and used to read clean.
6. **Docs corrected.** "The skill-absent arm has no tools to judge" was false and is gone. `--help` now says `A/B the skill's INSTRUCTIONS … not a capability control`.
7. **`--out` + `--workdir` now errors** instead of silently discarding `--workdir`. That silent-ignore was a second real bug, and you found it without noticing — your §7 note that the `--workdir` path "was never created at all" was the symptom. `--out` is also resolved to an absolute path now; a relative one used to become the detector's needle and match nearly everything.

### One caveat you should know about, because it affects your verification

The ambient-copy half of the detector keys off your skill's **declared executables**, and that manifest only resolves for a *declared* subject — a skill name, or a path that maps back to one. Pointing `vat skill test run` at an already-built `./dist/skills/<name>/` resolves as a plain source path with no manifest, so that signal is off and only the harness-path signal remains. Prefer the skill **name** when you re-run, or the block will under-report.

**And a limit you should hold the flag against.** For an **instruction-only skill — one that ships no executables — the detector has no ambient-copy signal at all.** Both remaining classes of ambient copy (your own repo/build output, your installed plugin cache) produce no harness path and no executable name, so a control arm that runs `grep -rl "<a distinctive phrase from your SKILL.md>" .` and reads the hit is invisible to this check. `contaminated: false` therefore means "vat saw no evidence", never "vat verified there was none". Closing that needs content needles lifted from the staged SKILL.md, which is not built. If your skill is instruction-only, the flag is currently a check on vat's own hygiene rather than a check on your environment — weigh it accordingly, and consider running the baseline from a directory that does not contain a copy of the skill.

## 4. Where I did not follow your recommendation

You ranked containerizing the control arm as "the only fix that makes the claim true." I'm not doing that, and I think the framing is wrong.

There are two different measurements:

- **A — is my prose worth anything?** Both arms can reach a tool; only one gets the instructions.
- **B — is my skill worth anything?** Control has neither.

B needs mount-level isolation, and it *still* fails while your repo has a built copy on disk — so a container buys the strong claim only in a setup nobody actually runs. A is a real, useful question, and after the changes above vat delivers it honestly: the control is denied the declaration, is told nothing, and stands nowhere near vat's copies. So vat now measures A and **says** it measures A, rather than claiming B and delivering neither.

The detector is what covers the gap, and it's why it's the piece that matters most: it flags exactly the case no amount of vat-side isolation can prevent — a copy **you** own.

## 5. Your part, and how to verify

Two ambient copies remain reachable, and they're yours:

1. your repo's build output (`dist/skills/<name>/scripts/…`)
2. the installed plugin cache (vat suppresses *discovery* of this, but the files are on disk)

**Verify the fix against your own suites, using `VAT_ROOT_DIR` to point at this build:**

```bash
# In the vat checkout
git fetch origin && git checkout worktree-baseline-control-isolation
bun install && bun run build

# In your repo, with vat resolved from that tree
export VAT_ROOT_DIR=/path/to/vibe-agent-toolkit
vat skill test run <skill> --baseline --i-understand-this-runs-skill-code \
  --auth subscription --model claude-haiku-4-5 --out <dir>

jq '.baselineIntegrity' <dir>/results/baseline.json
```

Read it like this:

- **`contaminated: false` and the delta stays near zero** → the skill genuinely isn't lifting on those expectations. That's a real finding about the skill, and now a trustworthy one.
- **`contaminated: false` and the delta opens up** → the old numbers were the artifact. Your original read ("this skill is nearly worthless") was the contamination talking.
- **`contaminated: true`** → an ambient copy of yours is still reachable. `findings[].hits[].excerpt` names the path. Re-run against a tree with no built copy, or uninstall the plugin, then re-read.

**One thing to fix on your side regardless:** the suite whose prompt names `${CLAUDE_SKILL_DIR}/scripts/tool.mjs`. No harness change can help there — you're handing the control arm the answer in the prompt text. Describe the *task*, never the *mechanism*. That also makes the WITH arm a real test of whether your skill routes the model correctly, which is what you wanted to measure in the first place.

## 6. Your Suite 2 is a separate, live question

The control arm scoring **24 vs 22** is not explained by this defect and I have not fixed it. Contamination explains a *missing* delta — if both arms hold the tool, expect parity. It does not explain the control *winning*.

Two candidates: your SKILL.md prose is genuinely making the model worse on those expectations, or it's grader variance at n=1. The first would be the most valuable finding in your whole report. Re-run Suite 2 on the fixed harness with a clean `baselineIntegrity` and, if the inversion survives, please file it — that one is about your skill, not about vat.

## 7. On the part of your report I'd most like you to keep writing

Your §5 — the six ways a silently-wrong number damaged you specifically — is why this got fixed at this depth rather than as a docs patch. "A silently-wrong measurement is worse for me than a missing one" is the correct design principle and it drove the whole shape of the response: not just closing the hole vat owned, but making the hole vat *cannot* own announce itself.

The retractions weren't the failure. Publishing a wrong root cause and then correcting it in the same document is what made the second look possible.
