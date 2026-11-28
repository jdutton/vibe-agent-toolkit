// A hand-written file whose regular-expression literals hold brackets that never balance: in a
// character class, in a group, escaped, and a backtick. Real nesting is 3; a scan that reads the
// regex bodies as code counts far more.
import { helper } from './helper.js';

export const grammar = {
  openers: /[({[]/g,
  closers: /[)}\]]/g,
  group: /(\()+/,
  braces: /\{{2,}/u,
  tick: /`[({]/,
  division: 8 / 2 / 1,
  afterReturn() {
    return /[[(]/.test('x');
  },
  inCall: helper(/\[\[\[\[\[\[\(\(\(\(\(\(\{\{\{\{\{\{/, 1),
  inArray: [/[(]/, /[{]/, /\[\[\[/],
  assigned: (() => {
    const pattern = /\(\(\(\(\(/;
    return pattern;
  })(),
};

export const more = [/[({[]/, /[({[]/, /[({[]/, /[({[]/, /[({[]/, /[({[]/, /[({[]/, /[({[]/, /[({[]/, /[({[]/];
export const regexAfterOperators = 1 > 0 ? /[({[]/ : /[)}\]]/;
