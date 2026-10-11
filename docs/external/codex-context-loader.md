# OpenAI Codex CLI — the project-instructions loader (`AGENTS.md`)

> **Source:** `github.com/openai/codex`, default branch `main`, commit
> **`1cc7e2361237ce7244430ee1d581c77f95c57ac8`** (committed 2026-09-28T01:10:27Z). Every code block
> below is a VERBATIM excerpt of that commit, cited as `path:start-end`; elided spans are marked
> `/* … */` (Rust) or `…`. Read over `raw.githubusercontent.com/openai/codex/<sha>/…` and `gh api`.
> **Read:** 2026-09-27 (local date; the commit timestamp is UTC).
>
> **Files read at that SHA:**
> `codex-rs/core/src/agents_md.rs` (the loader, 562 lines, whole file) ·
> `codex-rs/core/src/agents_md_manager.rs` (refresh/caching) ·
> `codex-rs/codex-home/src/instructions/mod.rs` (the global `$CODEX_HOME/AGENTS.md` provider) ·
> `codex-rs/ext/extension-api/src/user_instructions.rs` (provider contract) ·
> `codex-rs/core/src/context/user_instructions.rs` + `codex-rs/context-fragments/src/fragment.rs`
> (rendering) · `codex-rs/core/src/context/world_state/agents_md.rs` + its `.snap` (re-injection) ·
> `codex-rs/file-system/src/find_up.rs` (root-marker search) ·
> `codex-rs/config/defaults.toml`, `codex-rs/config/src/config_toml.rs`,
> `codex-rs/core/src/config/mod.rs` (config keys) · `codex-rs/core/src/session/session.rs`,
> `codex-rs/core/src/session/mod.rs` (call sites) · `codex-rs/cli/src/main.rs` (provider wiring) ·
> `codex-rs/protocol/src/prompts/base_instructions/default.md` (the model's own AGENTS.md prompt) ·
> tests: `codex-rs/core/src/agents_md_tests.rs`, `codex-rs/core/tests/suite/agents_md.rs`,
> `codex-rs/core/tests/suite/agents_md_refresh.rs` · docs: `docs/agents_md.md`, `docs/config.md`
> (both are now one-line redirects to developers.openai.com), and the page they point to,
> `https://developers.openai.com/codex/guides/agents-md` → 308 →
> `https://learn.chatgpt.com/docs/agent-configuration/agents-md` (fetched 2026-09-27).
>
> @vendor-claim reviewed=2026-09-27 verify=Resolve the current `main` SHA of openai/codex (`gh api repos/openai/codex/commits/main --jq .sha`), fetch `codex-rs/core/src/agents_md.rs`, `codex-rs/core/src/agents_md_manager.rs`, `codex-rs/codex-home/src/instructions/mod.rs`, `codex-rs/core/src/context/user_instructions.rs` and `codex-rs/config/defaults.toml` at it, re-find each excerpt by its anchor (`AGENTS_MD_SEPARATOR`, `project doc exceeds remaining budget; truncating`, `fn candidate_filenames`, `refresh_repository`, `# AGENTS.md instructions`, `project_doc_max_bytes = 32768`), diff against this file, and update the SHA and every changed excerpt
>
> **Refresh policy:** re-read on any Codex release that touches `agents_md*.rs`, or every ~90 days,
> whichever is sooner. Sibling cache for Claude Code:
> [`claude-code-memory-loader.md`](claude-code-memory-loader.md).

## Why this cache exists

VAT models what a harness loads from a repository's instruction files. For Claude Code that model
is transcribed from the binary. Codex is open source, so this file transcribes its loader from
source at a pinned commit, to the same bar: every behavioural claim carries the excerpt that
decides it, and anything the source does not settle is listed under **Unknowns**.

The module's own summary (it is accurate against the code below, except that it omits
`AGENTS.override.md` and the byte budget):

```rust
// codex-rs/core/src/agents_md.rs:1-18
//! AGENTS.md discovery and user instruction assembly.
//!
//! Project-level documentation is primarily stored in files named `AGENTS.md`.
//! Additional fallback filenames can be configured via `project_doc_fallback_filenames`.
//! Fallback entries containing path syntax for the executor's OS are ignored
//! before any filesystem probes use them.
//! We include the concatenation of all files found along the path from the
//! project root to the current working directory as follows:
//!
//! 1.  Determine the project root by walking upwards from the current working
//!     directory until a configured `project_root_markers` entry is found.
//!     When `project_root_markers` is unset, the default marker list is used
//!     (`.git`). If no marker is found, only the current working directory is
//!     considered. An empty marker list disables parent traversal.
//! 2.  Collect every `AGENTS.md` found from the project root down to the
//!     current working directory (inclusive) and concatenate their contents in
//!     that order.
//! 3.  We do **not** walk past the project root.
```

## 1. Filenames and precedence within one directory

> @vendor-claim reviewed=2026-09-27 verify=Re-read `fn candidate_filenames` and the per-directory probe loop in `codex-rs/core/src/agents_md.rs` at the current SHA; confirm the order override → AGENTS.md → fallbacks and first-regular-file-wins

```rust
// codex-rs/core/src/agents_md.rs:42-45
/// Default filename scanned for AGENTS.md instructions.
pub const DEFAULT_AGENTS_MD_FILENAME: &str = "AGENTS.md";
/// Preferred local override for AGENTS.md instructions.
pub const LOCAL_AGENTS_MD_FILENAME: &str = "AGENTS.override.md";
```

