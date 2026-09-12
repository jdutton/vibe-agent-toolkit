/**
 * The declarations an `allowed-tools:` frontmatter VALUE carries.
 *
 * Claude Code documents the field as space-separated (`Bash(git add:*)
 * Bash(git status:*)`), `AgentSkillFrontmatterSchema` says the same, many
 * authors write commas, and a YAML sequence (flow or block) is accepted by
 * every reader. This is the ONE place that turns any of those into a list —
 * the settings-compat checker and the compat detectors both read through it,
 * so a spelling cannot be visible to one and invisible to the other.
 */

/**
 * Split the STRING form of `allowed-tools:` into declarations.
 *
 * Commas and whitespace are both separators, but only at parenthesis depth
 * zero — `Bash(rm -rf /)` is one declaration, and the whitespace inside its
 * parentheses is part of the command pattern the matcher is handed.
 * Consecutive separators and edge padding produce no empty declaration.
 */
export function splitAllowedToolsList(value: string): string[] {
  const declarations: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth += 1;
    else if (char === ')' && depth > 0) depth -= 1;
    const separator = depth === 0 && (char === ',' || /\s/.test(char));
    if (!separator) {
      current += char;
      continue;
    }
    if (current !== '') declarations.push(current);
    current = '';
  }
  if (current !== '') declarations.push(current);
  return declarations;
}

/**
 * The declarations an `allowed-tools:` VALUE carries, whatever YAML shape the
 * author gave it: a block or flow sequence (each string item, trimmed), or a
 * scalar (split per {@link splitAllowedToolsList}). Anything else — absent,
 * `null`, a mapping — declares nothing.
 */
export function allowedToolsOf(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const declarations = splitAllowedToolsList(value);
    return declarations.length > 0 ? declarations : undefined;
  }
  if (Array.isArray(value)) {
    const declarations = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    return declarations.length > 0 ? declarations : undefined;
  }
  return undefined;
}
