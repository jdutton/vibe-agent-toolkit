# Human Approval Agent

External Event Integrator for human-in-the-loop decision gates.

## Agent Type

**Archetype:** External Event Integrator

**Behavior:** Emits approval request, blocks waiting for response, handles timeouts

## Purpose

This agent integrates with external human decision-makers. It doesn't use LLM prompts - instead, it:
1. Formats a request for human review
2. Emits the request to an external system
3. Blocks execution until response received or timeout
4. Returns approval/rejection result

## Integration Points

In production, this could integrate with:
- **Slack approval bot** - Send message, wait for reaction
- **Email workflow** - Send email, wait for reply
- **Web UI** - Display modal, wait for button click
- **Ticketing system** - Create ticket, wait for resolution
- **CLI prompt** (current implementation) - Ask question, wait for input

## Agent Variants

### Request Approval (Yes/No)

**Function:** `requestApproval(prompt, context?, options?)`

**Input:**
- `prompt`: Question to ask human
- `context`: Optional additional data to display
- `options.timeoutMs`: How long to wait (0 = no timeout)
- `options.onTimeout`: What to do if timeout ('approve' | 'reject')
- `options.autoResponse`: For testing ('approve' | 'reject')

**Output:**
```typescript
{
  approved: boolean;
  reason?: string;
  timedOut?: boolean;
}
```

**Example usage:**
```typescript
const result = await requestApproval(
  'Approve breeding application for Persian cat?',
  { applicant: 'Jane Doe', breed: 'Persian', qualifications: [...] },
  { timeoutMs: 60000, onTimeout: 'reject' }
);

if (result.approved) {
  // Process application
} else {
  // Reject application
}
```

### Request Choice (Multiple Options)

**Function:** `requestChoice(prompt, options, config?)`

**Input:**
- `prompt`: Question to ask
- `options`: Array of string options
- `config.timeoutMs`: How long to wait
- `config.autoResponse`: For testing (option value)

**Output:**
```typescript
{
  approved: boolean;
  choice?: string;
  reason: string;
}
```

**Example usage:**
```typescript
const result = await requestChoice(
  'Which name do you prefer?',
  ['Mr. Whiskers', 'Sir Fluffington', 'Captain Paws'],
  { timeoutMs: 30000 }
);

if (result.approved && result.choice) {
  console.log(`User selected: ${result.choice}`);
}
```

### Request Custom Approval (Validation Logic)

**Function:** `requestCustomApproval(prompt, validator, options?)`

**Input:**
- `prompt`: Question to ask
- `validator`: Function to validate response
- `options.timeoutMs`: How long to wait
- `options.autoResponse`: For testing (string value)

**Output:**
```typescript
{
  approved: boolean;
  value?: T;
  reason: string;
}
```

**Example usage:**
```typescript
const result = await requestCustomApproval(
  'Enter cat registration number',
  (response) => {
    const match = /^CAT-\d{6}$/.test(response);
    return match
      ? { valid: true, value: response }
      : { valid: false, error: 'Must match CAT-XXXXXX format' };
  },
  { timeoutMs: 60000 }
);

if (result.approved && result.value) {
  console.log(`Registration number: ${result.value}`);
}
```

## Mockable Behavior

For testing, use `autoResponse` to skip human interaction:

```typescript
// Auto-approve (fast, deterministic, no human needed)
const result = await requestApproval(
  'Approve this?',
  undefined,
  { autoResponse: 'approve' }
);
// result = { approved: true, reason: 'Auto-approved (test mode)' }

// Auto-reject
const result = await requestApproval(
  'Approve this?',
  undefined,
  { autoResponse: 'reject' }
);
// result = { approved: false, reason: 'Auto-rejected (test mode)' }
```

**Why this matters:**
- Fast tests (no waiting for human input)
- Deterministic results (same input = same output)
- CI/CD friendly (no interactive prompts)

## Timeout Handling

Specify timeout behavior explicitly:

