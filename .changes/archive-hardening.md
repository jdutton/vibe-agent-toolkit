### Security

- **A `.tgz` or npm package holding symbolic-link entries could make `vat skills install` and
  `vat claude plugin install` copy any file the installing user can read into the install, at exit 0.**
  0.2.0 release candidates only; 0.1.42 is not affected. Fixed (the archive is refused): re-install
  anything an rc installed from a tarball you do not trust.
- **On Windows with `core.symlinks=true`, a git skill source (`url:`, `vat audit <git url>`) holding
  a committed link to `\\host\share` made VAT resolve that link — offering the operator's NTLM
  credentials to the host — before refusing it; and checking the clone out already wrote the link.**
  The clone is now made without a checkout, every committed link's text is read from the object
  store first, and a commit holding a network, absolute or drive-relative link text (under Windows'
  rules or POSIX's, whichever host clones it), or one that climbs above the repository, is refused
  before any link exists on disk. After checkout every link's chain, and the `#ref:subpath`'s, is
  still walked link by link by `lstat` and `readlink` alone before anything resolves it.
- **On Windows, a link to `\\host\share` in a tree VAT reads where it stands — a project
  `vat resources validate`, `vat okf validate` or `vat audit` reads, the resource projection — was
  resolved by the kernel, offering the operator's NTLM credentials to the host — and so was one a
  `stat` or an existence check followed (a skill's link targets, a `files:` source, a crawl that
  follows links, a committed link the git-listed crawl handed to a reader).** Every call VAT makes that
  follows a link (`stat`, an existence check, `realpath`) now first walks the path's link chain by
  `lstat` and `readlink`, on every host, from the tree's own root down; a chain through a network
  or device path, or a drive-relative text, is refused before the kernel is asked, and the read lanes
  report it as that one path's fault (class `refused`, errno `LINK_CHAIN_REFUSED`), as they report a
  link the OS declines to resolve. A lint rule (`local/no-link-following-fs`) keeps every new call
  behind that walk. Under Windows rules a link text is now local only when relative or
  drive-absolute: `\\?\…`, `\\.\…`, `\??\…` (`GLOBALROOT`, `Volume{…}` included), `\Device\…`,
  `\DosDevices\…`, `\GLOBAL??\…` and a rooted `\x` are network or device paths.
- **On Windows, finding a project root from a scanned directory (`vat audit` does it for every
  SKILL.md it finds) followed a `vibe-agent-toolkit.config.yaml`, `.git` or `package.json` link planted
  there, and a copy that keeps links (`vat skill test run`, `vat claude marketplace publish`, `vat build`)
  had Node follow each link's target to pick its type** — either offering NTLM credentials to a
  `\\host\share` target. Both now read the chain by `lstat`/`readlink` first; a copied link gets its type from it.
- **A git skill source's committed link text was decoded as UTF-8 before it was judged**, so its bytes,
  and a blob crafted to look like the next object's header, were not what the checkout would
  create. Link texts are now read as bytes and the clone is refused on any count, size or header
  mismatch.
- **A `publish.remote` such as `--upload-pack=<command>` made `vat claude marketplace publish` run
  that command**: the remote reached `git ls-remote`, `fetch` and `push` as an option. Every one of
  them now ends option parsing (`--`) before the remote, and such a remote is refused (below).
- **Dependencies bumped past new advisories:** `@modelcontextprotocol/sdk` 1.32.0 (shipped, by
  `@vibe-agent-toolkit/gateway-mcp`, which now requires it), and in this repo's lockfile `vite` 7.3.7, `vitest` 4.1.12, `undici`
  7.30.1, `hono` 4.13.11, `@hono/node-server` 2.1.5, `body-parser` 2.4.0, `qs` 6.16.1, `fast-uri` 3.1.9, `ip-address` 10.7.4, `markdown-it`
  14.3.3, and the `zod` 4 copies other packages carry 4.6.7. VAT's own `zod` stays on 3.25.76:
  GHSA-mrhx-c7xc-m3w5 is fixed only in zod 4.6.6, and moving to zod 4 is its own breaking release.

### Breaking

- **A path whose link chain the OS refuses to read (`EACCES` on an `lstat` or `readlink` on the way)
  is now a fault of that path — reported, or the command's refusal — never "absent" and never left to
  the kernel.** A `LINK_CHAIN_REFUSED` refusal takes its exit code from its side (`INPUT_UNREADABLE`
  while reading, `RUN_INCOMPLETE` on a destination), not `INPUT_UNREADABLE` always. Every refusal is
  charged to the side of the path the OS refused — a link on the way, or the parent a "confirmed
  absent" check lists — not to the side of the path asked about: `pathPresent` and
  `requireConfirmedAbsent` take a required `sideOf` (`everywhere(side)`, `sideWithin(root, side,
  outside)`) in place of one `side`. The cli's `loadConfig(projectRoot, projectSide)` and
  `loadConfigCached` take the verb's side for the project the same way (`destination` for a verb that
  writes into it), so `vat resources validate` under an untraversable parent is `INPUT_UNREADABLE` and
  `vat build` there is `RUN_INCOMPLETE`.
