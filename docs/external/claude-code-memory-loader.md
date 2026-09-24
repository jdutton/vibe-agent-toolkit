# Claude Code — the memory-file loader (`CLAUDE.md`, `.claude/rules`, `@` imports)

> **Source:** the shipped Claude Code binary, version 2.1.280
> (`~/.local/share/claude/versions/2.1.280`, a Bun single-file bundle), read with `strings -n 6`.
> Every block below is a VERBATIM excerpt of minified source, except that elided spans are
> marked `/* … */`. Anthropic documents none of the behaviour below at this level.
> **Read:** 2026-09-23
>
> @vendor-claim reviewed=2026-09-23 verify=Install the current Claude Code, run `strings -n 6` over its binary, re-find each function below by the quoted anchor string (`4194304`, `Skipping non-text file in @include`, `(?:^|\s)@((?:[^\s\\]|\\ )+)`, `conditionalRule:!0`, `tengu_agents_md_mod`), diff against the excerpts, and update this file and `packages/resources/test/helpers/claude-loader-reference.ts` together
>
> **Refresh policy:** re-read on adopting a Claude Code release that changes memory loading, or
> every ~90 days, whichever is sooner. The executable transcription of this file is
> `packages/resources/test/helpers/claude-loader-reference.ts`; the differential that holds VAT
> to it is `packages/resources/test/helpers/claude-loader-differential.ts`. The rules-file
> `paths:` reader and matcher are cached separately in
> [`claude-code-rules-paths-behaviour.md`](claude-code-rules-paths-behaviour.md).

## Why this cache exists

`vat claude context` answers *what does Claude Code load for a session here, and what does it
cost*. Every answer was hand-written from the vendor's prose, which is silent on most of it, and
adversarial reviews kept finding divergences one at a time. The loader is in the binary, so this
file transcribes it and a reference port executes it.

## Constants

```js
var yyn=0.05,g3=4194304,_yn=40000;
var Syn=new Set([".md",".txt",".text",".json",".yaml",".yml",".toml",".xml",".csv",".html",".htm",".css",".scss",".sass",".less",".js",".ts",".tsx",".jsx",".mjs",".cjs",".mts",".cts",".py",".pyi",".pyw",".rb",".erb",".rake",".go",".rs",".java",".kt",".kts",".scala",".c",".cpp",".cc",".cxx",".h",".hpp",".hxx",".cs",".swift",".sh",".bash",".zsh",".fish",".ps1",".bat",".cmd",".env",".ini",".cfg",".conf",".config",".properties",".sql",".graphql",".gql",".proto",".vue",".svelte",".astro",".ejs",".hbs",".pug",".jade",".php",".pl",".pm",".lua",".r",".R",".dart",".ex",".exs",".erl",".hrl",".clj",".cljs",".cljc",".edn",".hs",".lhs",".elm",".ml",".mli",".f",".f90",".f95",".for",".cmake",".make",".makefile",".gradle",".sbt",".rst",".adoc",".asciidoc",".org",".tex",".latex",".lock",".log",".diff",".patch"]);
var Pyn=5;
```

`g3` (4,194,304 bytes) is the size cliff and `Syn` the text-extension allowlist. `Pyn` is the
import depth bound: `oQe` refuses depth `>= 5`, so the root is depth 0 and four hops load.

## Reading one file: `Cge` → `Lx` → `q7e`

`Cge` is the reader EVERY memory file goes through — `CLAUDE.md`, `.claude/CLAUDE.md`,
`CLAUDE.local.md`, every rules file (via `$q`) and every `@` import — so the cliff applies to all
of them, not only to `CLAUDE.md`:

```js
async function Cge(e,n,r,s){try{let g,h=!1;if(s){let y=await Ryn(s);switch(y.kind){case"absent":return{info:null,includePaths:[]};case"error":return J7e(y.code,e),{info:null,includePaths:[]};case"skipped":h=y.isDirectory,g=null;break;case"content":g=y.content;break}}else{let y=le();g=await Lx(y,e,g3,(w)=>{h=w.isDirectory()})}if(g===null){t(`[CLAUDE.md] skipping ${e}: not a regular file or exceeds ${g3} byte limit`);let y=xge();if(!y.skip&&!h)y.skip=!0,f("context_claude_md_load","file_skipped_special_or_oversize");return{info:null,includePaths:[]}}return q7e(g,e,n,r)}catch(g){return Cyn(g,e),{info:null,includePaths:[]}}}
async function Lx(e,n,r,s){let t=await e.stat(n);if(!t.isFile()||t.size>r)return s?.(t),null;return await e.readFile(n,{encoding:"utf8"})}
```

