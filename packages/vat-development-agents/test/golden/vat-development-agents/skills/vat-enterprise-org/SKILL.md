---
name: vat-enterprise-org
description: Use for Anthropic Enterprise/Team org administration via the Admin
  API — user management, API-key auditing, cost/usage reporting, workspace
  admin, and enterprise skill distribution. Requires ANTHROPIC_ADMIN_API_KEY.
---

# Claude Org Administration

**For Anthropic org admins only.** Requires `ANTHROPIC_ADMIN_API_KEY` (Enterprise/Team plan).
If you don't have an admin key, this skill is not for you — use `vibe-agent-toolkit:vat-skill-distribution`
for local plugin management instead.

## Two Ways to Use It

### CLI — Quick Queries

```bash
vat claude org info                          # Org identity
vat claude org users list                    # All members
vat claude org api-keys list --status active # Active API keys
vat claude org cost --group-by description   # Cost breakdown by model
vat claude org usage --from 2025-01-01T00:00:00Z  # Token usage since Jan
vat claude org skills list                   # Workspace-scoped skills (requires ANTHROPIC_API_KEY)
```

### Library — Scripts and Automation

```typescript
import { OrgApiClient, createOrgApiClientFromEnv } from '@vibe-agent-toolkit/claude-marketplace';

// Reads ANTHROPIC_ADMIN_API_KEY and optionally ANTHROPIC_API_KEY from env
const client = createOrgApiClientFromEnv();

// Or construct directly
const client = new OrgApiClient({
  adminApiKey: 'sk-ant-admin-...',
  apiKey: 'sk-ant-api03-...',        // only needed for skills endpoints
});
```

## API Reference

### Auth: Two Keys, Two Surfaces

| Key | Env Var | Endpoints | Who Has It |
|---|---|---|---|
| Admin API key | `ANTHROPIC_ADMIN_API_KEY` | `/v1/organizations/*` | Org admins only |
| Regular API key | `ANTHROPIC_API_KEY` | `/v1/skills` (beta) | Any workspace member |

### Endpoints and Methods

**Org identity:**
```typescript
const org = await client.get<{ id: string; type: string; name: string }>('/v1/organizations/me');
```

**Users:**
```typescript
// List (paginated with limit/after_id)
const users = await client.get<{ data: OrgUser[]; has_more: boolean }>(
  '/v1/organizations/users', { limit: 100 }
);

// Get single user
const user = await client.get<OrgUser>('/v1/organizations/users/user_abc123');
```

**Invites:**
```typescript
const invites = await client.get<{ data: OrgInvite[]; has_more: boolean }>(
  '/v1/organizations/invites'
);
```

**Workspaces:**
```typescript
const workspaces = await client.get<{ data: OrgWorkspace[]; has_more: boolean }>(
  '/v1/organizations/workspaces'
);

// Workspace members
const members = await client.get<{ data: WorkspaceMember[]; has_more: boolean }>(
  '/v1/organizations/workspaces/ws_abc/members'
);
```

**API keys:**
```typescript
const keys = await client.get<{ data: ApiKey[]; has_more: boolean }>(
  '/v1/organizations/api_keys',
  { status: 'active', workspace_id: 'ws_abc' }  // both filters optional
);
```

**Skills (beta — uses regular API key):**
```typescript
// List skills
const skills = await client.getSkills<{ data: Skill[]; has_more: boolean }>('/v1/skills');
// Adds anthropic-beta: skills-2025-10-02 header automatically

// Upload a skill (multipart/form-data)
import { buildMultipartFormData } from '@vibe-agent-toolkit/claude-marketplace';
const multipart = buildMultipartFormData(
  { display_title: 'My Skill' },
  [{ fieldName: 'files[]', filename: 'SKILL.md', content: Buffer.from(skillContent) }],
);
const created = await client.uploadSkill<{ id: string; latest_version: string }>(multipart);

// Add a NEW VERSION to an existing skill — send NO display_title (sending one
// would be a rename by side effect); the server assigns the version identifier.
const versionBody = buildMultipartFormData({}, files);
const version = await client.uploadSkillVersion<{ id: string; latest_version: string }>(
  created.id, versionBody,
);

// Delete a skill
const deleted = await client.deleteSkill<{ id: string; type: string }>(skillId);
```

### Report Endpoints — Pagination Quirk

Usage, cost, and code-analytics endpoints have a **non-standard pagination model**.
They return `has_more: true` with a `next_page` cursor, but the API **rejects `next_page`
as a query parameter**. Paginate by advancing `starting_at` to the last bucket's `ending_at`.

