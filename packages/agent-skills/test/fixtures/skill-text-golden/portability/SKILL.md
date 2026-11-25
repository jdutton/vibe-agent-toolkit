---
name: portability
description: Pins what the text detectors report for this fixture. It exists only for tests.
---
# Portability

[bundled](references/bundled.md)

Asset references, one per line.

Run `node $CLAUDE_PLUGIN_ROOT/scripts/run.mjs` now.
Braced: ${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs
Operator form: "${CLAUDE_PLUGIN_ROOT:-/opt/plugin}/x"
PowerShell: $env:CLAUDE_PLUGIN_ROOT\scripts\run.ps1
PowerShell braced: ${env:CLAUDE_SKILL_DIR}/x
Mixed case: $Env:CLAUDE_PROJECT_DIR and $ENV:CLAUDE_PROJECT_DIR
Lowercase name: $claude_skill_dir/x
Nested expansion: "${VAR:-$CLAUDE_PROJECT_DIR}"
Skill dir: ${CLAUDE_SKILL_DIR}/scripts/x.mjs
Skill dir bare: $CLAUDE_SKILL_DIR/scripts/x.mjs
Mount: run /skills/my-skill/scripts/x.mjs
cd /skills/my-skill && node scripts/run.mjs
Quoted mount "/skills/another.skill"
Paren mount (/skills/some_skill/)
Home skills ~/.claude/skills/x/ is not a mount
Repo skills .claude/skills/x/ is not a mount
Absolute node: node /opt/tools/run.mjs
Absolute python: python3 "/opt/tools/run.py"
Absolute bash: bash '/opt/tools/run.sh'
Absolute uv: uv /opt/tools/run.ts
Absolute ruby: ruby /opt/tools/run.rb
Relative is fine: node ./scripts/run.mjs
Both on one line: node /opt/tools/run.mjs with $CLAUDE_PLUGIN_ROOT
Name without a dollar: CLAUDE_PLUGIN_ROOT is only prose here
Longer name: $CLAUDE_PLUGIN_ROOTS_EXTRA is a different variable

Shell commands, one per line.

timeout 30 npm test
cat build.log | timeout 5 tail
`timeout 10 ls`
    timeout 5 curl example.test
timeout: 30 is a config key
the request will timeout
`timeout`
grep -P 'a+' file.txt
grep -rnP 'a+' file.txt
grep --perl-regexp x file.txt
grep -E 'a+' file.txt
cat f | grep -oP 'x'
sed -i 's/a/b/' file.txt
sed -n -i p file.txt
sed -i
sed -i.bak 's/a/b/' file.txt
readlink -f ./x
readlink -nf ./x
readlink ./x
date -d '2020-01-01'
date +%s -d yesterday
date -u
grep the logs for errors
