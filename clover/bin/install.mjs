#!/usr/bin/env node
// clover claude ラッパーを PowerShell プロファイルへ自動インストールするスクリプト。
// 手動コピー＆<REPO>手置換は事故りやすい（例: バックスラッシュ抜けでドライブ相対パス化）ため、
// 1コマンドで「置換 → 書き込み → 機械検証」まで完結させ、検証に落ちたら書き込み前に戻す。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// v2: clover lives at the repo root (clover/bin -> up 2 = repo root; v1 was .claude/clover/bin -> up 3)
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SNIPPET_PATH = path.join(__dirname, 'clover-claude.ps1.snippet');
const BASH_SNIPPET_PATH = path.join(__dirname, 'clover-claude.bash.snippet');
const RUN_DIR = process.env.CLOVER_RUN_DIR || path.join(__dirname, '..', 'run');
const NO_AUTO_INSTALL_PATH = path.join(RUN_DIR, '.no-auto-install');
const PROFILE_PATH_CACHE = path.join(RUN_DIR, '.profile-path');

function currentPlatform() {
  return process.env.CLOVER_FORCE_PLATFORM || process.platform;
}

// Windows のバックスラッシュ区切り絶対パスを bash/zsh 用の POSIX 形式（/ 区切り）へ変換する。
// Windows 側（buildBlock への REPO_ROOT の直接利用）には影響しない、非win32専用の変換。
function toPosixPath(p) {
  return p.replace(/\\/g, '/');
}

const OPEN_NEW = '# >>> clover claude wrapper (managed; remove this block to uninstall) >>>';
const OPEN_OLD = '# >>> clover claude wrapper >>>';
const CLOSE_MARK = '# <<< clover claude wrapper <<<';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blockRegex() {
  // 新形式・旧形式どちらの OPEN も検出し、丸ごと新形式ブロックへ置き換える対象にする。
  const open = `(?:${escapeRegExp(OPEN_NEW)}|${escapeRegExp(OPEN_OLD)})`;
  return new RegExp(`${open}[\\s\\S]*?${escapeRegExp(CLOSE_MARK)}\\n?`, 'g');
}

// キャッシュされたプロファイルパスを読む。ファイルが無い/読めない/U+FFFD(文字化けの証拠)を含む
// 場合は null を返す（呼び出し側は本解決にフォールバックする）。
function readCachedProfilePath() {
  try {
    const p = fs.readFileSync(PROFILE_PATH_CACHE, 'utf8').trim();
    if (!p || p.includes('�')) return null;
    return p;
  } catch {
    return null;
  }
}

function writeCachedProfilePath(profilePath) {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(PROFILE_PATH_CACHE, profilePath, 'utf8');
  } catch {
    // キャッシュ書き込み失敗は致命的ではない（次回また本解決すればよい）。
  }
}

function resolveProfilePath(platform) {
  if (process.env.CLOVER_PROFILE_PATH) return process.env.CLOVER_PROFILE_PATH.trim();
  if (platform !== 'win32') {
    const shell = process.env.SHELL || '';
    const rcName = shell.includes('zsh') ? '.zshrc' : '.bashrc';
    return path.join(os.homedir(), rcName);
  }
  try {
    // PowerShell 5.1 の標準出力は既定で OS のコードページ(日本語環境では cp932)。それを utf8 と
    // して読むと「ドキュメント」等の日本語パスが化け、化けた名前の偽フォルダへ書き込んでしまう
    // (実際に起きた事故)。出力エンコーディングを UTF-8 に切り替えてから出力させる。
    const psScript = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $PROFILE.CurrentUserAllHosts';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' });
    const p = out.trim();
    // U+FFFD(置換文字) はデコード失敗の証拠。化けたパスに書き込む前に必ず止める。
    if (p.includes('�')) throw new Error(`パスの文字化けを検出しました: ${p}`);
    return p;
  } catch (err) {
    throw new Error(`PowerShell からプロファイルパスを取得できませんでした: ${err.message}`);
  }
}

function buildBlock(repoRoot, snippetPath = SNIPPET_PATH) {
  const snippet = fs.readFileSync(snippetPath, 'utf8');
  const body = snippet.replaceAll('<REPO>', repoRoot);
  return `${OPEN_NEW}\n${body}${body.endsWith('\n') ? '' : '\n'}${CLOSE_MARK}\n`;
}

// 書き込み後の機械検証。1つでも失敗すれば例外を投げる（呼び出し側でロールバックする）。
// プロファイルパスは省略可能（省略時は構文チェックをスキップする＝文字列単体のテストで使う）。
// platform は win32/非win32で検証内容を切り替える（既定 win32 = 従来どおりの互換動作）。
function verifyProfileContent(content, repoRoot, profilePath, platform = 'win32') {
  if (content.includes('<REPO>')) {
    throw new Error('<REPO> のプレースホルダが置換されずに残っています');
  }

  if (platform !== 'win32') {
    const needle = `${repoRoot}/clover`;
    if (!content.includes(needle) || needle.includes('\\')) {
      throw new Error(`リポジトリの絶対パス（${needle}）がプロファイル内に見つかりません`);
    }
    if (!process.env.CLOVER_SKIP_PARSE && profilePath) {
      try {
        execFileSync('bash', ['-n', profilePath], { encoding: 'utf8' });
      } catch (err) {
        if (err.code === 'ENOENT') {
          // bash が無い環境では構文チェックをスキップする。
        } else {
          throw new Error(`bash 構文チェックがエラーを報告しました: ${err.message}`);
        }
      }
    }
    return true;
  }

  const needle = `${repoRoot}\\clover`;
  if (!content.includes(needle)) {
    throw new Error(`リポジトリの絶対パス（${needle}）がプロファイル内に見つかりません`);
  }
  const block = content.match(blockRegex())?.[0] ?? '';
  if (/[^\x00-\x7F]/.test(block)) {
    throw new Error('管理ブロックに非ASCII文字が混入しています');
  }
  if (!process.env.CLOVER_SKIP_PARSE && profilePath) {
    try {
      const psScript = `$errs = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${profilePath.replace(/'/g, "''")}', [ref]$null, [ref]$errs); if ($errs) { $errs | ForEach-Object { $_.Message } }`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' });
      if (out && out.trim()) throw new Error(`PowerShell 構文チェックがエラーを報告しました: ${out.trim()}`);
    } catch (err) {
      if (err.message.startsWith('PowerShell 構文チェック')) throw err;
      throw new Error(`PowerShell 構文チェックに失敗しました: ${err.message}`);
    }
  }
  return true;
}

