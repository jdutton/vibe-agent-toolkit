### Added

- **A check's `with:` shares CTEs between `sql` and `examined`.** `resources.checks.<name>.with`
  holds CTE definitions without the `WITH` keyword; VAT prepends `WITH <with>` to both statements
  when the config loads, so a derived population is written once and `examined` can count it
  (before, an `examined` statement naming a CTE of `sql` was RESOURCE_CHECK_BROKEN, "no such
  table"). A statement with its own leading `WITH` is merged (`WITH <with>, <its CTEs> ...`), and
  the result is `WITH RECURSIVE` when either side is. The composed statements pass the same SQL
  gate and compile probe as any check statement. `CONFIG_INVALID`: `with` that begins with `WITH`,
  holds no definition or anything but definitions, or defines a CTE name a statement's own `WITH`
  also defines.
