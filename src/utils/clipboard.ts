import { execFile, spawn } from 'node:child_process';

type Command = [string, string[]];

function readCommands(): Command[] {
  if (process.platform === 'darwin') return [['pbpaste', []]];
  if (process.platform === 'win32') return [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']]];
  return [
    ['wl-paste', ['--no-newline']],
    ['xclip', ['-selection', 'clipboard', '-o']],
    ['xsel', ['--clipboard', '--output']],
  ];
}

function writeCommands(): Command[] {
  if (process.platform === 'darwin') return [['pbcopy', []]];
  if (process.platform === 'win32') return [['clip', []]];
  return [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];
}

export async function readClipboard(): Promise<string | null> {
  for (const [cmd, args] of readCommands()) {
    const text = await new Promise<string | null>((resolve) => {
      execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        resolve(error ? null : stdout);
      });
    });
    if (text !== null) return text;
  }
  return null;
}

export async function writeClipboard(text: string): Promise<boolean> {
  for (const [cmd, args] of writeCommands()) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.stdin.end(text);
    });
    if (ok) return true;
  }
  return false;
}