// セッション開始時の自動実行。既に入っていれば何もしない・失敗してもセッション開始を邪魔しない
// (fail-open) ため、どんな経路でも exit 0 で終わる。
function runAuto() {
  try {
    if (fs.existsSync(NO_AUTO_INSTALL_PATH)) {
      process.exit(0);
    }

    const cached = readCachedProfilePath();
    if (cached && fs.existsSync(cached)) {
      const content = fs.readFileSync(cached, 'utf8');
      if (blockRegex().test(content)) {
        process.exit(0);
      }
    }

    const platform = currentPlatform();
    const profilePath = resolveProfilePath(platform);
    const existed = fs.existsSync(profilePath);
    const backup = existed ? fs.readFileSync(profilePath, 'utf8') : null;

    if (existed && blockRegex().test(backup)) {
      writeCachedProfilePath(profilePath);
      process.exit(0);
    }

    doInstall(platform, profilePath, existed, backup);
    writeCachedProfilePath(profilePath);
    process.stdout.write('clover: claude ラッパーを自動インストールしました（新しいシェルから有効）\n');
    process.exit(0);
  } catch (err) {
    console.error(`clover install --auto: 自動インストールをスキップしました（原因: ${err.message}）`);
    process.exit(0);
  }
}

// プロファイルへの実書き込み＋検証＋ロールバックの本体。呼び出し側で profilePath/existed/backup を
// 用意する（--auto はキャッシュ判定を先に済ませているため、resolveProfilePath を再度呼ばない）。
// 検証失敗時は書き込みをロールバックした上で例外を投げる（呼び出し側が exit コードを決める。
// ここで process.exit すると runAuto の fail-open try/catch を素通りしてしまうため呼ばない）。
function doInstall(platform, profilePath, existed, backup) {
  const repoRoot = platform === 'win32' ? REPO_ROOT : toPosixPath(REPO_ROOT);
  const snippetPath = platform === 'win32' ? SNIPPET_PATH : BASH_SNIPPET_PATH;
  const block = buildBlock(repoRoot, snippetPath);
  let nextContent;
  if (existed && blockRegex().test(backup)) {
    nextContent = backup.replace(blockRegex(), block);
  } else if (existed) {
    const sep = backup.endsWith('\n') ? '\n' : '\n\n';
    nextContent = backup + sep + block;
  } else {
    nextContent = block;
  }

  const dir = path.dirname(profilePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(profilePath, nextContent, 'utf8');

  try {
    verifyProfileContent(nextContent, repoRoot, profilePath, platform);
  } catch (err) {
    if (existed) {
      fs.writeFileSync(profilePath, backup, 'utf8');
    } else {
      fs.rmSync(profilePath, { force: true });
    }
    throw new Error(`検証に失敗したため書き込みを取り消しました。原因: ${err.message}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const uninstall = args.includes('--uninstall');
  const auto = args.includes('--auto');

  if (auto) {
    runAuto();
    return;
  }

  const platform = currentPlatform();

  let profilePath;
  try {
    profilePath = resolveProfilePath(platform);
  } catch (err) {
    console.error(`clover install: ${err.message}`);
    process.exit(1);
  }
  const existed = fs.existsSync(profilePath);
  const backup = existed ? fs.readFileSync(profilePath, 'utf8') : null;

  if (uninstall) {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(NO_AUTO_INSTALL_PATH, '', 'utf8');

    if (!existed) {
      process.stdout.write('プロファイルファイルが存在しないため、何もしませんでした。\n');
      process.exit(0);
    }
    const stripped = backup.replace(blockRegex(), '');
    if (stripped === backup) {
      process.stdout.write('管理ブロックが見つからなかったため、何もしませんでした。\n');
      process.exit(0);
    }
    fs.writeFileSync(profilePath, stripped, 'utf8');
    process.stdout.write(`clover claude wrapper を ${profilePath} から削除しました。\n`);
    process.exit(0);
  }

  try {
    doInstall(platform, profilePath, existed, backup);
  } catch (err) {
    console.error(`clover install: ${err.message}`);
    process.exit(1);
  }
  writeCachedProfilePath(profilePath);
  fs.rmSync(NO_AUTO_INSTALL_PATH, { force: true });

  const shellHint = platform === 'win32' ? '新しい PowerShell ウィンドウ' : 'シェル再起動、または source コマンド';
  process.stdout.write(`clover claude wrapper を ${profilePath} にインストールしました（${shellHint}から有効になります）。\n`);
}

export { buildBlock, verifyProfileContent, blockRegex, REPO_ROOT, toPosixPath, RUN_DIR, NO_AUTO_INSTALL_PATH, PROFILE_PATH_CACHE };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
