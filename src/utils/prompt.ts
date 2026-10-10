import readline from 'node:readline';
import { Writable } from 'node:stream';

export class PromptCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'PromptCancelledError';
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function ask(question: string, hidden: boolean): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  // terminal: true puts stdin in raw mode, which also avoids macOS's 1024-byte limit on pasted lines.
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.on('SIGINT', () => {
      rl.close();
      process.stdout.write('\n');
    });
    // Ctrl+C, Ctrl+D or the terminal going away all close the prompt without an answer.
    rl.on('close', () => {
      if (!answered) reject(new PromptCancelledError());
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    muted = hidden;
  });
}

export function promptLine(question: string): Promise<string> {
  return ask(question, false);
}

/** Like promptLine, but doesn't echo what's typed or pasted (for tokens). */
export function promptHidden(question: string): Promise<string> {
  return ask(question, true);
}
