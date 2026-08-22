# Response: `--baseline` control arm can execute the skill under test

**Status:** fixed on `worktree-baseline-control-isolation` (commit `7f1747d0`), unreleased.
**Your report:** `vat-baseline-control-defect-report.md`, 2026-08-22.
**Verdict:** confirmed on every load-bearing claim. Two causes you didn't find were worse than the ones you did, and both were vat's.

---

## 1. What you got right

Everything material. Verified against source, not taken on trust:

| Your claim | Confirmed |
|---|---|
| Only `pluginDirs` distinguishes the arms | `run-harness.ts:1174` |
| `staged/`, the assembled plugin dir and `workspaces/` are siblings under `--out` | `staging.ts:128,148`; `run-harness.ts:417,702` |
| No `--workdir`/`--out` combination mitigates it | `run-harness.ts:1510` |
| The control arm has unrestricted Bash | `spawn-claude.ts:30` — `--permission-mode bypassPermissions`, no allow/denylist |
| The docs overclaim | `vat-skill-testing.md:261`, `run.ts:1320` |

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
2. **Every eval gets a workspace**, empty when it declares no `files`. Both arms get the same one, so cwd is never a confound — and it is never the skill.
3. **Workspaces moved out of the harness root** to `<tmp>/vat-skill-test-ws-<token>/`, joining the grader and eval-hold dirs. They were a sibling of `staged/`; now `ls ..` from the control arm shows nothing. Returned as `workspacesPath` on the run result, since the token is random.
4. **`baselineIntegrity` in `baseline.json`** — your §9, the thing you said would have saved you. The WITHOUT arm's transcript is scanned for harness paths and declared executable names; findings land in `baseline.json` with per-eval evidence excerpts, plus a stderr warning. Written on **every** baseline run, so its absence means "predates this check", never "checked and clean".
5. **Docs corrected.** "The skill-absent arm has no tools to judge" was false and is gone. `--help` now says `A/B the skill's INSTRUCTIONS … not a capability control`.
6. **`--out` + `--workdir` now errors** instead of silently discarding `--workdir`. That silent-ignore was a second real bug, and you found it without noticing — your §7 note that the `--workdir` path "was never created at all" was the symptom.

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