`q7e` decides the INJECTED content. A file whose extension is outside `Syn` is skipped (a file with
no extension is not); frontmatter is removed (`kyn`); block-level HTML comments are removed
(`Sge`) — and the `@` imports are extracted from the SAME `marked` token stream (`Ayn`):

```js
function kyn(e){let{frontmatter:n,content:r}=ts(e);if(!n.paths)return{content:r};let s=pet(n.paths).map((g)=>g.endsWith("/**")?g.slice(0,-3):g).filter((g)=>g.length>0);if(s.length===0||s.every((g)=>g==="**"))return{content:r};return{content:r,paths:s}}
function q7e(e,n,r,s){let g=pyn(n).toLowerCase();if(g&&!Syn.has(g))return t(`Skipping non-text file in @include: ${n}`),{info:null,includePaths:[]};let{content:h,paths:y}=kyn(e),w=h.includes("<!--"),M=s!==void 0&&h.includes("@"),D=w||M?new rW({gfm:!1}).lex(h):void 0,B=w&&D?Sge(D).content:h,j=D&&s!==void 0?Ayn(D,s):[],he=B;if(r==="AutoMem")he=GCt(B).content;let _e=he!==e;return{info:{path:n,type:r,content:he,globs:y,contentDiffersFromDisk:_e,rawContent:_e?e:void 0},includePaths:j}}
function Sge(e){let n="",r=!1,s=/<!--[\s\S]*?-->/g;for(let g of e){if(g.type==="html"){let h=g.raw.trimStart();if(h.startsWith("<!--")&&h.includes("-->")){let y=g.raw.replace(s,"");if(r=!0,y.trim().length>0)n+=y;continue}}n+=g.raw}return{content:n,stripped:r}}
```

(`pyn` is `path.extname`, `rW` is `marked`'s `Lexer`.) The frontmatter splitter `ts` and its
BOM strip `mE`, from another chunk:

```js
function mE(e){return e.charCodeAt(0)===65279?e.slice(1):e}
var w5=30,N7=65536,gB=/^---\s*\n([\s\S]*?)---\s*\n?/,fWe=/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;function ts(e,n,r){let i=e;e=mE(e);let o=e.match(gB);if(!o)return{frontmatter:{},content:i};let s=o[1]||"",a=e.slice(o[0].length), /* … quoteLossyValues branch, off for this caller … */ let g=Afr(s);if(g.ok)f=l(E(g.value));else{c=g.error; /* … warn … */}  /* … */ return{frontmatter:f,content:a, /* … */}}
```

So the body is everything after the first `gB` match even when the YAML fails to parse; `paths:`
is honoured only when it parses.

**The bundled `marked` is 15.0.6**, established by matching the bundled lexer's regex literals
against every published 15.0.x–17.0.0 build: it carries 15.0.6's GFM strong/em delimiters
(`emStrongLDelimGfm`) and lacks 15.0.7's `lheadingGfm`. The loader lexes with `{gfm:false}`.

## Extracting `@` imports: `Ayn`

```js
function Ayn(e,n){let r=new Set;function s(h){let y=/(?:^|\s)@((?:[^\s\\]|\\ )+)/g,w;while((w=y.exec(h))!==null){let M=w[1];if(!M)continue;let D=M.indexOf("#");if(D!==-1)M=M.substring(0,D);if(!M)continue;if(M=M.replaceAll("\\ "," "),M){if(!QT(M)&&(M.startsWith("./")||M.startsWith("~/")||M.startsWith("/")&&M!=="/"||!M.startsWith("@")&&!M.match(/^[#%^&*()]+/)&&M.match(/^[a-zA-Z0-9._-]/))){let j=et(M,LO(n));r.add(j)}}}}function g(h){for(let y of h){if(y.type==="code"||y.type==="codespan")continue;if(y.type==="html"){let w=y.raw||"",M=w.trimStart();if(M.startsWith("<!--")&&M.includes("-->")){let D=/<!--[\s\S]*?-->/g,B=w.replace(D,"");if(B.trim().length>0)s(B)}continue}if(y.type==="text")s(y.text||"");if(y.tokens)g(y.tokens);if(y.items)g(y.items)}}return g(e),[...r]}
```

What follows from it, each a behaviour VAT's generic `@`-token lexer does not share:

- The `@` must start the text token or follow whitespace — `(@a.md)` is not an import.
- Nothing is stripped from the tail — `@c.md.` names `c.md.` (extension `.`, not text: skipped).
- Emphasis, links, headings and list items are descended — `**@b.md**` IS an import.
- `\ ` is an escaped space — `@my\ file.md` names `my file.md`.
- `#` cuts the fragment; code blocks, code spans and non-comment HTML are never scanned; a comment
  block's residue outside the comment is.
- The target resolves against the directory of the importing file's RESOLVED path (`n` is the
  symlink-resolved path), through `et` (trim, `~`, absolute, else `path.resolve`):