- **Root discovery (`findProjectRoot`, `findConfigFile`, `findNodeWorkspaceRoot`, `gitFindRoot`) and a
  copy that keeps links refuse a link whose chain names a network or device path, and root discovery
  treats a probe the OS refused (`EACCES`) as that fault, not "no config here"** (`FS_FAULT`,
  `refused`, `INPUT_UNREADABLE`). Replace the link with the file it names, or fix the permission.
- **A crawl's missing base directory is a classified fault of its side** (`FS_FAULT`, `errno: ENOENT`),
  no longer an uncoded `Base directory does not exist` error; and under `unreadable: { refuse }` a
  link the crawl cannot follow throws the classified fault on the link, not a `DirectoryListingRefusedError`.
- **A git skill source refuses a commit holding a link whose text holds a NUL, is not valid UTF-8,
  or has a component ending in a dot or a space** (`COPY_LINK_ESCAPES_SOURCE`, `INPUT_UNREADABLE`),
  on every host: Windows strips the dot or space, and no single spelling is what both kernels create.
  Under Windows rules a `#ref:subpath` matches a committed link's path case-insensitively.
- **Every command that opens a ZIP or tarball refuses one holding a symbolic link, a hard link, a
  device, a sparse or unknown-type entry, a name that leaves the archive, or two entries that are
  one name** (`INPUT_UNREADABLE`, exit 2, nothing written or sent) — `vat skills install` / `list`,
  `vat claude plugin install`, `vat claude org skills install`, a `url:` skill source. `npm pack`
  writes no symbolic link, and a hard link only for two paths to one file: copy the file instead.
- **An archive over 50,000 entries or 256 MiB expanded is refused** (`INPUT_UNREADABLE`), as is a
  `url:` skill source over 100 MiB. A package that large installed before; ship the large files
  another way.
- **A tarball gzipped twice or zstd is refused** (`INPUT_UNREADABLE`) by every lane that opens a
  tarball — an npm package `--from-npm` downloads included. `vat claude org skills install <file>`
  reads its file as a ZIP, so a tarball there holds no ZIP signature and is sent on with a warning,
  as before. A tarball cut short inside an entry is refused naming that entry, gzip or plain; a gzip tarball cut on an entry boundary is refused naming its last entry (gzip records where it ends), while a plain tar cut on an entry boundary reads whole up to the cut.
- **Refused, by `vat claude org skills install` too** (`INPUT_UNREADABLE`): a ZIP64 archive, or an entry whose central record holds `0xFFFFFFFF` for a size or its
  offset; a ZIP with bytes after its end record, padded past the 64 KiB end-record search, or holding
  any data before its first local header — a self-extracting stub whether or not `zip -A` adjusted
  its offsets; a ZIP whose central record names an offset that does not hold that entry's own local
  header (so no unlisted local entry can stand at the front, under a directory record); a ZIP with an
  entry that does not inflate. An unlisted local entry BETWEEN listed ones is not refused: no lane
  reads or sends it. Only bytes with no ZIP signature anywhere are sent on. Pack with `npm pack`,
  plain gzip, or `zip`.
- **An archive entry name holding `:`, `<`, `>`, `"`, `|`, `?`, `*` or a control character, ending
  in a dot or a space, or naming a Windows device (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
  `LPT1`–`LPT9`, with or without an extension) in any segment is refused on every host**
  (`INPUT_UNREADABLE`, `unsafe-name`): Windows cannot write it, or writes another file. Rename the file.
- **`vat claude org skills install <zip>` uploads VAT's own ZIP of the entries it judged, never your
  file's bytes**: an entry only another ZIP reader would see is not sent, and entry names, order,
  timestamps, compression and modes (`0644`, or `0755` for an entry the source marks executable — a
  ZIP made on Windows marks none) are VAT's. Only a file with no ZIP signature is sent as it is, with a
  warning.
- **A backslash in a tarball entry's name is a path separator on every host**, as it already was in a
  ZIP: `a\b.md` extracts as `a/b.md` on Linux and macOS too, and `..\x` is refused. Rename the file.
