import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class AlreadyRunningError extends Error {
  constructor(pid: number, startedAt?: string) {
    super(`Another backup is already running (pid ${pid}${startedAt ? `, started ${startedAt}` : ''}).`);
    this.name = 'AlreadyRunningError';
  }
}

export interface Lock {
  release(): Promise<void>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One backup at a time: two runs would each spend the full download allowance. */
export async function acquireLock(dir: string, name = 'backup.lock'): Promise<Lock> {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fsp.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      let released = false;
      const releaseSync = () => {
        if (released) return;
        released = true;
        try {
          fs.unlinkSync(file);
        } catch {
          // Already gone.
        }
      };
      process.once('exit', releaseSync);
      return {
        async release() {
          process.removeListener('exit', releaseSync);
          releaseSync();
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: { pid?: number; startedAt?: string } = {};
      try {
        holder = JSON.parse(await fsp.readFile(file, 'utf-8')) as typeof holder;
      } catch {
        // Unreadable lock: treat as stale.
      }
      if (holder.pid && holder.pid !== process.pid && isAlive(holder.pid)) {
        throw new AlreadyRunningError(holder.pid, holder.startedAt);
      }
      await fsp.rm(file, { force: true });
    }
  }
  throw new Error(`Couldn't create the lock file ${file}`);
}

/** The pid holding the lock, if that process is still alive. */
export async function lockHolder(dir: string, name = 'backup.lock'): Promise<{ pid: number; startedAt?: string } | null> {
  try {
    const holder = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf-8')) as { pid?: number; startedAt?: string };
    return holder.pid && isAlive(holder.pid) ? { pid: holder.pid, startedAt: holder.startedAt } : null;
  } catch {
    return null;
  }
}
