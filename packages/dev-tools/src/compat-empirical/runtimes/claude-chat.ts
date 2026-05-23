/**
 * claude-chat driver — manual.
 *
 * claude.ai chat has no public scripting surface for "install this skill,
 * then send this prompt." The harness prints bundle + paste instructions
 * and waits for the human operator. The observation records
 * `driverMode: 'manual'` so the report discloses the human-in-the-loop
 * nature of every claude-chat cell.
 */

import { ManualDriverBase } from './shared/manual-driver.js';

export class ClaudeChatDriver extends ManualDriverBase {
  constructor() {
    super({
      target: 'claude-chat',
      driverMode: 'manual',
      tmpdirPrefix: 'vat-empirical-chat',
      instructionText:
        'Install the skill in claude.ai chat, send the prompt, then paste the captured response below.',
    });
  }
}
