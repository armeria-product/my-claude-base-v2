#!/usr/bin/env node
// clover 中継の起動役（クロスプラットフォーム）。
// シェル関数 `claude` から呼ばれ、中継（router/shim）を自動で立ち上げ、接続先 URL を STDOUT に
// 1行だけ出す（到達できなければ STDOUT は空）。claude 本体の起動はシェル側のネイティブ機能に
// 任せる（このスクリプトは claude を一切 spawn しない＝引数のクォート/エスケープ問題が構造的に無い）。
// 中継が立たなくても exit 0 で終わる（フォールバック＝呼び出し元のシェルは必ず継続できる）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { sessionsDir, sweepSessions } from '../src/lifecycle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(__dirname, '..', 'src', 'codex-responses-shim.mjs');
const ROUTER = path.join(__dirname, '..', 'src', 'router.mjs');
const LOG = path.join(__dirname, '..', 'relay.log');
const HOST = '127.0.0.1';
const SHIM_PORT = Number(process.env.SHIM_PORT || 8791);
const ROUTER_PORT = Number(process.env.ROUTER_PORT || 8788);

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// GET / の 200 だけでは、別サーバがたまたまそのポートを占有していても up 扱いになり、
// routed=true として ANTHROPIC_BASE_URL をそこへ向けてしまう（メイン会話が全滅する）。
// model id は claude-<alias> 形式で本物の Anthropic id（claude-opus-...等）と見分けが付かないため、
// router だけは応答本体の x_clover_relay マーカーで本物の clover router かどうかを確認する。
function pingRouter(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/v1/models', timeout: 1000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(false);
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(json?.x_clover_relay === true);
        } catch {
          resolve(false);
        }
      });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function spawnBackground(script, port) {
  const fd = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, PORT: String(port), RELAY_IDLE_MS: process.env.RELAY_IDLE_MS || '600000' },
  });
  // 子は fd を複製(dup)済みなので、親側はここで閉じてよい（開いたまま持ち続けるとこのランチャーの
  // プロセス生存中ハンドルを握り続けてしまう）。
  fs.closeSync(fd);
  // spawn 失敗は非同期の 'error' で届く。リスナが無いと unhandled でランチャーごと落ち、
  // フォールバックにすら進めなくなる（5行目の不変条件が壊れる）ため、無視して拾うだけにする。
  child.on('error', () => {});
  child.unref();
}

async function waitUp(port, tries = 10, intervalMs = 400) {
  for (let i = 0; i < tries; i++) {
    if (await pingRouter(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return pingRouter(port);
}

async function ensureUp() {
  if (!(await ping(SHIM_PORT))) spawnBackground(SHIM, SHIM_PORT);
  if (!(await pingRouter(ROUTER_PORT))) spawnBackground(ROUTER, ROUTER_PORT);
  return waitUp(ROUTER_PORT);
}

// models.json の先頭モデルを /model ピッカーに「カスタムモデル」として1件出すための値。
// gateway discovery は API キー認証前提でサブスク認証では発火しないため、/model に確実に
// 1件出す口はこの ANTHROPIC_CUSTOM_MODEL_OPTION だけ。2件目以降は /model claude-<alias> か
// --model claude-<alias> で明示指定する（router 側は alias 完全一致で解決するので一覧に無くても動く）。
function primaryModelOption() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'models.json'), 'utf8'));
    const first = (cfg.models || [])[0];
    if (!first || !first.alias) return null;
    return { id: `claude-${first.alias}`, name: `${first.model || first.alias} (clover)` };
  } catch {
    return null;
  }
}

// routed 時は「シェルが claude に渡す環境変数」を KEY=VALUE 形式で1行ずつ STDOUT に出す
// （呼び出し元のシェル関数がこれを読んで env にセットする）。未到達なら STDOUT は空（フォールバック）。
async function main() {
  sweepSessions();

  let routed = false;
  try {
    routed = await ensureUp();
  } catch {
    routed = false;
  }

  if (routed) {
    console.error('clover: 中継経由で起動します（/model に GPT が出ます）');
    // gateway discovery（GET /v1/models を叩いて全モデルを一覧表示する公式機能）は API キー /
    // ANTHROPIC_AUTH_TOKEN 認証が前提で、サブスク（Claude Max 等）の OAuth ログインでは発火しない
    // （実測済み）。そのため CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY は付けない。/model に確実に
    // 出せるのは ANTHROPIC_CUSTOM_MODEL_OPTION の1件のみ。
    const out = [`ANTHROPIC_BASE_URL=http://${HOST}:${ROUTER_PORT}`];
    const pm = primaryModelOption();
    if (pm) {
      out.push(`ANTHROPIC_CUSTOM_MODEL_OPTION=${pm.id}`);
      out.push(`ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=${pm.name}`);
    }
    // Session registry entry: lets the idle reaper in router.mjs/codex-responses-shim.mjs know
    // this launcher's caller (the parent shell) is still alive, deferring auto-shutdown.
    // Best-effort: a failure here (disk full, locked file, etc.) must not stop the env lines
    // below from reaching STDOUT -- the idle reaper is the fallback if registration is skipped.
    try {
      const dir = sessionsDir();
      fs.mkdirSync(dir, { recursive: true });
      const sessionFile = path.join(dir, `${process.ppid}-${crypto.randomBytes(3).toString('hex')}`);
      fs.writeFileSync(sessionFile, String(process.ppid));
      out.push(`CLOVER_SESSION_FILE=${sessionFile}`);
    } catch {}
    process.stdout.write(out.join('\n') + '\n');
  } else {
    console.error('clover: 中継を起動できませんでした。通常の Claude で起動します（GPT は使えません）');
  }
  process.exit(0);
}

main();