```rust
// codex-rs/core/src/agents_md.rs:272-296
fn candidate_filenames<'a>(config: &'a Config, cwd: &PathUri) -> Vec<&'a str> {
    let mut names: Vec<&str> = Vec::with_capacity(2 + config.project_doc_fallback_filenames.len());
    names.push(LOCAL_AGENTS_MD_FILENAME);
    names.push(DEFAULT_AGENTS_MD_FILENAME);
    for candidate in &config.project_doc_fallback_filenames {
        let candidate = candidate.as_str();
        if candidate.is_empty() {
            continue;
        }
        // Use the executor's path convention, not the host's: resolving a Windows
        // network path can send ambient credentials even during metadata probes.
        if matches!(candidate, "." | "..")
            || candidate.contains(['/', '\0'])
            || cwd.infer_path_convention() == Some(PathConvention::Windows)
                && candidate.contains(['\\', ':'])
        {
            tracing::warn!("ignoring project_doc_fallback_filenames entry that is not a filename");
            continue;
        }
        if !names.contains(&candidate) {
            names.push(candidate);
        }
    }
    names
}
```

The per-directory probe returns the FIRST candidate that is a regular file (`metadata.is_file`) and
stops:

```rust
// codex-rs/core/src/agents_md.rs:244-262
    let mut results = futures::stream::iter(search_dirs)
        .map(|directory| async move {
            for name in candidate_filenames {
                let candidate = directory
                    .join(name)
                    .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
                match fs
                    .get_metadata(&candidate, GetMetadataOptions::default(), sandbox)
                    .await
                {
                    Ok(metadata) if metadata.is_file => return Ok(Some(candidate)),
                    Ok(_) => {}
                    Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                    Err(err) => return Err(err),
                }
            }
            Ok(None)
        })
        .buffered(MAX_CONCURRENT_ANCESTOR_PROBES);
```

Fallback names are also trimmed and blank ones dropped when the config is built:

```rust
// codex-rs/core/src/config/mod.rs:4331-4343
            project_doc_max_bytes: cfg.project_doc_max_bytes.unwrap_or(AGENTS_MD_MAX_BYTES),
            project_doc_fallback_filenames: cfg
                .project_doc_fallback_filenames
                .unwrap_or_default()
                .into_iter()
                .filter_map(|name| {
                    let trimmed = name.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed.to_string())
                    }
                })
                .collect(),
```

So, per directory: **at most one file**, chosen in order `AGENTS.override.md` → `AGENTS.md` →
each `project_doc_fallback_filenames` entry in config order (deduplicated). Consequences:

- `AGENTS.override.md` *replaces* `AGENTS.md` in that directory; the two are never both loaded
  (test `agents_local_md_preferred`, `agents_md_tests.rs:1553-1573`).
- A fallback name is consulted only when neither `AGENTS.*` name is a regular file there.
- A directory or FIFO named `AGENTS.md` is skipped and the next candidate tried
  (tests `agents_md_directory_is_ignored`, `agents_md_special_file_is_ignored`,
  `override_directory_falls_back_to_agents_md_file`, `agents_md_tests.rs:1691-1747`).
