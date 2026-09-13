/**
 * The argv grammar `bin.ts` needs BEFORE commander parses anything.
 *
 * Two decisions have to be made from raw argv: which command module to load
 * (only one is, so `vat --version` does not pay for the whole CLI surface), and
 * whether this invocation is one of the four `--verbose` help pages commander
 * cannot render itself. Both must model commander's grammar rather than
 * pattern-match the line, and getting that wrong is silent by construction —
 * every failure mode below ended in a wrong page at exit 0.
 *
 * It lives here and not in `bin.ts` because `bin.ts` is the executable:
 * importing it PARSES ARGV AND RUNS A COMMAND, so nothing there can be unit
 * tested. Same reason `command-loaders.ts` is its own module.
 */

import type { Option } from 'commander';

/**
 * How the argv scan must treat one option-shaped token: a `flag` occupies its
 * own slot, a `pair` also consumes the next token as its value, and `unknown`
 * is one commander itself would reject.
 */
type OptionTokenKind = 'unknown' | 'flag' | 'pair';

/** The argv questions `bin.ts` asks, bound to what the root program declares. */
export interface RootArgvGrammar {
  /**
   * The command the user actually asked for, or `undefined` when the whole tree
   * is needed (or nothing is).
   */
  requestedCommand(argv: readonly string[]): string | undefined;
  /** Whether this is `vat <group> --verbose` for the named command group. */
  wantsGroupVerboseHelp(argv: readonly string[], group: string): boolean;
  /** Whether this is a bare `vat --help --verbose`. */
  wantsRootVerboseHelp(argv: readonly string[]): boolean;
}

/** How many argv slots a step occupies: a `pair` takes its value with it. */
function widthOf(step: OptionTokenKind): number {
  return step === 'pair' ? 2 : 1;
}

/**
 * Build the grammar from the root program's OWN option declarations.
 *
 * Read off commander's declarations rather than hardcoded, because the blast
 * radius grows with every future root option. Today that is `--version`,
 * `--cwd <dir>`, `--debug` and `--no-cache`; only `--cwd` takes a value.
 *
 * ⚠️ ORDERING MATTERS at the call site: this must be built AFTER
 * `registerCacheControl(program)`, which is what puts `--no-cache` into
 * `program.options`. Built before that call, `--no-cache` would read as
 * unknown and every `vat --no-cache <verb>` would silently give up the lazy
 * load and register the whole tree — a quiet perf regression with no failing
 * test to announce it.
 *
 * Note what is deliberately NOT synthesised here: a `--no-x` twin for boolean
 * options, and a positive `--cache` twin for `--no-cache`. Commander matches an
 * option by exact string (`Option.is()` is `short === arg || long === arg`), so
 * `--no-debug` and `--cache` are UNKNOWN options that end the parse in an
 * error. Accepting them here would re-create the very bug this scan exists to
 * avoid: a token commander rejects, treated by us as an ordinary flag to skip.
 *
 * @param rootOptions - `program.options`, after every root option is registered
 * @returns The grammar, closed over what those options declare
 */
