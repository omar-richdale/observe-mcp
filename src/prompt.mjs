/**
 * Terminal prompting with no dependencies, because the wizard has to work the
 * same on Linux, macOS and Windows (PowerShell, cmd, Git Bash, Windows
 * Terminal) and pulling in an interactive-prompt library for four question
 * types is not worth the install.
 *
 * Secrets are read with readline's `_writeToOutput` hook rather than by putting
 * stdin in raw mode: raw mode interacts badly with readline, and on Windows
 * consoles the raw key stream differs enough to be a source of bugs. The hook
 * is stable across Node versions, and there is a visible fallback if it is ever
 * missing — better to warn that typing will be echoed than to echo it silently.
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

export class Prompter {
  constructor() {
    this.rl = createInterface({ input: stdin, output: stdout });
    this.rl.on('SIGINT', () => {
      stdout.write('\nCancelled. Nothing was saved.\n');
      process.exit(130);
    });

    // Queue every line as it arrives rather than relying on rl.question().
    // With piped stdin readline reaches EOF almost immediately and emits all
    // lines up front; question() only captures the line that follows the call,
    // so everything after the first answer would be lost and the wizard could
    // not be scripted or tested non-interactively.
    this.queued = [];
    this.waiting = [];
    this.ended = false;
    this.rl.on('line', (line) => {
      const waiter = this.waiting.shift();
      if (waiter) waiter(line);
      else this.queued.push(line);
    });
    this.rl.on('close', () => {
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

  /** Write the prompt ourselves, since we no longer go through rl.question. */
  async readLine(promptText, { mask = false } = {}) {
    stdout.write(promptText);
    let restore;
    if (mask && stdout.isTTY && typeof this.rl._writeToOutput === 'function') {
      const original = this.rl._writeToOutput.bind(this.rl);
      this.rl._writeToOutput = () => {};
      restore = () => {
        this.rl._writeToOutput = original;
      };
    } else if (mask && stdout.isTTY) {
      stdout.write(`\n  ${icon.warn} This terminal cannot hide input; what you type will be visible.\n${promptText}`);
    }
    try {
      const line = await this.nextLine();
      if (line === null) {
        stdout.write('\n');
        throw Object.assign(new Error('Input ended before setup finished.'), { code: 'INPUT_ENDED' });
      }
      return line;
    } finally {
      if (restore) restore();
      // A terminal supplies the newline when the user presses Enter; piped
      // input does not, so add one to keep scripted output readable.
      if (mask || !stdout.isTTY) stdout.write('\n');
    }
  }

  /** A plain question with an optional default and validator. */
  async ask(question, { def = '', validate, allowEmpty = false } = {}) {
    for (;;) {
      const suffix = def ? style.dim(` [${def}]`) : '';
      const answer = (await this.readLine(`${question}${suffix}: `)).trim() || def;
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

  /** Read a value without echoing it to the terminal or the scrollback. */
  async askSecret(question, { allowEmpty = false } = {}) {
    for (;;) {
      const answer = (await this.readLine(`${question}: `, { mask: true })).trim();
      if (!answer && !allowEmpty) {
        stdout.write(`  ${icon.bad} This one is required.\n`);
        continue;
      }
      return answer;
    }
  }

  async confirm(question, def = true) {
    const hint = def ? 'Y/n' : 'y/N';
    for (;;) {
      const answer = (await this.readLine(`${question} ${style.dim(`(${hint})`)} `)).trim().toLowerCase();
      if (!answer) return def;
      if (['y', 'yes'].includes(answer)) return true;
      if (['n', 'no'].includes(answer)) return false;
      stdout.write(`  ${icon.bad} Please answer y or n.\n`);
    }
  }

  /** `choices` is [{ value, label, hint }]. Returns the chosen value. */
  async choose(question, choices, defIndex = 0) {
    stdout.write(`${question}\n`);
    choices.forEach((c, i) => {
      const mark = i === defIndex ? style.bold('→') : ' ';
      stdout.write(`  ${mark} ${style.bold(String(i + 1))}. ${c.label}${c.hint ? style.dim(` — ${c.hint}`) : ''}\n`);
    });
    for (;;) {
      const answer = (await this.readLine(`Choice ${style.dim(`[${defIndex + 1}]`)}: `)).trim();
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
