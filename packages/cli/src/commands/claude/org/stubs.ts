/**
 * Structured stub response for not-yet-implemented org commands.
 * Mutating operations are planned for a future release.
 */
export function writeNotYetImplementedStub(command: string): void {
  process.stdout.write('---\n');
  process.stdout.write('status: not-yet-implemented\n');
  process.stdout.write(`command: "${command}"\n`);
  process.stdout.write('plannedFor: "0.1.22"\n');
  process.stdout.write(
    'guidance: "Read operations are fully implemented. Mutating operations are coming in the next release."\n',
  );
}