```js
function et(e,r){let i=r??ne()??le().cwd();if(typeof e!=="string")throw TypeError(`Path must be a string, received ${typeof e}`);if(typeof i!=="string")throw TypeError(`Base directory must be a string, received ${typeof i}`);if(e.includes("\x00")||i.includes("\x00"))throw Error("Path contains null bytes");let n=e.trim();if(!n)return Nn(f(i));if(n==="~")return Nn(c());if(n.startsWith("~/"))return Nn(b(c(),n.slice(2)));let o=n;if(O()==="windows"&&n.match(/^\/[a-z]\//i))try{o=sOe(n)}catch{o=n}if(P(o))return Nn(f(o));return Nn(S(i,o))}
```

## Following imports: `$q`

```js
function oQe(e,n,r,s,g){let h=Bp(e);if(r.has(h)||s>=Pyn)return;if(rQe(e,n,g))return;if(QT(e))return;return h}
async function $q(e,n,r,s,g=0,h,y,w){let M=oQe(e,n,r,g,w);if(M===void 0)return[];let D=s&&(n!=="User"||iQe()),{resolvedPath:B,isSymlink:j}=Io(le(),e);if(QT(B))return[];if(g>0&&!D&&!NO(B))return[];if(n==="User"&&!D)try{let Ee=await le().lstat(e);if(g===0&&Ee.isSymbolicLink()||(Ee.nlink??1)>1&&Ee.isFile())return[]}catch{}if(j){let Ee=Bp(B);if(r.has(Ee))return[];r.add(Ee)}r.add(M);let{info:he,includePaths:_e}=await Cge(e,n,B,y);if(!he||!he.content.trim())return[];if(h)he.parent=h;let ve=[];ve.push(he);for(let Ee of _e){if(!NO(Ee)&&!D)continue;let Me=await $q(Ee,n,r,s,g+1,e,void 0,w);ve.push(...Me)}return ve}
function NO(e){return Gd(e,ye())}
```

- One `processedPaths` set (`r`) is shared by the WHOLE launch walk: a file is loaded at most once,
  by whichever walk reaches it first — and it is marked processed BEFORE it is read, so a file a
  later filter drops still counts as seen.
- A file whose injected content is empty after `trim()` is dropped **with its imports unfollowed**.
- The output is depth-first pre-order: a file, then each import's subtree.
- An import outside the session's working directory (`NO` = inside `ye()`) is skipped unless
  external includes are approved (`s`, from `hasClaudeMdExternalIncludesApproved`) — a per-user,
  per-project decision the tree cannot show.

## The launch walk: `$yn`

Excerpt (managed, user, auto-memory and additional-directories branches elided with `…`):

```js
let pt=[];for(let $n=Ue;$n!==myn($n).root;$n=LO($n))pt.unshift($n);let _t=pt.map(($n)=>{let nr=X8e($n,Be),bn=Xe&&!nr,jn=Du($n,"CLAUDE.local.md");return{dir:$n,project:bn,projectFiles:bn?[Du($n,"CLAUDE.md"),Du($n,".claude","CLAUDE.md")].filter((qn)=>!_e(qn,"Project")):[],rulesDir:bn?Du($n,".claude","rules"):void 0,localFile:ht&&!_e(jn,"Local")?jn:void 0}})
/* … */
for(let{dir:$n,project:nr,projectFiles:bn,rulesDir:jn,localFile:qn}of _t){if(nr&&Qt&&!n.hasLoggedInitialLoad)Yt.push(Lyn($n));for(let br of bn)D.push(...await Xt(br,"Project"));if(jn!==void 0&&!$t.has(jn))D.push(...await Lke({rulesDir:jn,type:"Project",processedPaths:B,includeExternal:he,conditionalRule:!1,storageV5:g,excludeMatcher:_e}));if(qn!==void 0)D.push(...await Xt(qn,"Local"))}
```

For EVERY directory from the filesystem root down to the working directory, in that order:
`CLAUDE.md`, then `.claude/CLAUDE.md`, then that directory's `.claude/rules` (unconditional
entries), then `CLAUDE.local.md`. The names are joined literally, so their case is the
filesystem's business: exact on a case-sensitive filesystem, folded on a case-insensitive one.
(`X8e` drops directories of the main checkout above a linked worktree.) `Lyn(dir)` — an
`AGENTS.md` probe — feeds only the `agents_md_count` telemetry field here; it loads nothing.

