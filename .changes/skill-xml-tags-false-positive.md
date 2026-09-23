### Changed

- **`SKILL_NAME_XML_TAGS` / `SKILL_DESCRIPTION_XML_TAGS` judge markup, not any `<` or `>`.**
  Comparisons, arrows, generics and joined placeholders (`skills/<name>`, `--flag=<value>`) no
  longer error. A free-standing `<word>` still errors unless backticked; real markup errors even in backticks.