**Usage report (daily token buckets):**
```typescript
interface UsageBucket {
  starting_at: string;
  ending_at: string;
  results: Array<{
    uncached_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    model: string | null;
    workspace_id: string | null;
    api_key_id: string | null;
    service_tier: string | null;
    // ... other dimension fields, null if not applicable
  }>;
}

// First page
let resp = await client.get<{ data: UsageBucket[]; has_more: boolean }>(
  '/v1/organizations/usage_report/messages',
  { starting_at: '2025-01-01T00:00:00Z', ending_at: '2025-12-31T23:59:59Z' }
);

// Subsequent pages — advance starting_at, do NOT pass next_page
const lastBucket = resp.data.at(-1);
resp = await client.get<{ data: UsageBucket[]; has_more: boolean }>(
  '/v1/organizations/usage_report/messages',
  { starting_at: lastBucket.ending_at, ending_at: '2025-12-31T23:59:59Z' }
);
```

**Cost report:**
```typescript
// amount is a STRING, not a number — parse before arithmetic
interface CostResult {
  currency: string;
  amount: string;          // "7.0812" — use parseFloat()
  description: string | null;
  model: string | null;
  token_type: string | null;
  // ...
}

// group_by[] needs URLSearchParams for repeated params
const qs = new URLSearchParams();
qs.set('starting_at', '2025-03-01T00:00:00Z');
qs.set('ending_at', '2025-03-31T23:59:59Z');
qs.append('group_by[]', 'description');
qs.append('group_by[]', 'workspace_id');
const resp = await client.get<{ data: CostBucket[] }>(
  `/v1/organizations/cost_report?${qs.toString()}`
);

// Sum costs
const total = resp.data
  .flatMap(b => b.results)
  .reduce((sum, r) => sum + parseFloat(r.amount), 0);
```

**Code analytics (Claude Code productivity):**
```typescript
// Date-only format YYYY-MM-DD. No ending_at parameter.
const resp = await client.get<{ data: unknown[] }>(
  '/v1/organizations/usage_report/claude_code',
  { starting_at: '2025-03-01' }  // NOT ISO datetime
);
// Returns empty data[] when no Claude Code enterprise seats are active
```

## Common Recipes

### Monthly cost summary script

```typescript
import { createOrgApiClientFromEnv } from '@vibe-agent-toolkit/claude-marketplace';

const client = createOrgApiClientFromEnv();
const qs = new URLSearchParams();
qs.set('starting_at', '2025-03-01T00:00:00Z');
qs.set('ending_at', '2025-04-01T00:00:00Z');
qs.append('group_by[]', 'description');

const allResults = [];
let startingAt = '2025-03-01T00:00:00Z';
let hasMore = true;

while (hasMore) {
  qs.set('starting_at', startingAt);
  const resp = await client.get(`/v1/organizations/cost_report?${qs.toString()}`);
  allResults.push(...resp.data);
  const last = resp.data.at(-1);
  hasMore = resp.has_more && last;
  if (last) startingAt = last.ending_at;
}

const byDescription = new Map();
for (const bucket of allResults) {
  for (const r of bucket.results) {
    const key = r.description ?? 'unclassified';
    byDescription.set(key, (byDescription.get(key) ?? 0) + parseFloat(r.amount));
  }
}
for (const [desc, total] of byDescription) {
  console.log(`${desc}: $${total.toFixed(2)}`);
}
```

### API key security audit

```typescript
const client = createOrgApiClientFromEnv();
const { data: keys } = await client.get('/v1/organizations/api_keys', { limit: 100 });

const issues = [];
for (const key of keys) {
  if (key.status === 'active' && !key.expires_at) {
    issues.push(`${key.name}: active with no expiry`);
  }
  if (key.status === 'active' && !key.workspace_id) {
    issues.push(`${key.name}: not scoped to a workspace`);
  }
}
console.log(issues.length ? issues.join('\n') : 'All keys look good');
```

### List org users who haven't accepted invites

```typescript
const client = createOrgApiClientFromEnv();
const { data: invites } = await client.get('/v1/organizations/invites');
const pending = invites.filter(i => i.status !== 'accepted');
console.log(`${pending.length} pending invites:`, pending.map(i => i.email));
```

## CLI Reference

Each family takes its OWN key and never the other one. Everything except `skills` needs
`ANTHROPIC_ADMIN_API_KEY`; the whole `skills` family needs a regular workspace `ANTHROPIC_API_KEY`
and the admin key is never sent to those endpoints, so it is not needed to run them.

