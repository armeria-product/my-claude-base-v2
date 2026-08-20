import { checkPolicy, denial } from './lib/policy.mjs';
import { readPayload } from './lib/runtime.mjs';

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const reason = checkPolicy(readPayload(raw));
    if (reason) process.stdout.write(denial(reason));
  } catch (error) {
    process.stdout.write(denial(`安全ポリシーの確認に失敗したため実行を止めました: ${error.message}`));
  }
});
