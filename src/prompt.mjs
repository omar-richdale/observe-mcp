/**
 * Terminal prompting with no dependencies, because the wizard has to work the
 * same on Linux, macOS and Windows (PowerShell, cmd, Git Bash, Windows
 * Terminal) and pulling in an interactive-prompt library for four question
 * types is not worth the install.
 *
 * Two decisions here were arrived at the hard way, and both matter:
 *
 * 1. Lines are consumed from a queue fed by readline's `line` event, not by
 *    awaiting `rl.question()`. With piped stdin readline hits EOF immediately
 *    and emits every line up front; `question()` only captures the line that
 *    arrives *after* the call, so all but the first answer would be lost and
 *    the wizard could not be scripted or tested.
 *
 * 2. Secrets are read in raw mode with the readline interface **closed**, not
 *    merely paused. The usual echo-suppression trick is readline's
 *    `_writeToOutput` hook, which does not exist on `readline/promises`
 *    interfaces (undefined on Node 25) — so a masking attempt built on it falls
 *    through silently and the secret gets typed in clear text. And a merely
 *    *paused* interface keeps its keypress listener on stdin, so it echoes the
 *    secret and redraws its line editor over the top of the mask. Closing it is
 *    the only way to hold stdin exclusively; a fresh interface is cheap.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const C = stdout.isTTY && !process.env.NO_COLOR;
export const style = {
  bold: (s) => (C ? `\u001b[1m${s}\u001b[0m` : s),
  dim: (s) => (C ? `\u001b[2m${s}\u001b[0m` : s),
  green: (s) => (C ? `\u001b[32m${s}\u001b[0m` : s),
  red: (s) => (C ? `\u001b[31m${s}\u001b[0m` : s),
  yellow: (s) => (C ? `\u001b[33m${s}\u001b[0m` : s),
  cyan: (s) => (C ? `\u001b[36m${s}\u001b[0m` : s),
};

export const icon = {
  ok: style.green('✓'),
  bad: style.red('✗'),
  warn: style.yellow('!'),
  info: style.cyan('›'),
};

/**
 * Typing one of these at any prompt steps back to the previous question. It is
 * thrown rather than returned so it unwinds out of nested validation loops to
 * the step runner, which is the only place that knows what "previous" means.
 */
export const BACK_WORDS = ['back', '<'];

export function isBackError(err) {
  return err?.code === 'BACK';
}

function backError() {
  return Object.assign(new Error('back'), { code: 'BACK' });
}

function endedError() {
  return Object.assign(new Error('Input ended before setup finished.'), { code: 'INPUT_ENDED' });
}

const isTty = () => Boolean(stdin.isTTY) && typeof stdin.setRawMode === 'function';

export class Prompter {
  constructor() {
    this.queued = [];
    this.waiting = [];
    this.ended = false;
    this.swapping = false;
    this.open();
  }

  open() {
    this.rl = createInterface({ input: stdin, output: stdout });
    this.rl.on('SIGINT', () => {
      stdout.write('\nCancelled. Nothing was saved.\n');
      process.exit(130);
    });
    this.rl.on('line', (line) => {
      const waiter = this.waiting.shift();
      if (waiter) waiter(line);
      else this.queued.push(line);
    });
    this.rl.on('close', () => {
      // A close we performed ourselves to borrow stdin is not end of input.
      if (this.swapping) return;
      this.ended = true;
      while (this.waiting.length) this.waiting.shift()(null);
    });
  }

  close() {
    this.rl.close();
  }

