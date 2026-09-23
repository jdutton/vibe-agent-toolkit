### Changed

- **`SKILL_NAME_XML_TAGS` / `SKILL_DESCRIPTION_XML_TAGS` now judge markup, not angle brackets.** A
  path placeholder (`skills/<name>/SKILL.md`), a generic, a comparison and an arrow stop erroring;
  an HTML comment, a processing instruction, CDATA, a doctype, and a tag glued inside a word start
  erroring. Backticks no longer exempt real markup, so a description that passed by wrapping
  `<b>x</b>` in them now fails — remove the tag. A free-standing `<word>` (`<env>`, `<dir>`) is
  still an error; backtick it.
