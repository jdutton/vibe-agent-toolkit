### Changed

- **`SKILL_DESCRIPTION_XML_TAGS` judges markup, not any `<` or `>`.**
  Comparisons, arrows, generics and joined placeholders (`skills/<name>`, `--flag=<value>`) no
  longer error. A free-standing `<word>` still errors unless backticked; real markup errors even in
  backticks; a prompt-channel name (`<system>`, `<function_results>`) errors however it is joined.