- **A skill ZIP has one layout for `vat skills install`, `vat claude plugin install` and
  `vat claude org skills install`: `SKILL.md` at the top level, or exactly one top-level folder with
  `SKILL.md` directly inside.** Anything else is `INPUT_UNREADABLE`: `skills install` took the first
  top-level folder holding one whatever stood beside it; `org skills install` took one at any depth,
  or none. Re-zip the skill folder alone.
- **`vat skills install <zip>` of a ZIP with no `SKILL.md` is `INPUT_UNREADABLE`** (was
  `USAGE_INVALID`); the exit code is still 2.
- **`vat skills install <dir>` and `vat claude plugin install <dir>` refuse a directory holding a
  symbolic link that is absolute, leads outside the skill or plugin, passes through another link,
  or resolves to nothing** (`INPUT_UNREADABLE`, naming the link). Replace it with the file, or with a
  relative link to something that exists inside.
- **A git skill source refuses a commit holding, anywhere in it, a link whose text is absolute —
  even one pointing inside the clone — network, drive-relative (`C:x`) on any host, or rises above
  the repository, even to come back in by its directory's name** (`COPY_LINK_ESCAPES_SOURCE`,
  `INPUT_UNREADABLE`), not only a link under the `#ref:subpath`: the checkout writes every link.
  A `#ref:subpath` that is such a link, or passes through one, is `GIT_SUBPATH_INVALID`
  (`USAGE_INVALID`), as one that leads outside already was; one that is a link cycle is "not
  found" (`USAGE_INVALID`). Commit a relative link instead.
- **A link, or a path through links, that the OS declines to resolve (`EACCES`/`EPERM`) or cannot
  look at (`EIO`, `ESTALE`, the network errnos of a share — `ENETUNREACH`, `EHOSTUNREACH`,
  `ECONNRESET`, `ENOTCONN` — Windows' `UNKNOWN`, and Windows' ambiguous `EINVAL` and `ENAMETOOLONG`,
  each of which libuv answers for several Win32 errors) is reported against that one target** — no
  longer a link "to nothing": `vat resources validate` and every link check give it `LINK_TARGET_UNREADABLE`
  naming the errno (except where the validator runs no realpath check: a project that is not a git
  repository, `skipGitIgnoreCheck`, and a gitignored source file — which, linking such a target, no
  longer draws the finding at all), and the projection records it under the new `EXTENT_SYMLINK_TARGET_UNREADABLE`
  (`info`), its fault class in the new `realization_conditions.targetFaultClass` column, which
  `CLAUDE_RULE_LINK_UNCHECKED` reads to say "fix the permission or the share", never "delete the
  link". Every other link is still judged and the run completes. A target outside the project is
  answered "outside". Only a refused project root stops the run (`INPUT_UNREADABLE`), and the install
  lanes (`vat skills install <dir>`, `vat claude plugin install <dir>`, `vat claude plugin build`)
  stop at such a link with `INPUT_UNREADABLE` (`vat claude plugin build` used to end `INTERNAL_ERROR`).
  `UNKNOWN` is a fault, not a link to nothing: libuv answers it both for a share that is not there
  and for credentials the share refused. An errno no table lists, from a filesystem call, is a fault
  of the `device` class everywhere — never an `INTERNAL_ERROR`, never a link to nothing. One link gets
  one answer on every lane: a directory that loops (`ELOOP`) is a missing target to
  `vat resources validate` and to `vat okf validate` (`OKF_BROKEN_CROSS_LINK`, was
  `OKF_SUBDIRECTORY_UNREADABLE`), as it already was to the projection and the installs. Fix the
  permission or the mount; a dangling link is reported as before.
- **`realization_conditions` has a `targetFaultClass` column** (nullable; one of `refused`,
  `exhausted`, `wrong-type`, `occupied`, `busy`, `unsupported`, `device`): a SQL check or a
  `SELECT *` consumer sees one more column, a TypeScript consumer building a `RealizationConditionRow`
  or `CONDITION_WITHOUT_REFERENCE` row (`@vibe-agent-toolkit/resources`) must set it, and a query about declined links asks for four codes
  (`EXTENT_SYMLINK_NOT_REALIZED`, `_TARGET_OUTSIDE_ROOT`, `_TARGET_UNRESOLVED`, `_TARGET_UNREADABLE`).
