import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function sessionsDir() {
  return process.env.RELAY_SESSIONS_DIR || path.join(__dirname, '..', 'run', 'sessions');
}

export function sweepSessions() {
  const dir = sessionsDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  let alive = 0;
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 0) {
        fs.unlinkSync(file);
        continue;
      }
      try {
        process.kill(pid, 0);
        alive++;
      } catch (e) {
        if (e.code === 'EPERM') {
          alive++;
        } else {
          fs.unlinkSync(file);
        }
      }
    } catch {}
  }
  return alive;
}

export function hasLiveSessions() {
  return sweepSessions() > 0;
}
