/**
 * The progress log a supervised `vat resources check` writes, and the reader
 * that turns whatever survived into a report.
 *
 * ## 🚨 Why progress goes to a FILE, and never to stdout or IPC
 *
 * The run this log exists for is one that gets `SIGKILL`ed. That is not a design
 * preference: a statement blocked inside synchronous `node:sqlite` never returns
 * to the event loop, so nothing in-process can interrupt it — measured on Node
 * 24.13.1, `worker.terminate()` never resolves against such a thread and the
 * parent's own `process.exit()` does not exit either. An external `SIGKILL` is
 * the only lever, and `SIGKILL` cannot be handled, deferred or flushed.
 *
 * So the child's report of what it has finished has to be DURABLE at every
 * instant, not merely sent. stdout is buffered by the pipe and lost with the
 * process; an IPC message needs a live event loop to be delivered, which is the
 * exact resource the hung child does not have. An `appendFileSync` per unit is
 * on disk before the next unit starts, which is the only property that matters.
 *
 * Keeping it off stdout has a second benefit worth stating: stdout stays the one
 * parseable document this verb has always published, so `vat resources check |
 * jq` is unaffected by a mechanism it should never have to know about.
 *
 * ## 🪤 The reader must expect DAMAGE, not merely tolerate it
 *
 * The signal lands wherever it lands, including part-way through a write, so the
 * last line of a killed run's log is routinely half a JSON object. A reader that
 * threw there would replace the bounded failure report with a stack trace at
 * exactly the moment the report is the only thing the operator gets. A reader
 * that GUESSED at a damaged line would be worse still: it would publish a cost
 * record for a measurement nobody took, beside ones somebody did.
 *
 * Every line is therefore validated against a `.strict()` schema and silently
 * dropped when it does not parse. That schema is also the whole of the format
 * contract — there is no version integer here and there must never be one. This
 * file is written and read by ONE process pair within ONE run of ONE build; the
 * question a version integer pretends to answer ("can I read this?") is answered
 * exactly and automatically by the schema the reader compiles with.
 */

import { appendFileSync } from 'node:fs';

import { z } from 'zod';

/**
 * The population finished — how it was obtained, what it cost, and how much of
 * the tree it covered.
 *
 * Written the instant the projection is ready, because a kill BEFORE this line
 * means there is no projection at all and therefore no honest document to
 * publish. The parent distinguishes those two endings by this line's presence
 * and nothing else, so it must never be written early or optimistically.
 */
const PopulationEntrySchema = z.object({
  kind: z.literal('population'),
  population: z.union([z.literal('derived'), z.literal('store')]),
  populationMs: z.number(),
  membersEnumerated: z.number(),
}).strict();

/**
 * A check's statement is ABOUT to run.
 *
 * The only record that can name the rule that hung: a check which never returns
 * never files a cost, so without this line a killed run could say a check was in
 * flight but not which one — and "one of your forty rules hangs" is not an
 * actionable report.
 */
const StartEntrySchema = z.object({
  kind: z.literal('start'),
  name: z.string(),
}).strict();

/**
 * A check completed — the same fields `CheckCost` publishes.
 *
 * 🪤 `rows` is optional and `broken` is `true`-or-absent, mirroring `CheckCost`
 * exactly: a statement that threw has no row count, and `rows: 0` on it would
 * read as "selected nothing and passed". Keeping the two shapes identical is
 * what lets the parent hand recovered records to the same `buildCheckOutputData`
 * a completed run uses, rather than growing a second payload builder that could
 * drift from it.
 */
const CheckEntrySchema = z.object({
  kind: z.literal('check'),
  name: z.string(),
  durationMs: z.number(),
  rows: z.number().optional(),
  broken: z.literal(true).optional(),
}).strict();

/**
 * Every check has filed its cost; the document is about to be built.
 *
 * 🚨 **The defect this closes is a run killed AFTER it had its answer.** When
 * the last check files its cost the child is not finished: it still resolves
 * severities and serialises the document, and a document with 5,000 issues is
 * 639 KB of YAML. That phase emitted nothing, so the watchdog's clock kept
 * running from the final cost line and a budget that expired there SIGKILLed a
 * run whose work was complete — a false failure that discards a correct result.
 *
 * One `appendFileSync` buys severity resolution and serialisation a fresh budget
 * window. It carries no fields: the fact that it was written is the whole
 * message.
 *
 * 🪤 **Emitted by `runDeclaredChecks`, before it resolves severities.** It first
 * shipped a level up, from `runOutcome` after that function had already
 * returned, which left `resolveIssueSeverity` charged to the last check's window
 * while this comment claimed otherwise. What it still does NOT cover is the last
 * check's row-to-issue conversion — `runChecks` files that check's cost before
 * converting its rows — which is why the report's `idle` sentence hedges.
 */
