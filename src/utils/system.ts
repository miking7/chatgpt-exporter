import { execFile, spawn } from 'node:child_process';

/** Keeps a Mac from idle-sleeping until the returned function is called or this process exits. */
export function keepAwake(): () => void {
  if (process.platform !== 'darwin') return () => {};
  try {
    const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return () => {
      if (child.exitCode === null) child.kill();
    };
  } catch {
    return () => {};
  }
}

/** Shows a macOS notification; used when an unattended run needs the user to sign in again. */
export function notify(title: string, message: string): void {
  if (process.platform !== 'darwin') return;
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  execFile('osascript', ['-e', script], () => {});
}