  /** Next line of input, or null once input has ended. */
  nextLine() {
    if (this.queued.length) return Promise.resolve(this.queued.shift());
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async readLine(promptText, { allowBack = true } = {}) {
    stdout.write(promptText);
    const line = await this.nextLine();
    if (line === null) {
      stdout.write('\n');
      throw endedError();
    }
    // A terminal supplies the newline when Enter is pressed; piped input does
    // not, so add one to keep scripted output readable.
    if (!stdout.isTTY) stdout.write('\n');
    if (allowBack && BACK_WORDS.includes(line.trim().toLowerCase())) throw backError();
    return line;
  }

  /** Read a secret without putting it in the terminal or the scrollback. */
  async readSecret(promptText) {
    // Nothing echoes a piped stream, so there is nothing to hide.
    if (!isTty()) return this.readLine(promptText, { allowBack: false });

    stdout.write(promptText);
    this.swapping = true;
    this.rl.close(); // Detaches readline from stdin entirely — see the header.

    let value;
    try {
      value = await new Promise((resolve, reject) => {
        let buffer = '';
        const done = (fn) => {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          fn();
        };
        const onData = (chunk) => {
          const str = chunk.toString('utf8');
          // Arrow keys and friends arrive as escape sequences whose tail is
          // printable; drop the whole chunk rather than inserting "[A".
          if (str.charCodeAt(0) === 0x1b) return;
          for (const ch of str) {
            const code = ch.codePointAt(0);
            if (ch === '\r' || ch === '\n') return done(() => resolve(buffer));
            if (code === 3) {
              return done(() => {
                stdout.write('Cancelled. Nothing was saved.\n');
                process.exit(130);
              });
            }
            if (code === 4) return done(() => reject(endedError()));
            if (code === 127 || code === 8) {
              if (buffer.length) {
                buffer = buffer.slice(0, -1);
                stdout.write('\b \b');
              }
              continue;
            }
            if (code < 32) continue;
            buffer += ch;
            stdout.write('*'); // Confirms typing registered, without the content.
          }
        };
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
      });
    } finally {
      this.swapping = false;
      this.open(); // Fresh interface for the questions that follow.
    }
    return value;
  }

  /** A plain question with an optional default and validator. */
  async ask(question, { def = '', validate, allowEmpty = false, allowBack = true } = {}) {
    for (;;) {
      const suffix = def ? style.dim(` [${def}]`) : '';
      const answer = (await this.readLine(`${question}${suffix}: `, { allowBack })).trim() || def;
      if (!answer && !allowEmpty) {
        stdout.write(`  ${icon.bad} This one is required.\n`);
        continue;
      }
      if (validate) {
        const problem = validate(answer);
        if (problem) {
          stdout.write(`  ${icon.bad} ${problem}\n`);
          continue;
        }
      }
      return answer;
    }
  }

  async askSecret(question, { allowEmpty = false, allowBack = true } = {}) {
    for (;;) {
      const answer = (await this.readSecret(`${question}: `)).trim();
      if (allowBack && BACK_WORDS.includes(answer.toLowerCase())) throw backError();
      if (!answer && !allowEmpty) {
        stdout.write(`  ${icon.bad} This one is required.\n`);
        continue;
      }
      return answer;
    }
  }

  async confirm(question, def = true, { allowBack = true } = {}) {
    const hint = def ? 'Y/n' : 'y/N';
    for (;;) {
      const answer = (await this.readLine(`${question} ${style.dim(`(${hint})`)} `, { allowBack }))
        .trim()
        .toLowerCase();
      if (!answer) return def;
      if (['y', 'yes'].includes(answer)) return true;
      if (['n', 'no'].includes(answer)) return false;
      stdout.write(`  ${icon.bad} Please answer y or n.\n`);
    }
  }

  /** `choices` is [{ value, label, hint }]. Returns the chosen value. */
  async choose(question, choices, defIndex = 0, { allowBack = true } = {}) {
    stdout.write(`${question}\n`);
    choices.forEach((c, i) => {
      const mark = i === defIndex ? style.bold('→') : ' ';
      stdout.write(`  ${mark} ${style.bold(String(i + 1))}. ${c.label}${c.hint ? style.dim(` — ${c.hint}`) : ''}\n`);
    });
    for (;;) {
      const answer = (await this.readLine(`Choice ${style.dim(`[${defIndex + 1}]`)}: `, { allowBack })).trim();
      const n = answer ? Number(answer) : defIndex + 1;
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
      stdout.write(`  ${icon.bad} Enter a number between 1 and ${choices.length}.\n`);
    }
  }
}

export function heading(text) {
  stdout.write(`\n${style.bold(text)}\n${style.dim('─'.repeat(Math.min(text.length, 60)))}\n`);
}

export function say(text = '') {
  stdout.write(`${text}\n`);
}

export function detail(text) {
  stdout.write(`${style.dim(`  ${text}`)}\n`);
}