const ChecksCompleteEntrySchema = z.object({
  kind: z.literal('checks-complete'),
}).strict();

const ProgressEntrySchema = z.discriminatedUnion('kind', [
  PopulationEntrySchema,
  StartEntrySchema,
  CheckEntrySchema,
  ChecksCompleteEntrySchema,
]);

/** One line of the progress log. */
export type ProgressEntry = z.infer<typeof ProgressEntrySchema>;

/**
 * What the run was doing when it was killed.
 *
 * `idle` and `reporting` are both real answers and neither is a fallback.
 * `idle` is the gap between the population and the first statement — nothing had
 * started. `reporting` is the opposite end: every check finished and the child
 * was assembling and serialising its document. Naming a rule in either would
 * blame one that did not hang, and collapsing the two would tell an operator
 * "between the population and the first statement" about a run that completed
 * forty rules.
 */
export type UnitInFlight =
  | { readonly kind: 'population' }
  | { readonly kind: 'check'; readonly name: string }
  | { readonly kind: 'reporting' }
  | { readonly kind: 'idle' };

/**
 * Read whatever of the log survived.
 *
 * @param text - The log's raw contents, tail damage and all
 * @returns The lines that validate, in the order they were written
 */
export function parseProgressLog(text: string): ProgressEntry[] {
  const entries: ProgressEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const entry = readLine(line);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/**
 * One line, or nothing.
 *
 * 🪤 Two separate refusals, deliberately: `JSON.parse` throws on the truncated
 * tail, and the schema refuses a well-formed object that is not an entry this
 * build knows. Collapsing them into one `try` around a parse-and-validate would
 * still work, but the two failures mean different things — damage versus drift —
 * and only the second is worth a future reader's attention.
 *
 * @param line - One line of the log
 * @returns The entry, or undefined when the line is damaged or unknown
 */
function readLine(line: string): ProgressEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = ProgressEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Which unit was running when the log stopped growing.
 *
 * 🔑 The population sentinel is keyed on the population line's ABSENCE rather
 * than on there being no `start` lines. Those are different states: a run killed
 * during population has no projection and no honest document, while a run killed
 * between the population and the first statement has both.
 *
 * @param entries - What {@link parseProgressLog} recovered
 * @returns The unit in flight
 */
export function unitInFlight(entries: readonly ProgressEntry[]): UnitInFlight {
  if (!entries.some((entry) => entry.kind === 'population')) return { kind: 'population' };

  const completed = new Set(
    entries.filter((entry) => entry.kind === 'check').map((entry) => entry.name),
  );
  // 🪤 The `completed` set is what makes this unique, NOT the scan direction.
  // The runner is serial — one statement at a time, its cost filed before the
  // next `start` — so at most one `start` can lack a cost, and a scan from
  // either end reaches the same entry. An earlier version scanned backwards and
  // justified it as "the LAST unfinished start"; reversing it left all 10 unit
  // tests green, which is the honest tell that the direction was never the
  // guard. Dropping the `completed` filter, by contrast, reds immediately.
  const started = entries.find(
    (entry): entry is Extract<ProgressEntry, { kind: 'start' }> =>
      entry.kind === 'start' && !completed.has(entry.name),
  );
  if (started !== undefined) return { kind: 'check', name: started.name };
  // 🔑 Checked AFTER the in-flight statement, never before. The line means "no
  // check is running any more"; a `start` without a cost means one still is, and
  // a log holding both is damaged in a way that must still name the rule.
  if (entries.some((entry) => entry.kind === 'checks-complete')) return { kind: 'reporting' };
  return { kind: 'idle' };
}

/**
 * Open the log for append, and hand back the one-line-per-unit writer.
 *
 * ⚠️ `appendFileSync`, and it must stay synchronous. The child that writes these
 * lines is about to enter a blocking native call; an asynchronous write would be
 * queued behind work the event loop never gets back to, so the line naming the
 * rule that hangs would exist only in memory — where `SIGKILL` destroys it.
 *
 * @param path - Where the supervisor is watching
 * @returns A writer that appends one entry and returns once it is on disk
 */
export function createProgressWriter(path: string): (entry: ProgressEntry) => void {
  return (entry) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path this process minted for this run
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf-8');
  };
}
