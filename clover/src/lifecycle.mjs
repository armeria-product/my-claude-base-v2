import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function sessionsDir() {
  return process.env.RELAY_SESSIONS_DIR || path.join(__dirname, '..', 'run', 'sessions');
}

// The harness ON/OFF switch (.claude/.relay-status, CLAUDE.md §1.8) decides not just whether
// external models may be *called*, but whether the relay server may *start at all*. Reason: while
// the relay is up, ANTHROPIC_BASE_URL points at it, and every feature that pairs with claude.ai's
// own backend (remote control and its slash commands) stops existing. A relay left running under an
// OFF switch therefore breaks those features silently, with nothing on screen naming the cause.
// RELAY_STATUS_FILE overrides the path, mirroring RELAY_SESSIONS_DIR above (tests need it: the real
// file is normally OFF, which would otherwise make every launcher test see a disabled relay).
export function relayStatusFile() {
  return process.env.RELAY_STATUS_FILE || path.join(__dirname, '..', '..', '.claude', '.relay-status');
}

// Missing or unreadable counts as OFF — the same safe-side rule the harness hooks use
// (relay-required-agent.js), and the one a fresh clone needs: .relay-status is gitignored, so there
// is no file until someone deliberately turns the relay on.
export function relayEnabled() {
  try {
    return fs.readFileSync(relayStatusFile(), 'utf8').trim().toUpperCase() === 'ON';
  } catch {
    return false;
  }
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
