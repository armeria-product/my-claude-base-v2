#!/usr/bin/env node
// SessionStart hook: clover claude ラッパーをプロファイルへ自動インストールする（初回だけ実質仕事をする）。
// 実処理は install.mjs --auto に丸投げする薄いラッパー（重複実装しない）。
// install.mjs 側が既に fail-open（.no-auto-install があれば何もしない、失敗しても exit 0）なので、
// このフックは spawn するだけでよい。stdin(JSON) は使わない。
// Output: 何も出力しない（additionalContext は不要。install.mjs の1行 stdout はそのまま画面に流す）

const path = require('node:path');
const { spawnSync } = require('node:child_process');

try {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const installPath = path.join(projectDir, 'clover', 'bin', 'install.mjs');
  const result = spawnSync(process.execPath, [installPath, '--auto'], { encoding: 'utf8' });
  if (result.stdout && result.stdout.trim()) process.stdout.write(result.stdout);
} catch {
  // フック自体が失敗してもセッション開始を止めない (fail-open)。
}
process.exit(0);