## The rules walk: `Lke`

Excerpt (storage-backend and symlink-containment branches elided with `…`):

```js
async function Lke({rulesDir:e,type:n,processedPaths:r,includeExternal:s,conditionalRule:g,visitedDirs:h=new Set, /* … */}){ /* … */ Fe=await B.readdir(j) /* … */ for(let Le of Fe){ /* … */ if(_t){ /* … */ Me.push(...await Lke({rulesDir:Ue, /* … */ conditionalRule:g, /* … */}))}else if(gt&&Le.name.endsWith(".md")){ /* … */ let wt=await $q(Ue,n,r,s,0,void 0, /* … */ D);Me.push(...wt.filter((Lt)=>g?Lt.globs:!Lt.globs))}}return Me /* … */}
```

- Recursive, in `readdir` order (the filesystem's, not sorted); `.md` by an exact-case
  `endsWith`, on every OS.
- The `globs` filter runs over the rule's FLATTENED closure, entry by entry, each judged by its
  OWN `paths:`. At launch (`conditionalRule:false`) a path-scoped rule is dropped but its
  unscoped imports load; an unscoped rule's path-scoped import is dropped.

## On demand — when a file is read: `GUt`, `Q$r`, `Abn`, `dQe`, `y3`

```js
function GUt(e,n,r){if(a.CLAUDE_CODE_DISABLE_CLAUDE_MDS)return[];let s=[];try{if(!Fh(e,r.toolPermissionContext))return s;let g=new Set,h=ye(),y=await cQe(e,g,n.storageV5);s.push(...await sNe(y,n,e));let{nestedDirs:w,cwdLevelDirs:M}=Q$r(e,h),D=x("tengu_paper_halyard",!1);for(let B of w){let j=(await Abn(B,e,g)).filter((he)=>!D||he.type!=="Project"&&he.type!=="Local");s.push(...await sNe(j,n,e))}for(let B of M){let j=(await dQe(B,e,g)).filter((he)=>!D||he.type!=="Project"&&he.type!=="Local");s.push(...await sNe(j,n,e))}}catch(g){d(g)}return s}
function Q$r(e,n){let r=oNe(iNe(e));if(!r.startsWith(n))try{let w=le().realpathSync(r);if(w.startsWith(n))r=w}catch{}let s=[],g=r;while(g!==n&&g!==Rse(g).root){if(g.startsWith(n))s.push(g);g=oNe(g)}s.reverse();let h=[];g=n;while(g!==Rse(g).root)h.push(g),g=oNe(g);h.reverse();let y=Y8e(n);return{nestedDirs:s,cwdLevelDirs:h.filter((w)=>!X8e(w,y))}}
async function Abn(e,n,r,{skipProject:s=!1}={}){if(a.CLAUDE_CODE_DISABLE_CLAUDE_MDS)return[];let g=[],h=aw("projectSettings")&&!s;if(h){let y=Du(e,"CLAUDE.md");g.push(...await $q(y,"Project",r,!1));let w=Du(e,".claude","CLAUDE.md");g.push(...await $q(w,"Project",r,!1))}if(aw("localSettings")){let y=Du(e,"CLAUDE.local.md");g.push(...await $q(y,"Local",r,!1))}if(h){let y=Du(e,".claude","rules"),w=new Set(r);g.push(...await Lke({rulesDir:y,type:"Project",processedPaths:w,includeExternal:!1,conditionalRule:!1})),g.push(...await y3(n,y,"Project",r,!1));for(let M of w)r.add(M)}return g}
async function dQe(e,n,r){if(a.CLAUDE_CODE_DISABLE_CLAUDE_MDS||!aw("projectSettings"))return[];let s=Du(e,".claude","rules");return y3(n,s,"Project",r,!1)}
async function y3(e,n,r,s,g,h){let y=await Lke({rulesDir:n,type:r,processedPaths:s,includeExternal:g,conditionalRule:!0,storageV5:h}),w=r==="Project"?LO(LO(n)):ye(),M=DO(e)?vge(w,e):e;if(DO(e)&&(!M||M.startsWith("..")||DO(M))){let D=LO(e),{resolvedPath:B}=Io(le(),D);if(B!==D)M=vge(w,Du(B,fyn(e)))}return y.filter((D)=>{if(!D.globs||D.globs.length===0)return!1;if(!M||M.startsWith("..")||DO(M))return!1;return j7e.default().add(mre(D.globs,"claudemd_rule_globs")).ignores(M)})}
async function sNe(e,n,r){let s=[],g=wvn();for(let h of e){if(n.loadedNestedMemoryPaths?.[h.path])continue;if(!n.readFileState.has(h.path)){ /* … inject as nested_memory … */ }}return s}
```

- Reading a file `F` loads, for each directory strictly BELOW the working directory down to
  `F`'s own (`nestedDirs`): its `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, its
  unconditional rules, and its path-scoped rules matching `F`. For the working directory and each
  ancestor (`cwdLevelDirs`): only path-scoped rules matching `F`.
- **A path-scoped rule's globs are matched against `F` relative to the directory that holds
  that `.claude/rules`** (`LO(LO(n))`) — one base, never also the repository root. A rules
  directory that is neither an ancestor of the working directory nor between it and `F` is never
  consulted.
- A file already in context (launch, or an earlier read) is not injected again (`sNe`).

## How a loaded file is rendered: `FOn`

```js
function FOn(e){let t=[],r=[];for(let o of e){if(o.type==="AutoMemPinned"){r.push(o);continue}if(r.length>0)t.push(Jt(r)),r=[];t.push(`Contents of ${o.path}${Zr(o.type)}:
`+o.content.trim())}if(r.length>0)t.push(Jt(r));return t.join(`
`)}
```

The charged text of one file is `q7e`'s content, `trim()`med, behind a one-line header.

## Observed on a live binary: imports are followed from ANY loaded file

The excerpts above say `$q` extracts and follows imports for every file it loads, not only
`CLAUDE.md`. That was confirmed against Claude Code **2.1.281** on 2026-09-24 by watching the
loader itself — the `InstructionsLoaded` hook, which reports each injected file with its
`load_reason` and `parent_file_path` — rather than asking the model what it saw. The fixture's
`CLAUDE.md` imported a wiki page written with no Claude conventions in mind:

```markdown
- Pediatrics: @doogie.howser.md
- Surgery: @hawkeye.pierce (no extension)
- Cardiology: @missing.person.md (no such file)
- Contact: jeff@doogie.howser.md
- Code span: `@codespan.md`
- Parenthesised: (@paren.md)
```

| Token in the wiki page | Loaded? | Why |
|---|---|---|
| `@doogie.howser.md` (exists) | **yes**, `include` ← `wiki/doctors.md` | a username-shaped token IS an import when the file exists |
| `@deep.md` inside `doogie.howser.md` | **yes**, one hop further | recursion continues through a non-memory page |
| `@hawkeye.pierce` (exists) | no | extension `.pierce` is not in `Syn` |
| `@missing.person.md` | no, silently | no file, no event, no error |
| `jeff@doogie.howser.md` | no | `@` not at token start or after whitespace |
| `` `@codespan.md` `` | no | code spans are never scanned |
| `(@paren.md)` | no | `@` preceded by `(` |

A separate chain `CLAUDE.md → chain1 → … → chain5` loaded `chain1`–`chain4` and not `chain5`:
four hops, as `Pyn=5` says. So "a file is instruction content because an instruction file
imports it" is the harness's own rule, applied by code, whatever the file was written for.

What this does NOT cover: the MODEL may later choose to read a file a loaded text merely
mentions — a broken `@../x.md`, a bare path — by inference. That is a tool call at the model's
discretion, not a load, and nothing about it is deterministic.

## `AGENTS.md` — a flag-gated plugin, not the loader

`AGENTS.md` is not read by `$yn`. It is the `agents-md` built-in plugin, and its availability is a
server-side feature flag defaulting OFF:

```js
var W=!1;var B=()=>Oa("tengu_agents_md_mod",W);var H="AGENTS.md as project instructions: by default loaded where the project has no CLAUDE.md; by its instructionFiles option, loaded beside CLAUDE.md, left out, or with the project instructions dropped";var K="agents-md";
var z=["AGENTS.md",".claude/AGENTS.md"];var _=["CLAUDE.md",".claude/CLAUDE.md","CLAUDE.local.md"];
```

When on, in its default mode, it asks the HOST for ancestor files (`s.fs.ancestors({names:_})`):
if ANY `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists anywhere on the walk, no
`AGENTS.md` loads at all; otherwise every `AGENTS.md` / `.claude/AGENTS.md` on the walk does, and
more are attached as files are read. The 2.1.277 changelog entry reads *"in a project with no
CLAUDE.md, Claude Code reads AGENTS.md instead … (not yet on Bedrock, Vertex or Foundry)"*. Whether
it is on for a given user, and how the host's `fs.ancestors` shapes content and imports, is not in
the tree or in this chunk.
