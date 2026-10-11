### Security

- **A `.tgz` or npm package holding symbolic-link entries could make `vat skills install` and
  `vat claude plugin install` copy any file the installing user can read into the install, at exit 0.**
  0.2.0 release candidates only; 0.1.42 is not affected. Fixed (the archive is refused): re-install
  anything an rc installed from a tarball you do not trust.

### Breaking

- **Every command that opens a ZIP or tarball refuses one holding a symbolic link, a hard link, a
  device, a sparse or unknown-type entry, a name that leaves the archive, or two entries that are
  one name** (`INPUT_UNREADABLE`, exit 2, nothing written or sent) — `vat skills install` / `list`,
  `vat claude plugin install`, `vat claude org skills install`, a `url:` skill source. `npm pack`
  writes no symbolic link, and a hard link only for two paths to one file: copy the file instead.
- **An archive over 50,000 entries or 256 MiB expanded is refused** (`INPUT_UNREADABLE`), as is a
  `url:` skill source over 100 MiB. A package that large installed before; ship the large files
  another way.
- **A tarball compressed twice or with zstd, a ZIP64 archive, and a ZIP with anything but its own
  comment after its end record are refused** (`INPUT_UNREADABLE`), by `vat claude org skills install`
  too — it sends on only bytes that are no ZIP at all. Pack with `npm pack`, plain gzip, or `zip`.
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
- **`vat validate`, `vat verify` and `vat build` exit 1 when one configured phase examined nothing**
  (`RESOURCE_CHECK_BROKEN`) — a `skills.include` matching no file beside a healthy `resources:`
  block used to exit 0, and `vat build` now stops there. Fix the globs stderr lists. A project
  that ships a plugin-local skill is not refused for an empty pool.
- **`vat claude plugin install` refuses a marketplace name another source registered in
  `known_marketplaces.json` when no directory, or an empty one, stands under `marketplaces/`**
  (`USAGE_INVALID`). Pass `--force` to take the name over.

### Changed

- **`vat claude plugin install <zip>` accepts a ZIP holding the skill's folder** (one top-level
  folder with `SKILL.md` directly inside — what compressing a folder makes), not only its contents.
- **A top-level `__MACOSX/` folder or `.DS_Store` in a skill ZIP is neither installed nor uploaded.**
  `vat claude org skills install` sends the archive re-zipped without them. No action needed.
- **Files extracted from an archive are `0644` or `0755` narrowed by your umask, and no file VAT
  copies keeps setuid, setgid or sticky bits** — an install, a build or a publish. No action needed.
- **A directory VAT copies with its links kept is copied as a link when it is itself a symbolic
  link**, not as what it points at: a marketplace build tree or publish directory
  (`vat claude marketplace publish`), a marketplace's own files (`vat claude plugin build`), a
  skill-test staging tree (`vat skill test run`). Point VAT at the real directory.

### Fixed

- **`vat audit --compat --settings` reported `status: ok` with no findings for a plugin the settings
  block.** Each conflict is now a `SETTINGS_POLICY_CONFLICT` warning, and a plugin or path a lane
  could not look at a `COMPAT_NOT_CHECKED` warning; the exit code is unchanged.
- **A `url:` skill source that failed to download, clone or verify was reported as `INTERNAL_ERROR`.**
  It is `INPUT_UNREADABLE` (a missing `sha256` is `USAGE_INVALID`); no action needed.
- **Two `url:` git sources differing only in ref or subpath could share one cached checkout.** Fixed;
  no action needed.
- **A refused symbolic link was named by its target, and a refused rename by the entry being moved.**
  The message now names the link, and both ends of the rename; no action needed.
