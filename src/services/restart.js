// Self-restart support (=restart / /restart): the bot spawns a fresh copy of its own
// process (same entry script, runtime flags and inherited environment - values loaded
// by --env-file/.env survive via process.env), tags it with GUILDFRAME_AUTO_INSTALL=1
// so the new instance automatically re-runs the full /install setup at boot, and then
// stops itself.
import { execFileSync, spawn } from 'node:child_process';

export const AUTO_INSTALL_ENV = 'GUILDFRAME_AUTO_INSTALL';

// `node --watch <script>` keeps the --watch flag in its supervisor process (the parent
// of the watched process); process.execArgv inside the watched process never contains
// it. The parent is only the watch supervisor when its command line contains both
// node and --watch (anything else - a shell, npm, plain node - must never be killed).
function findWatchSupervisorPid() {
  try {
    const ppid = process.ppid;
    if (!ppid) return null;
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(ppid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /node/i.test(command) && command.includes('--watch') ? ppid : null;
  } catch {
    return null;
  }
}

// Boots the replacement process and exits. Throws only when the entry script cannot be
// determined - every other step is logged, never thrown, so the caller can exit safely.
export function restartProcess({ reason = null } = {}) {
  const entry = process.argv[1];
  if (!entry) throw new Error('Cannot determine the entry script of this process.');

  const child = spawn(process.execPath, [...process.execArgv, entry], {
    cwd: process.cwd(),
    detached: true, // survives the death of this process (own process group)
    stdio: 'inherit', // keep logging into the same terminal
    env: { ...process.env, [AUTO_INSTALL_ENV]: '1' },
  });
  child.unref();
  console.log(`[restart] Spawned the new instance (pid ${child.pid})${reason ? ` - ${reason}` : ''}.`);
  console.log('[restart] Auto-install is enabled for the new instance (GUILDFRAME_AUTO_INSTALL=1).');

  // When running under `node --watch`, stop the watcher as well: it does not restart
  // the app on exit and would instead spawn a duplicate bot on the next file change.
  const supervisorPid = findWatchSupervisorPid();
  if (supervisorPid) {
    try {
      process.kill(supervisorPid, 'SIGTERM');
      console.log(
        '[restart] Stopped the node --watch supervisor - the bot now runs as an independent process. Run `npm run dev` again to return to watch mode.',
      );
    } catch (err) {
      console.warn(`[restart] Could not stop the node --watch supervisor: ${err.message}`);
      console.warn('[restart] It may respawn a duplicate instance on the next file change.');
    }
  }

  process.exit(0);
}