```typescript
// Reject on timeout (safe default)
const result = await requestApproval(
  'Approve breeding application?',
  context,
  { timeoutMs: 60000, onTimeout: 'reject' }
);

// Auto-approve on timeout (risky!)
const result = await requestApproval(
  'Approve routine maintenance?',
  context,
  { timeoutMs: 30000, onTimeout: 'approve' }
);
```

**Best practice:** Default to `onTimeout: 'reject'` for safety. Only use `approve` for non-critical decisions.

## Orchestration Patterns

### Pattern 1: Staged Approval

Break complex decisions into stages:

```typescript
// Stage 1: Basic info
const stage1 = await requestApproval('Basic info looks good?', basicData);
if (!stage1.approved) return;

// Stage 2: Detailed review
const stage2 = await requestApproval('Detailed info looks good?', detailData);
if (!stage2.approved) return;

// Stage 3: Final confirmation
const stage3 = await requestApproval('Final approval?', allData);
```

### Pattern 2: Choice-Driven Workflow

Let human decide next steps:

```typescript
const choice = await requestChoice(
  'What should we do next?',
  ['Approve', 'Request More Info', 'Reject', 'Escalate']
);

switch (choice.choice) {
  case 'Approve': // Process approval
  case 'Request More Info': // Send follow-up
  case 'Reject': // Send rejection notice
  case 'Escalate': // Notify manager
}
```

### Pattern 3: Retry on Rejection

Allow human to reconsider:

```typescript
let attempts = 0;
while (attempts < 3) {
  const result = await requestApproval('Approve this application?', context);

  if (result.approved) {
    return { success: true };
  }

  // Ask if they want to review again
  const retry = await requestApproval('Would you like to review again?');
  if (!retry.approved) break;

  attempts++;
}
```

## Error Handling

Handle all possible outcomes:

```typescript
const result = await requestApproval(prompt, context, { timeoutMs: 60000 });

if (result.timedOut) {
  // Timeout occurred
  console.error(`Request timed out: ${result.reason}`);
  // Fall back to safe default
} else if (result.approved) {
  // Approved
  console.log('Approved!');
} else {
  // Rejected
  console.log(`Rejected: ${result.reason}`);
}
```

## Integration with Agent Runtime

The agent runtime provides `executeExternalEvent` helper:

```typescript
import { executeExternalEvent } from '@vibe-agent-toolkit/agent-runtime';

return executeExternalEvent<ApprovalResult>({
  handler: async () => requestApproval(prompt, context, { timeoutMs }),
  timeoutMs,
  errorContext: 'Approval request',
  autoResponse: testMode ? mockResult : undefined,
});
```

**Benefits:**
- Consistent error handling
- Timeout management
- Mock mode support
- Standardized result envelopes

## Use Cases

**Breeding Application Approval:**
- Review applicant qualifications
- Check breed-specific requirements
- Verify compliance with regulations

**Name Selection:**
- Present 3-5 generated name options
- Let human choose preferred name
- Validate selection meets criteria

**Content Moderation:**
- Review generated haikus/names
- Approve for public display
- Reject inappropriate content

**Workflow Routing:**
- Determine next steps in complex workflows
- Escalate edge cases to human judgment
- Override automated decisions when needed

## Testing Strategy

**Unit Tests:** Use `autoResponse` for deterministic results

```typescript
it('should approve when autoResponse is approve', async () => {
  const result = await requestApproval(
    'Test prompt',
    undefined,
    { autoResponse: 'approve' }
  );
  expect(result.approved).toBe(true);
});
```

**Integration Tests:** Test with short timeouts

```typescript
it('should timeout after specified duration', async () => {
  const result = await requestApproval(
    'Test prompt',
    undefined,
    { timeoutMs: 100 }
  );
  expect(result.timedOut).toBe(true);
});
```

**Manual Testing:** Test with real human interaction (no autoResponse)

## Related Documentation

- **[SKILL.md](../skills/SKILL.md#workflow-e-hitl-approval-gate)** - Orchestration patterns
- **[Agent Runtime](../../../../agent-runtime/README.md)** - executeExternalEvent helper
