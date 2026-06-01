/**
 * Tiny readline wrapper for human-in-the-loop confirmation gates.
 */

import { createInterface } from 'node:readline/promises';

export async function promptUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

export interface ManualOutcome {
  outputText: string;
  notes: string;
}

const SKIP_TOKEN = 'skip';

export async function promptForManualOutcome(prefix: string): Promise<ManualOutcome | 'skip'> {
  console.log(`\n${prefix}`);
  console.log('Paste the captured runtime response below. End with a single line containing "EOF".');
  console.log(`Type "${SKIP_TOKEN}" alone on the first line to skip this cell.`);

  const collected: string[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.replace(/\r$/, '');
      if (collected.length === 0 && line.trim().toLowerCase() === SKIP_TOKEN) {
        return 'skip';
      }
      if (line.trim() === 'EOF') break;
      collected.push(line);
    }
  } finally {
    rl.close();
  }

  const outputText = collected.join('\n');
  const notes = await promptUser('Notes (optional, press Enter to skip): ');

  return { outputText, notes };
}
