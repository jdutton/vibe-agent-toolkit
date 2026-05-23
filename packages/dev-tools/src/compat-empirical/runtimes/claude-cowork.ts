/**
 * claude-cowork driver — scripted-assisted.
 *
 * Pending investigation: Anthropic Files API + Messages API skills beta;
 * `claude` CLI cowork mode; console.anthropic.com admin surface. Until
 * those land, the driver prepares a bundle and waits for a human to upload
 * + paste the response back. `driverMode: 'scripted-assisted'` flags the
 * human-in-the-loop status.
 */

import { ManualDriverBase } from './shared/manual-driver.js';

export class ClaudeCoworkDriver extends ManualDriverBase {
  constructor() {
    super({
      target: 'claude-cowork',
      driverMode: 'scripted-assisted',
      tmpdirPrefix: 'vat-empirical-cowork',
      instructionText:
        'Upload the skill bundle to your cowork workspace, send the prompt, then paste the captured response below.',
    });
  }
}