export function createRootArgvGrammar(rootOptions: readonly Option[]): RootArgvGrammar {
  const declaredRootFlags = new Set<string>(['-h', '--help']);
  const valueTakingRootFlags = new Set<string>();
  const declareRootFlag = (flag: string | undefined, takesValue: boolean): void => {
    if (!flag) return;
    declaredRootFlags.add(flag);
    if (takesValue) valueTakingRootFlags.add(flag);
  };
  for (const option of rootOptions) {
    const takesValue = Boolean(option.required || option.optional);
    declareRootFlag(option.short, takesValue);
    declareRootFlag(option.long, takesValue);
  }

  /**
   * Classify an option-shaped token against what this program declares.
   *
   * The `--flag=value` case is not just "strip the suffix": commander only
   * accepts the inline form for a VALUE-TAKING option — its `--foo=bar` branch
   * requires `option.required || option.optional` — so `--debug=1` is an unknown
   * option even though `--debug` is declared.
   *
   * Anything unrecognised is reported as `unknown` rather than guessed at.
   * The cost of being wrong is asymmetric: a false `unknown` only forfeits
   * the lazy-load saving, while a false "declared" ships a wrong help page at
   * exit 0.
   */
  function classifyOptionToken(arg: string): OptionTokenKind {
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex !== -1) {
      return valueTakingRootFlags.has(arg.slice(0, equalsIndex)) ? 'flag' : 'unknown';
    }
    if (!declaredRootFlags.has(arg)) return 'unknown';
    return valueTakingRootFlags.has(arg) ? 'pair' : 'flag';
  }

  /**
   * How the scan steps over one token: an operand, or one of the option kinds.
   *
   * A lone `-` is an OPERAND — commander's `maybeOption` requires
   * `arg.length > 1` — and so is anything not option-shaped. Shared by both
   * scans below so the grammar cannot be modelled on one side of the command
   * name and pattern-matched on the other, which is how `wantsGroupVerboseHelp`
   * shipped.
   */
  function stepOver(arg: string): 'operand' | OptionTokenKind {
    return arg.length > 1 && arg.startsWith('-') ? classifyOptionToken(arg) : 'operand';
  }

  /**
   * Where in argv commander will read the command name, or `undefined` when it
   * will not read one.
   *
   * This must model commander's grammar, not just "the first token without a
   * dash". Ways a naive scan got it wrong, all shipped and all verified:
   *
   * - **An option's VALUE is not a verb.** `--cwd <dir>` takes a value that does
   *   not start with `-`, so `vat --cwd skills validate` picked `skills`,
   *   registered only that, and left `validate` unregistered — while
   *   `vat --cwd skills validate --help` printed ROOT help and exited **0**.
   *   Only the space-separated form was affected; `--cwd=skills` carries its
   *   value inline. The advertised `vat --cwd <dir> build` also lost the entire
   *   startup saving, since a non-colliding directory matched no loader key and
   *   fell through to loading everything.
   * - **`--help` BEFORE the verb renders ROOT help**, which has to list every
   *   command. Loading only the named one made `vat --help audit` print a help
   *   page claiming the CLI has exactly one command, and exit 0. `vat audit
   *   --help` is the other order and returns on the verb before reaching the
   *   flag, so it still loads just `audit`.
   * - **An UNDECLARED option is not a flag to skip over.** `--help` is only the
   *   most visible member of that class — it is not in `program.options` either,
   *   which is exactly why the bail-out above works. Commander's `parseOptions`
   *   switches its destination to `unknown` at the FIRST unrecognised
   *   option-shaped token and never switches back, so the verb after it never
   *   reaches `operands`; the run ends in `unknownOption()` +
   *   `showHelpAfterError()`, i.e. ROOT help. `vat --verbose audit` therefore
   *   printed an error page listing exactly one command. Every undeclared option
   *   gets the `--help` treatment for that reason.
   * - **A lone `-` is an OPERAND, not an option.** Commander's `maybeOption`
   *   requires `arg.length > 1`, so `-` lands in `operands` and reaches the
   *   `command:*` handler as an unknown command — which again renders root help.
   *   Returning its index hands `-` to the dispatcher, where it matches no
   *   loader key and the whole tree loads.
   *
   * `--` is option-shaped by the length test but declared by nobody, so it takes
   * the undeclared bail-out. That is the right answer: commander treats every
   * token after it as an operand, and loading the whole tree is always
   * behaviourally correct — the scan only ever trades away startup time.
   */
  function commandIndex(argv: readonly string[]): number | undefined {
    let index = 0;
    while (index < argv.length) {
      const arg = argv[index] ?? '';
      if (arg === '--help' || arg === '-h') return undefined;
      const step = stepOver(arg);
      if (step === 'operand') return index;
      if (step === 'unknown') return undefined;
      index += widthOf(step);
    }
    return undefined;
  }

  return {
    requestedCommand(argv) {
      const index = commandIndex(argv);
      return index === undefined ? undefined : argv[index];
    },

    /**
     * Whether this is `vat <group> --verbose`, asked by POSITION.
     *
     * 🪤 The three shipped checks asked `process.argv.includes('<group>')
     * && process.argv.includes('--verbose')`, which matches the word anywhere
     * on the line — as another command's subcommand, as a path, as a value:
     *
     *     vat inventory resources --verbose   → printed RESOURCES' verbose help, exit 0
     *     vat resources scan rag --verbose    → printed RAG's verbose help, exit 0
     *
     * Neither ran what the user typed and neither said so; the second exited 0
     * having enumerated nothing at all, on a line whose only sin was naming a
     * directory `rag`. So the group has to be the token commander itself would
     * read as the command name — the same question the lazy loader asks — and
     * `--verbose` has to follow it with no subcommand in between.
     *
     * 🪤 "No subcommand in between" is the SAME grammar as `commandIndex`, applied
     * to the tokens after the group. Commander accepts a root option on either
     * side of the command name, so `--cwd`'s value is no more a subcommand after
     * the group than before it — but this branch read `after.some(!startsWith('-'))`,
     * which is the naive scan the rest of this module replaced, and
     * `vat resources --verbose --cwd docs` died on `unknown option '--verbose'`
     * while `vat --cwd docs resources --verbose` printed the page. An undeclared
     * option after the group is likewise commander's to refuse, not ours to skip:
     * `vat resources --verbose --nonsense` printed the page at exit 0 with the
     * typo silently dropped.
     */
    wantsGroupVerboseHelp(argv, group) {
      const index = commandIndex(argv);
      if (index === undefined || argv[index] !== group) return false;
      let verbose = false;
      let cursor = index + 1;
      while (cursor < argv.length) {
        const arg = argv[cursor] ?? '';
        if (arg === '--verbose') {
          verbose = true;
          cursor += 1;
          continue;
        }
        // A subcommand of its own is commander's to run, and so is an option
        // nobody declared; only the bare group has no page but the hand-written one.
        const step = stepOver(arg);
        if (step === 'operand' || step === 'unknown') return false;
        cursor += widthOf(step);
      }
      return verbose;
    },

    /**
     * Whether this is a bare `vat --help --verbose`.
     *
     * "Bare" is decided the same way, and for the same reason: the shipped
     * check treated any token without a leading dash as a subcommand, so
     * `vat --cwd docs --help --verbose` read `docs` as the command and silently
     * rendered the NON-verbose root page instead.
     */
    wantsRootVerboseHelp(argv) {
      const hasHelp = argv.includes('--help') || argv.includes('-h');
      return hasHelp && argv.includes('--verbose') && commandIndex(argv) === undefined;
    },
  };
}
