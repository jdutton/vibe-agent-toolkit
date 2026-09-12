/**
 * The recording logger the `claude org skills` suites assert against.
 *
 * Shared because two suites had already grown their own copy and a third was
 * about to: the org commands all take an `UploadLogger`, and what they SAY is
 * most of what they are testable on.
 *
 * `info` and `warn` share one sink on purpose. These tests assert on what was
 * said, and splitting the streams here would let a warning slip past a "line not
 * present" assertion. A suite that needs the two apart keeps its own recorder.
 */
export interface RecordedLog {
  info: (message: string) => void;
  warn: (message: string) => void;
  /** Every line, in the order it was emitted. */
  lines: string[];
}

export function recordingLogger(): RecordedLog {
  const lines: string[] = [];
  const record = (message: string): void => {
    lines.push(message);
  };
  return { info: record, warn: record, lines };
}