- A fallback containing `/` (or `\`/`:` on a Windows executor), `.` or `..` is ignored with a warning.
- Selection is by EXISTENCE, before content is read: a whitespace-only `AGENTS.override.md` still
  wins the directory and is then dropped as empty (§4), so its sibling `AGENTS.md` does **not**
  load. (The global loader behaves differently — §5.)
- Names are joined literally, so case sensitivity is the filesystem's.
- Symlinks are followed (metadata/read follow links; module comment "Symlinks are allowed.",
  `agents_md.rs:189-190`).

## 2. The walk

> @vendor-claim reviewed=2026-09-27 verify=Re-read `fn agents_md_paths` in `codex-rs/core/src/agents_md.rs` and `find_nearest_ancestor` in `codex-rs/file-system/src/find_up.rs`; confirm root = nearest ancestor-or-self holding any marker, markers taken from non-project layers only, no marker → cwd only

```rust
// codex-rs/core/src/agents_md.rs:192-240
async fn agents_md_paths(
    config: &Config,
    cwd: &PathUri,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> io::Result<Vec<PathUri>> {
    let dir = cwd.clone();

    let mut merged = TomlValue::Table(toml::map::Map::new());
    for layer in config.config_layer_stack.layers_low_to_high() {
        if matches!(layer.name, ConfigLayerSource::Project { .. }) {
            continue;
        }
        merge_toml_values(&mut merged, &layer.config);
    }
    let project_root_markers = match project_root_markers_from_config(&merged) {
        Ok(Some(markers)) => markers,
        Ok(None) => default_project_root_markers(),
        Err(err) => {
            tracing::warn!("invalid project_root_markers: {err}");
            default_project_root_markers()
        }
    };
    let project_root = find_nearest_ancestor_with_markers(
        fs,
        &dir,
        project_root_markers,
        FindUpErrorPolicy::Ignore,
        sandbox,
    )
    .await?;
    let search_dirs = if let Some(root) = project_root {
        let mut dirs = Vec::new();
        let mut cursor = dir.clone();
        loop {
            dirs.push(cursor.clone());
            if cursor == root {
                break;
            }
            let Some(parent) = cursor.parent() else {
                break;
            };
            cursor = parent;
        }
        dirs.reverse();
        dirs
    } else {
        vec![dir]
    };
```

The root search: ancestors of the cwd starting WITH the cwd, nearest first; a marker "exists" if
`get_metadata` succeeds (file OR directory — a worktree's `.git` file counts); unreadable probes are
treated as absent (`FindUpErrorPolicy::Ignore`):

```rust
// codex-rs/file-system/src/find_up.rs:87-127
    let mut ancestors = std::iter::successors(Some(start), parent);
    let mut ancestor = ancestors.next();
    let mut marker_index = 0;
    let probes = std::iter::from_fn(move || {
        let current_ancestor = ancestor.clone()?;
        let marker = markers.get(marker_index)?;
        /* … */
    });
    let mut results = futures::stream::iter(probes)
        .map(|(ancestor, marker_path)| async move {
            let marker_path = marker_path?;
            match file_system
                .get_metadata(&marker_path, crate::GetMetadataOptions::default(), sandbox)
                .await
            {
                Ok(_) => Ok(Some(ancestor)),
                Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(err) => match error_policy {
                    FindUpErrorPolicy::Propagate => Err(err),
                    FindUpErrorPolicy::Ignore => Ok(None),
                },
            }
        })
        .buffered(MAX_CONCURRENT_PROBES);
    /* … first Some(ancestor) wins … */
```

Pinned behaviour:

- **Start:** the session's working directory (per selected environment — see §4 multi-environment).
- **Root:** the NEAREST ancestor-or-self containing any `project_root_markers` entry; default
  `[".git"]` (`codex-rs/config/defaults.toml:14`). So in a nested repo/submodule the inner repo is
  the root; outer `AGENTS.md` files do not load.
- **Contributing directories:** root → … → cwd, inclusive, top-down. Nothing above the root.
  Nothing below the cwd.
- **No marker found** (e.g. not in a git repo): **only the cwd** is probed — the walk does NOT
  continue to the filesystem root.
- **`project_root_markers = []`:** `markers.get(0)` is `None`, no probe runs, root is `None` →
  cwd only (test `empty_project_root_markers_only_probe_cwd_candidates`, `agents_md_tests.rs:1031`).
- **Markers ignore project-level config:** layers of kind `ConfigLayerSource::Project`
  (a repo's `.codex/config.toml`) are skipped when reading `project_root_markers`
  (test `project_layers_do_not_override_project_root_markers`, `agents_md_tests.rs:1446-1489`).
- **Symlinked cwd:** the walk is LEXICAL over the configured cwd path (parents of the symlink,
  not of its target), while each file read follows the link (test
  `symlinked_cwd_uses_logical_parent_for_agents_discovery`, `tests/suite/agents_md.rs:518-596`).
- **Untrusted project:** no project files load at all; only host (global/thread) instructions:

```rust
// codex-rs/core/src/agents_md.rs:63-66
    let mut loaded = LoadedAgentsMd::from_user_instructions(user_instructions);
    if config.active_project.is_untrusted() {
        return Ok((!loaded.is_empty()).then_some(loaded));
    }
```

## 3. Concatenation

> @vendor-claim reviewed=2026-09-27 verify=Re-read `legacy_text`, `environment_labeled_text` and `AGENTS_MD_SEPARATOR` in `codex-rs/core/src/agents_md.rs`; confirm "\n\n" between project files and the `--- project-doc ---` marker only on the host→project transition

```rust
// codex-rs/core/src/agents_md.rs:47-49
/// When both user and project AGENTS.md docs are present, they will be
/// concatenated with the following separator.
const AGENTS_MD_SEPARATOR: &str = "\n\n--- project-doc ---\n\n";
```

```rust
// codex-rs/core/src/agents_md.rs:386-419
    fn legacy_text(&self) -> String {
        let mut output = String::new();
        let mut has_previous = false;
        let mut previous_was_project = false;
        for instructions in self
            .user_instructions
            .iter()
            .chain(self.thread_instructions.iter())
        {
            if has_previous {
                output.push_str("\n\n");
            }
            output.push_str(&instructions.text);
            has_previous = true;
        }
        for entry in &self.entries {
            let is_project = matches!(&entry.provenance, InstructionProvenance::Project { .. });
            if has_previous {
                // The project-doc marker tells the model where workspace-scoped
                // instructions begin, so it is only needed on the transition
                // from user or internal instructions to project instructions.
                let separator = if is_project && !previous_was_project {
                    AGENTS_MD_SEPARATOR
                } else {
                    "\n\n"
                };
                output.push_str(separator);
            }
            output.push_str(&entry.contents);
            has_previous = true;
            previous_was_project = is_project;
        }
        output
    }
```

- Order: global (`$CODEX_HOME`) → thread (host-supplied) → project files root→cwd.
- Between two project files: exactly `"\n\n"`. **No per-file header, no path label, no filename.**
  (Unit test `concatenates_root_and_cwd_docs` asserts `"root doc\n\ncrate doc"`,
  `agents_md_tests.rs:1365-1414`.)
- Between the last host block and the first project file: `"\n\n--- project-doc ---\n\n"`.
  With no global/thread instructions the marker is absent.
- Project file contents are NOT trimmed (only tested for emptiness); global/thread text IS trimmed
  (§5).
- **Multi-environment only** (two or more *environments* contributed project files — a remote/exec
  environment feature, not directories): `text()` switches to `environment_labeled_text`, which
  prefixes each environment's group once with ``for `<environment_id>` with root <cwd>\n\n`` and
  omits the `--- project-doc ---` marker (`agents_md.rs:421-471`). A plain single-directory CLI
  session always takes `legacy_text`.

## 4. Size cap and truncation

> @vendor-claim reviewed=2026-09-27 verify=Re-read `load_project_instructions` and `read_agents_md` in `codex-rs/core/src/agents_md.rs` and `project_doc_max_bytes` in `codex-rs/config/defaults.toml`; confirm one shared byte budget over project files only, byte-level cut of the crossing file, later files dropped, global not charged

Default and meaning:

```toml
# codex-rs/config/defaults.toml:8-9
project_doc_max_bytes = 32768
project_doc_fallback_filenames = []
```

```rust
// codex-rs/config/src/config_toml.rs:329-334
    /// Maximum total bytes of project instruction content across all selected environments.
    #[serde(default = "default_project_doc_max_bytes")]
    pub project_doc_max_bytes: Option<usize>,

    /// Ordered list of fallback filenames to look for when AGENTS.md is missing.
    #[serde(default = "default_project_doc_fallback_filenames")]
    pub project_doc_fallback_filenames: Option<Vec<String>>,
```

```rust
// codex-rs/core/src/config/mod.rs:250-253
/// Maximum number of bytes of the documentation that will be embedded. Larger
/// files are *silently truncated* to this size so we do not take up too much of
/// the context window.
pub(crate) const AGENTS_MD_MAX_BYTES: usize = DEFAULT_PROJECT_DOC_MAX_BYTES; // 32 KiB
```

The truncation itself:

```rust
// codex-rs/core/src/agents_md.rs:142-180
    let mut remaining: u64 = max_total as u64;
    let mut loaded = LoadedAgentsMd::default();

    for p in paths {
        if remaining == 0 {
            break;
        }

        let mut data = match fs.read_file(&p, ReadFileOptions::default(), sandbox).await {
            Ok(data) => data,
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err),
        };
        let size = data.len() as u64;
        if size > remaining {
            data.truncate(remaining as usize);
        }

        if size > remaining {
            tracing::warn!(
                path = %p,
                remaining_bytes = remaining,
                "project doc exceeds remaining budget; truncating"
            );
        }

        let text = String::from_utf8_lossy(&data).to_string();
        if !text.trim().is_empty() {
            loaded.entries.push(InstructionEntry {
                contents: text,
                provenance: InstructionProvenance::Project {
                    source_path: p,
                    environment_id: environment_id.to_string(),
                    cwd: cwd.clone(),
                },
            });
            remaining = remaining.saturating_sub(data.len() as u64);
        }
    }
```

And across environments:

```rust
// codex-rs/core/src/agents_md.rs:68-95
    let mut remaining = config.project_doc_max_bytes;
    for turn_environment in environments.turn_environments() {
        if remaining == 0 {
            break;
        }
        /* … */
        match read_agents_md(
            config,
            filesystem.as_ref(),
            &turn_environment.selection.environment_id,
            turn_environment.cwd(),
            remaining,
            sandbox.as_ref(),
        )
        .await
        {
            Ok(Some(docs)) => {
                for entry in docs.entries {
                    remaining = remaining.saturating_sub(entry.contents.len());
                    loaded.entries.push(entry);
                }
            }
            /* … */
```

The rule, exactly:

1. **One COMBINED budget**, `project_doc_max_bytes` (default **32768** bytes), shared by every
   project file in walk order (root first), and across all selected environments.
2. Files are read whole, in order root → cwd. A file that fits is kept whole and its **raw byte
   length** is subtracted. The **first file that does not fit is cut to the remaining bytes** — a
   raw byte cut (`Vec<u8>::truncate`), no line/paragraph/UTF-8 boundary awareness. A multi-byte
   UTF-8 character split by the cut becomes `U+FFFD` via `from_utf8_lossy` (so the injected
   string can be up to 2 bytes LONGER than the budget). Budget is then 0 and **every later file
   (the ones nearest the cwd) is dropped**, silently to the model (a `tracing::warn!` goes to the
   log only). No truncation marker is inserted into the text.
3. Because truncation favours the ROOT, a big repo-root `AGENTS.md` starves the more specific
   subdirectory files — the opposite of the "closer files override" intent (unit test
   `total_byte_limit_truncates_later_project_docs`, limit 7, `"root"` + `"abcdef"` →
   `"root\n\nabc"`, `agents_md_tests.rs:684-718`; single file: `doc_larger_than_limit_is_truncated`,
   `agents_md_tests.rs:668-682`).
4. An empty/whitespace-only file (after the cut) is dropped and **charges nothing**.
5. The budget counts file bytes only — **not** the `"\n\n"` joiners, the `--- project-doc ---`
   marker, or the wrapper (§9).
6. **Global and thread instructions are NOT charged** against it (test comment "User instructions
   precede project docs without consuming their byte budget", `agents_md_tests.rs:1113-1130`).
   The global file has **no size cap at all** in this code path; the thread (host) instruction has
   its own 10,000-estimated-token limit and is REJECTED rather than truncated
   (`agents_md_manager.rs:165-178`).
7. `project_doc_max_bytes = 0` disables project docs entirely (`agents_md.rs:133-135`; test
   `zero_byte_limit_disables_docs`).
8. Invalid UTF-8 anywhere is decoded lossily, not rejected (test `project_doc_invalid_utf8_uses_lossy_text`).

**Doc divergence:** the official page says Codex *"stops adding files once the combined size
reaches the limit defined by `project_doc_max_bytes` (32 KiB by default)"* — the code does not stop
before the crossing file; it includes a byte-truncated prefix of it.

## 5. User-global instructions (`$CODEX_HOME/AGENTS.md`)

> @vendor-claim reviewed=2026-09-27 verify=Re-read `load_from_codex_home` in `codex-rs/codex-home/src/instructions/mod.rs` and `find_codex_home` in `codex-rs/core/src/config/mod.rs`; confirm override-then-AGENTS.md with empty fall-through, trimmed text, placed before project docs

```rust
// codex-rs/codex-home/src/instructions/mod.rs:41-84
    async fn load_from_codex_home(&self) -> LoadedUserInstructions {
        let mut warnings = Vec::new();
        for candidate in [LOCAL_AGENTS_MD_FILENAME, DEFAULT_AGENTS_MD_FILENAME] {
            let path = self.codex_home.join(candidate);
            match tokio::fs::metadata(path.as_path()).await {
                Ok(metadata) if !metadata.is_file() => continue,
                Ok(_) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                Err(err) => { /* … warn … */ continue; }
            }
            let data = match tokio::fs::read(path.as_path()).await { /* … */ };
            let contents = String::from_utf8_lossy(&data);
            let trimmed = contents.trim();
            if !trimmed.is_empty() {
                return LoadedUserInstructions {
                    instructions: Some(Instructions {
                        text: trimmed.to_string(),
                        source: Some(path),
                    }),
                    warnings,
                };
            }
        }
        LoadedUserInstructions {
            instructions: None,
            warnings,
        }
    }
```

```rust
// codex-rs/core/src/config/mod.rs:4911-4921
/// Returns the path to the Codex configuration directory, which can be
/// specified by the `CODEX_HOME` environment variable. If not set, defaults to
/// `~/.codex`.
///
/// - If `CODEX_HOME` is set, the value must exist and be a directory. The
///   value will be canonicalized and this function will Err otherwise.
/// - If `CODEX_HOME` is not set, this function does not verify that the
///   directory exists.
pub fn find_codex_home() -> std::io::Result<AbsolutePathBuf> {
```

The CLI wires it in (`codex-rs/cli/src/main.rs:2032-2034`):
`CodexHomeUserInstructionsProvider::new(config.codex_home.clone())`.

- Location: `$CODEX_HOME` (default `~/.codex`). Only that directory; no walk.
- `AGENTS.override.md` first, then `AGENTS.md`. **Unlike the project loader, an empty/whitespace
  override falls through** to `AGENTS.md` (the loop only returns on non-empty trimmed text).
  Fallback filenames do NOT apply here.
- Text is `trim()`med; not size-capped; not charged against `project_doc_max_bytes`.
- Placed FIRST, then host thread instructions, then `--- project-doc ---` and project files (§3).
  Test `instruction_sources_include_global_before_agents_md_docs` asserts
  `"global doc\n\n--- project-doc ---\n\nproject doc"` (`agents_md_tests.rs:1514-1551`).
- Loaded even for an untrusted project (§2).
- On a transient read error the last successful text is kept (`mod.rs:95-101`).

## 6. Include / import syntax — none

> @vendor-claim reviewed=2026-09-27 verify=Re-read `read_agents_md` and `load_from_codex_home`; confirm file bytes flow to `InstructionEntry.contents` / `Instructions.text` with no parse step

Confirmed by the code path, not by absence of docs: project bytes go `fs.read_file` →
`truncate` → `String::from_utf8_lossy` → `InstructionEntry.contents` verbatim
(`agents_md.rs:150-177`); global bytes go `tokio::fs::read` → `from_utf8_lossy` → `trim` →
`Instructions.text` (`codex-home/src/instructions/mod.rs:57-75`). There is no lexer, no `@path`
scan, no frontmatter strip, no HTML-comment strip, no second read keyed on content. The loaded
text is exactly the file's bytes (project: untrimmed; global: trimmed).

## 7. When it loads — and what "on demand" means in Codex

> @vendor-claim reviewed=2026-09-27 verify=Re-read `AgentsMdManager::refresh` in `codex-rs/core/src/agents_md_manager.rs` and its two call sites (`session/session.rs` startup, `session/mod.rs` per step); confirm global re-read every step and repository re-read only when environment selections or trust change

```rust
// codex-rs/core/src/agents_md_manager.rs:79-98
        let selections = environments
            .turn_environments()
            .map(|environment| environment.selection.clone())
            .collect::<Vec<_>>();
        let active_project_trust_level = config.active_project.trust_level;
        let (mut instructions, cached, refresh_repository) = {
            let mut state = self.state.lock().await;
            let refresh_repository = state.cache.selections.as_ref() != Some(&selections)
                || state.cache.active_project_trust_level != active_project_trust_level;
            if refresh_repository {
                // Tightened read permissions must not leave inaccessible instructions visible,
                // even if discovery fails or the caller cancels the refresh.
                state.cache = AgentsMdCache::default();
            }
            /* … */
        };
        let mut warnings = Vec::new();
        if let Some(provider) = &instructions.user_provider {
            let loaded = provider.load_user_instructions().await;
            /* … */
        }
```

```rust
// codex-rs/core/src/agents_md_manager.rs:124-132
            let loaded = if refresh_repository {
                load_project_instructions(config, /*user_instructions*/ None, environments)
                    .await?
                    .unwrap_or_default()
            } else {
                cached.as_deref().cloned().unwrap_or_default()
            }
            .with_instructions(instructions.user.clone(), instructions.thread.clone())
            .map(Arc::new);
```

Call sites: session start (`codex-rs/core/src/session/session.rs:1444-1470`,
`agents_md_manager.refresh(config.as_ref(), &resolved_environments)`) and **every model step**
(`codex-rs/core/src/session/mod.rs:3838-3846`, inside step preparation).

- **Project files:** read at session start, then re-read only when the environment selections
  (environment id + cwd) or the project trust level change. Editing an `AGENTS.md` mid-session is
  NOT picked up while cwd/trust stay the same (test `live_global_removal_preserves_repository_instructions`
  keeps serving the repository snapshot, `tests/suite/agents_md_refresh.rs:257-319`).
- **Global file:** re-read at EVERY model request boundary, including between tool calls in one
  turn (test `global_instructions_refresh_after_a_tool_in_the_same_turn`,
  `agents_md_refresh.rs:321-395`).
- **No file-read trigger.** Nothing in the loader keys on files the agent reads or directories it
  enters; there is no Codex analogue of Claude Code's `nested_memory`. Working in a subdirectory
  does not change the session cwd, so subdirectory `AGENTS.md` files below the cwd are never
  loaded by the harness. Instead the base prompt TELLS THE MODEL to go look:

```markdown
<!-- codex-rs/protocol/src/prompts/base_instructions/default.md:17-27 -->
# AGENTS.md spec
- Repos often contain AGENTS.md files. These files can appear anywhere within the repository.
- These files are a way for humans to give you (the agent) instructions or tips for working within the container.
- Some examples might be: coding conventions, info about how code is organized, or instructions for how to run or test code.
- Instructions in AGENTS.md files:
    - The scope of an AGENTS.md file is the entire directory tree rooted at the folder that contains it.
    - For every file you touch in the final patch, you must obey instructions in any AGENTS.md file whose scope includes that file.
    - Instructions about code style, structure, naming, etc. apply only to code within the AGENTS.md file's scope, unless the file states otherwise.
    - More-deeply-nested AGENTS.md files take precedence in the case of conflicting instructions.
    - Direct system/developer/user instructions (as part of a prompt) take precedence over AGENTS.md instructions.
- The contents of the AGENTS.md file at the root of the repo and any directories from the CWD up to the root are included with the developer message and don't need to be re-read. When working in a subdirectory of CWD, or a directory outside the CWD, check for any AGENTS.md files that may be applicable.
```

  So below-cwd `AGENTS.md` files reach context only as ordinary tool reads at the model's
  discretion — not deterministic, not wrapped, not budgeted by `project_doc_max_bytes`. (Whether
  a given model family's prompt carries this section is per-model; `default.md` is the default.)
- When the instruction set changes (cwd/trust change, global edit), the new set is re-sent in
  full with a replacement notice, never as a diff (§9).

Official doc: *"Codex builds an instruction chain when it starts (once per run; in the TUI this
usually means once per launched session)."* — true for project files absent a cwd/trust change;
understated for the global file.

## 8. Config keys and environment variables

> @vendor-claim reviewed=2026-09-27 verify=Re-read `codex-rs/config/defaults.toml` and the `project_doc_*` / `project_root_markers` fields in `codex-rs/config/src/config_toml.rs`; grep `agents_md.rs` for any other `config.` field it reads

| Key / var | Default | Effect | Source |
|---|---|---|---|
| `project_doc_max_bytes` (config.toml) | `32768` | combined byte budget for project files; `0` disables them | `config/defaults.toml:8`, `config_toml.rs:74,329-331` |
| `project_doc_fallback_filenames` (config.toml) | `[]` | extra per-directory names after `AGENTS.override.md`, `AGENTS.md`; trimmed, blanks and path-like entries dropped | `config/defaults.toml:9`, `config_toml.rs:333-334`, `agents_md.rs:272-296` |
| `project_root_markers` (config.toml) | `[".git"]` | walk-stop markers; `[]` = cwd only; ignored in project-layer config | `config/defaults.toml:14`, `config_toml.rs:514-517`, `agents_md.rs:200-214` |
| `CODEX_HOME` (env) | `~/.codex` | directory of the global `AGENTS.override.md` / `AGENTS.md` (and `config.toml`) | `core/src/config/mod.rs:4911-4919` |
| project trust level (`[projects."<path>"] trust_level` in `$CODEX_HOME/config.toml`) | — | `untrusted` suppresses all project files | `agents_md.rs:64-66` |
| file-system sandbox read policy | — | without full-disk read, reads go through the sandbox and a read error FAILS the load instead of being logged | `agents_md.rs:75-79, 97-111` |
| `--cd`/`-C` or launch directory | cwd | the walk start | `agents_md.rs:84` (`turn_environment.cwd()`) |

No env var overrides `project_doc_max_bytes`, the filenames or the markers directly (none read in
`agents_md.rs`); `-c key=value` CLI overrides go through the config layer stack like any key
(assumed, not traced — see Unknowns).

## 9. How the content is presented to the model

> @vendor-claim reviewed=2026-09-27 verify=Re-read `impl ContextualUserFragment for UserInstructions` in `codex-rs/core/src/context/user_instructions.rs`, `render` in `codex-rs/context-fragments/src/fragment.rs`, and the snapshot `codex_core__context__world_state__agents_md__tests__snapshots.snap`

```rust
// codex-rs/core/src/context/user_instructions.rs:10-34
impl ContextualUserFragment for UserInstructions {
    fn content_kind(&self) -> ContentItemKind {
        ContentItemKind("agents_md.instructions".to_string())
    }

    fn role(&self) -> &'static str {
        "user"
    }

    fn markers(&self) -> (&'static str, &'static str) {
        Self::type_markers()
    }

    fn type_markers() -> (&'static str, &'static str) {
        ("# AGENTS.md instructions", "</INSTRUCTIONS>")
    }

    fn body(&self) -> String {
        let directory = self
            .directory
            .as_ref()
            .map(|directory| format!(" for {directory}"))
            .unwrap_or_default();
        format!("{directory}\n\n<INSTRUCTIONS>\n{}\n", self.text)
    }
}
```

```rust
// codex-rs/context-fragments/src/fragment.rs:91-99
    fn render(&self) -> String {
        let (start_marker, end_marker) = self.markers();
        let body = self.body();
        if start_marker.is_empty() && end_marker.is_empty() {
            return body;
        }

        format!("{start_marker}{body}{end_marker}")
    }
```

Rendered, as one `role: "user"` input message (the test helper states it literally,
`tests/suite/agents_md.rs:240-243`):

```
# AGENTS.md instructions for <cwd>

<INSTRUCTIONS>
<global>

--- project-doc ---

<root AGENTS.md>

<…>

<cwd AGENTS.md>
</INSTRUCTIONS>
```

` for <cwd>` appears only when exactly one environment contributed project files (and is absent
when only global instructions loaded). Fixed overhead per injection: the header line, the
`<INSTRUCTIONS>` tags and newlines — ≈ 45 bytes plus the cwd path.

When the set changes, the whole block is re-sent with a leading notice
(`world_state/agents_md.rs:9-11, 66-77`; snapshot lines 21-51):

```rust
const REPLACEMENT_NOTICE: &str =
    "These AGENTS.md instructions replace all previously provided AGENTS.md instructions.";
const REMOVAL_NOTICE: &str = "The previously provided AGENTS.md instructions no longer apply.";
```

Note the base prompt says the files are *"included with the developer message"*; the code sends
them in a **user**-role message.

## Summary

| # | Fact | Value | Source (@ `1cc7e236`) |
|---|---|---|---|
| 1 | Filenames per directory | first regular file of `AGENTS.override.md`, `AGENTS.md`, then `project_doc_fallback_filenames`; one file per dir | `core/src/agents_md.rs:244-262, 272-296` |
| 2 | Walk | cwd upward to nearest ancestor-or-self with a `project_root_markers` entry (default `.git`); load root→cwd; no marker ⇒ cwd only; never above root, never below cwd | `agents_md.rs:192-240`, `file-system/src/find_up.rs:87-127` |
| 3 | Concatenation | root→cwd, `"\n\n"` between files, no per-file header; `"\n\n--- project-doc ---\n\n"` after global/thread text | `agents_md.rs:47-49, 386-419` |
| 4 | Size cap | `project_doc_max_bytes` = 32768, COMBINED over project files; crossing file byte-truncated, later (deeper) files dropped; global not charged; 0 disables | `agents_md.rs:68-95, 142-180`; `config/defaults.toml:8` |
| 5 | Global | `$CODEX_HOME` (`~/.codex`): `AGENTS.override.md` else `AGENTS.md`; trimmed; uncapped; first in order | `codex-home/src/instructions/mod.rs:41-84` |
| 6 | Imports | none — bytes injected verbatim | `agents_md.rs:150-177` |
| 7 | When | session start; project re-read only on cwd/environment/trust change; global re-read every model step; no file-read trigger — model told to read deeper AGENTS.md itself | `agents_md_manager.rs:79-132`; `session/mod.rs:3838-3846`; `base_instructions/default.md:17-27` |
| 8 | Config | `project_doc_max_bytes`, `project_doc_fallback_filenames`, `project_root_markers`, `CODEX_HOME`, trust level | §8 table |
| 9 | Presentation | one user-role message `# AGENTS.md instructions[ for <cwd>]\n\n<INSTRUCTIONS>\n…\n</INSTRUCTIONS>`; changes re-sent whole with a replacement notice | `context/user_instructions.rs:10-34`; `world_state/agents_md.rs:9-77` |

## Unknowns

- **Where in the request the fragment sits** relative to the developer/permissions/environment
  fragments, and whether it survives compaction unchanged — not traced (initial-context assembly
  lives outside the files read).
- **Whether project-layer config** (a trusted repo's `.codex/config.toml`) can change
  `project_doc_max_bytes` or `project_doc_fallback_filenames`. Only `project_root_markers` is
  explicitly filtered to non-project layers; the other two come from the merged `Config`, which
  suggests yes, but the project-layer loading rules were not read.
- **`-c key=value` overrides and profiles** — assumed to reach these keys through the normal layer
  stack; not traced.
- **Exact byte cost of the non-lossy vs lossy path** at a cut inside a multi-byte character: the
  within-environment budget subtracts raw bytes, the cross-environment budget subtracts the lossy
  `String` length; they can disagree by ≤ 2 bytes. Irrelevant for one environment.
- **Per-model prompts:** whether every shipped model prompt (the `gpt-5*` prompt files and model
  catalog messages) carries the "check for any AGENTS.md files" instruction of `default.md` —
  only `default.md` was read.
- **Which Codex release** contains this commit. The pinned SHA is `main`; a released `codex`
  binary may lag it.
- **Case-insensitive filesystems:** `AGENTS.md` vs `agents.md` is the filesystem's call; not
  verified on macOS/Windows.
- **Subagents** inherit the parent's applied global/thread snapshot (`agents_md_manager.rs:150-162`);
  whether a subagent with a different cwd re-walks the repository was not traced.

## How this differs from Claude Code

Against [`claude-code-memory-loader.md`](claude-code-memory-loader.md) (Claude Code 2.1.281):

| Aspect | Codex (`1cc7e236`) | Claude Code (2.1.281) |
|---|---|---|
| Walk extent | nearest `.git` (configurable marker) → cwd; no marker ⇒ cwd only | filesystem root → cwd, always |
| Files per directory | ONE (override > AGENTS.md > fallbacks) | several: `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/**`, `CLAUDE.local.md` |
| Local/private variant | `AGENTS.override.md` REPLACES `AGENTS.md` | `CLAUDE.local.md` is ADDED beside `CLAUDE.md` |
| Imports | none | `@path` imports, depth 4, per-token rules |
| Content transforms | none (project untrimmed, global trimmed) | frontmatter strip, block HTML-comment strip, extension allowlist |
| Size cap | 32 KiB COMBINED budget, byte-truncates the crossing file, drops the deeper files | per-FILE 4 MiB cliff; an oversize file is skipped whole, never truncated |
| Per-file header | none; files joined by `"\n\n"` | `Contents of <path> (<kind>):` per file |
| Wrapper | one user message `# AGENTS.md instructions for <cwd>` + `<INSTRUCTIONS>` | preamble "Codebase and user instructions are shown below…" once |
| User-global | `$CODEX_HOME/AGENTS(.override).md`, first, uncapped, re-read every step | `~/.claude/CLAUDE.md` (User kind), launch-time |
| On demand | none by the harness; model is prompted to read deeper `AGENTS.md` itself | harness injects nested `CLAUDE.md`/rules as `nested_memory` when a file is read |
| Path-scoped rules | none | `.claude/rules` `paths:` globs |
| Mid-session edits | global: picked up next step; project: only on cwd/trust change | not re-read (launch snapshot + on-read attachments) |
| Trust gate | untrusted project ⇒ no project files | external-include approval gates imports outside cwd |

## Live confirmation to run

Not run (Codex CLI not assumed installed). Each check reads the actual request the CLI sends; the
most direct observation is `RUST_LOG=codex_core=trace` plus the session rollout JSONL under
`$CODEX_HOME/sessions/`, which records every input item. Use a throwaway home so no real global
file interferes:

```bash
export CODEX_HOME=$(mktemp -d)            # empty global scope
R=$(mktemp -d)/repo && mkdir -p "$R/a/b/c" && cd "$R" && git init -q
printf 'ROOT-DOC\n'  > "$R/AGENTS.md"
printf 'A-DOC\n'     > "$R/a/AGENTS.md"
printf 'B-OVR\n'     > "$R/a/b/AGENTS.override.md"
printf 'B-DOC\n'     > "$R/a/b/AGENTS.md"          # must NOT load (override wins)
printf 'C-DEEP\n'    > "$R/a/b/c/AGENTS.md"        # below cwd: must NOT load
printf 'ABOVE\n'     > "$R/../AGENTS.md"           # above the .git root: must NOT load
```

- **Fact 2 (walk) + 1 (precedence) + 3 (joiner):**
  `cd "$R/a/b" && codex exec "Reply with the exact text between <INSTRUCTIONS> tags of the AGENTS.md message, verbatim."`
  then read the rollout's user message beginning `# AGENTS.md instructions`. Expect body exactly
  `ROOT-DOC\n\n\nA-DOC\n\n\nB-OVR\n` (each file keeps its own trailing newline, joined by `\n\n`),
  header ` for $R/a/b`, no `ABOVE`, `B-DOC`, `C-DEEP`, and no `--- project-doc ---`.
- **Fact 2, no marker:** `rm -rf "$R/.git"` and repeat from `$R/a/b`: expect `B-OVR` only.
  Then `-c 'project_root_markers=[]'` with `.git` restored: expect `B-OVR` only.
- **Fact 4 (truncation):** restore `.git`; `cd "$R/a/b"`; run with `-c project_doc_max_bytes=14`
  (`ROOT-DOC\n` = 9 bytes, `A-DOC\n` = 6): expect `ROOT-DOC\n\n\nA-DOC` (5 bytes of A, no trailing
  newline) and NO `B-OVR`. Then `-c project_doc_max_bytes=0`: expect no project text at all.
  Then write `printf 'GLOBAL\n' > "$CODEX_HOME/AGENTS.md"` with `-c project_doc_max_bytes=9`:
  expect `GLOBAL\n\n--- project-doc ---\n\nROOT-DOC\n` — the global does not consume budget.
- **Fact 7 (when):** start the TUI in `$R/a/b`, send one turn, then
  `printf 'EDITED\n' > "$R/a/AGENTS.md"` and `printf 'GLOBAL2\n' > "$CODEX_HOME/AGENTS.md"`, send a
  second turn: expect the rollout to show a new AGENTS.md message beginning `These AGENTS.md
  instructions replace all previously provided AGENTS.md instructions.` containing `GLOBAL2` but
  still `A-DOC`, not `EDITED`. Then ask the agent to `cat "$R/a/b/c/x.txt"` (create it): expect NO
  harness-injected `C-DEEP` message — only whatever the model chooses to read.