- **Library API:** `realPathOrNull` is `resolveRealPath` (`@vibe-agent-toolkit/resources`), answering
  `{ kind: 'resolved', path }` or `{ kind: 'nowhere', fault }` and never throwing on a filesystem
  errno; `realpathFrom` is `realpathRowFrom` and `FsLookupCache.realpath` answers a `RealpathRow`
  (`{ path, fault }`) instead of rejecting (`@vibe-agent-toolkit/utils`); an archive member that does
  not inflate is `ArchiveEntryReadError` with its own code `ARCHIVE_ENTRY_UNREADABLE` (was
  `ARCHIVE_REFUSED`). The pipeline oracle's `targetInsideRoot` cell reads `fault:<errno>` for a target
  that could not be resolved. `inPlaceEscape` is gone: `treeChain(root, path, flavor)`
  (`@vibe-agent-toolkit/utils`) is the one link-chain resolver, `refuseEscapingLinks` requires
  `flavor` (`HOST_PATH_FLAVOR` for a real tree) and reads `side`, and a realpath primitive throws
  a `VatError` with code `LINK_CHAIN_REFUSED` for a chain it refuses. Migrate each call site.
- **`vat validate`, `vat verify` and `vat build` exit 1 when one configured phase examined nothing**
  (`RESOURCE_CHECK_BROKEN`) — a `skills.include` matching no file beside a healthy `resources:`
  block used to exit 0, and `vat build` now stops there. Fix the globs stderr lists. A project
  that ships a plugin-local skill is not refused for an empty pool.
- **`vat claude plugin install` refuses a marketplace name another source registered in
  `known_marketplaces.json` when no directory, or an empty one, stands under `marketplaces/`**
  (`USAGE_INVALID`). Pass `--force` to take the name over.
- **`vat claude marketplace publish` refuses a `publish.remote`, or the URL a remote name resolves
  to, that starts with `-`** (`CONFIG_INVALID`, before any git runs). Set it to a remote name or a
  full URL.

### Changed

- **`vat claude plugin install <zip>` accepts a ZIP holding the skill's folder** (one top-level
  folder with `SKILL.md` directly inside — what compressing a folder makes), not only its contents.
- **A top-level `__MACOSX/` folder or `.DS_Store` in a skill ZIP is neither installed nor uploaded.**
  No action needed.
- **Files extracted from an archive are `0644` or `0755` narrowed by your umask, and no file VAT
  copies keeps setuid, setgid or sticky bits** — an install, a build or a publish. No action needed.
- **A skill ZIP `vat skills package` writes holds directories `0755` and files `0644`, or `0755`
  when executable, made on Unix from every host** (Windows reports no execute bit, so a skill packaged
  there carries every file `0644`) — never the modes the host reports, so a ZIP
  packaged on Windows unpacks on Linux and macOS into directories you can enter. No action needed.
- **A directory VAT copies with its links kept is copied as a link when it is itself a symbolic
  link**, not as what it points at: a marketplace build tree or publish directory
  (`vat claude marketplace publish`), a marketplace's own files (`vat claude plugin build`), a
  skill-test staging tree (`vat skill test run`). Point VAT at the real directory.
- **An archive entry is named with forward slashes on every host**, in a refusal and in a listing:
  `C:\x.md` reads `C:/x.md`. For a tarball this is new on Linux and macOS only; for a ZIP it is new
  on every host, Windows included, where a ZIP entry used to be listed exactly as the archive spelt
  it. No action needed.

### Fixed

- **`vat audit --compat --settings` reported `status: ok` with no findings for a plugin the settings
  block.** Each conflict is now a `SETTINGS_POLICY_CONFLICT` warning, and a plugin or path a lane
  could not look at a `COMPAT_NOT_CHECKED` warning; the exit code is unchanged.
- **A `url:` skill source that failed to download, clone or verify was reported as `INTERNAL_ERROR`.**
  It is `INPUT_UNREADABLE` (a missing `sha256` is `USAGE_INVALID`); no action needed.
- **Two `url:` git sources differing only in ref or subpath could share one cached checkout.** Fixed;
  no action needed.
- **`vat claude marketplace publish` built a parentless commit when its fetch of the branch failed**,
  for example a large marketplace's full history outliving the 30-second timeout on a small CI
  runner, and the push was then rejected (`fetch first` / `non-fast-forward`). The publish now asks
  the remote whether the branch exists (`git ls-remote`). If it does, the publish fetches only the
  tip and builds on it; if it doesn't, the first commit has no parent. A remote that cannot be asked,
  or a tip that cannot be fetched, is refused with `EXTERNAL_API_FAILED`. `--force` skips the check,
  and `--no-push` still fetches the full history. No action needed.
- **A failed `vat claude marketplace publish` git step quoted git's stderr with the remote URL's
  credentials in it** (a `GH_TOKEN` injected in CI included); they are now stripped. A
  `git ls-remote` killed by its timeout says it timed out instead of `exit 1`. No action needed.
- **A refused symbolic link was named by its target, and a refused rename by the entry being moved.**
  The message now names the link, and both ends of the rename; no action needed.