```
vat claude org info                              Org identity (id, name)
vat claude org users list [--limit N]            List members
vat claude org users get <user-id>               Get single member
vat claude org invites list                      List invitations
vat claude org workspaces list                   List API workspaces
vat claude org workspaces get <id>               Get single workspace
vat claude org workspaces members list <id>      Workspace members
vat claude org api-keys list [--status S]        API key inventory
vat claude org usage [--from DT] [--to DT]       Token usage report
vat claude org cost [--from DT] [--group-by F]   USD cost report
vat claude org code-analytics [--from DATE]      Claude Code metrics (YYYY-MM-DD)
vat claude org skills list                       Workspace skills (needs ANTHROPIC_API_KEY)
vat claude org skills install <source>           Upload skill dir or ZIP as a NEW skill
vat claude org skills delete <skill-id> [--all]  Delete a skill (--all drops its versions first)
vat claude org skills versions list <skill-id>   List skill versions
vat claude org skills versions add <id> <dir>    Publish a new version of an existing skill
vat claude org skills versions delete <id> <ver> Delete a skill version
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | The run happened and the outcome was not clean (e.g. `skills install --from-npm` uploaded some skills and failed others), or a stub command |
| `2` | The run could not happen: missing key, API failure, unusable input |

**Skill deletion lifecycle:** The API refuses to delete a skill that still has versions (400).
`vat claude org skills delete <skill-id> --all` deletes every version and then the skill in one
step — that is the one-step path, and the refusal's own remedy names it. To do it by hand instead,
use `versions list` to find versions, `versions delete` each one, then `delete` the skill. `--all`
deletes irreversibly and in a loop: if it fails part-way, the versions it already destroyed are
listed under `deletedVersions` in the output and are not recoverable.

**Publishing a change to a skill you already shipped:** `install` always CREATES; use
`vat claude org skills versions add <skill-id> <built-skill-dir>` to add a version to an existing
skill. Find the id with `vat claude org skills list` — the API assigns the version identifier and
makes it the latest. `versions add` takes a built skill DIRECTORY only (a ZIP is `install`-only),
and the API enforces that the tree's SKILL.md `name` matches the one the skill already has, so
publishing from a renamed tree earns a 400 rather than silently re-rooting the version's files.

## Enterprise Skill Distribution

### Skills API (claude.ai / Console)

Skills uploaded via `POST /v1/skills` are **workspace-scoped** and **automatically available to
all workspace members**. There is no per-user enable/disable via the API — visibility is
workspace-level only. The admin UI may have additional controls not exposed in the API.

**Upload from npm package:**
```bash
# Upload all skills from a package
vat claude org skills install --from-npm @scope/my-skills-package@1.0.0

# Upload a single skill
vat claude org skills install --from-npm @scope/my-skills-package@1.0.0 --skill my-skill
```

The package must contain `dist/skills/<name>/SKILL.md` (produced by `vat skills build`).
If skills are in a sub-dependency, the command searches `node_modules/*/dist/skills/` too.

**`display_title` is NOT unique in a workspace.** The API enforces uniqueness only when the field
is sent explicitly; a title derived from SKILL.md frontmatter is not checked, so two skills can
share one title — observed live. **Never resolve a title to an id** — such a lookup returns 0, 1 or
N matches, and a wrong match would append your version to somebody else's skill. Get the id from
`vat claude org skills list`. This is why `install` only ever creates, and why `versions add` takes
an id rather than a title.

When uploading multiple skills, each failure is reported and the run continues, but **a partial
failure is still a failure**: `install --from-npm` exits `1` whenever any skill failed — some-
succeeded is tagged the same way as none-succeeded, deliberately, because the workspace is left in
a mixed state a human has to look at. What did land stays in the printed document.

### Managed Settings (Claude Code plugins)

For enterprise-wide Claude Code plugin deployment (not the Skills API), use managed settings
pushed via MDM (Jamf, Intune, SCCM, etc.):

| Platform | Path |
|---|---|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux | `/etc/claude-code/managed-settings.json` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json` |

Managed settings are **highest priority** in the settings cascade — they override user settings.
Use this to force-enable plugins, lock down permissions, or configure organization defaults.

```json
{
  "enabledPlugins": {
    "my-plugin@my-marketplace": true
  }
}
```

Combine with `npm install -g <package>` (via IT software deployment) to install the plugin
binary, then managed settings to enable it across all machines.

## Not Yet Implemented

These commands exist with the correct CLI shape but return structured
`not-yet-implemented` stubs (exit 1). Coming in a future release:

- `org users update/remove` — role changes, offboarding
- `org invites create/delete` — programmatic invitations
- `org workspaces create/archive` — workspace lifecycle
- `org workspaces members add/update/remove` — workspace membership
- `org api-keys update` — rename keys
