// PoC 드라이버: node-pty로 interactive claude 세션(-p 없음)을 띄우고,
// 프롬프트를 PTY stdin에 주입한 뒤, Claude가 report_result MCP tool로
// 결과를 회수하는 왕복이 실제로 되는지 검증한다.
import pty from 'node-pty';
import { writeFileSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..'); // star-cliproxy (claude로 작업한 신뢰 폴더)
const work = mkdtempSync(join(tmpdir(), 'channel-poc-'));
const RESULT_FILE = join(work, 'result.json');
const MCP_CONFIG = join(work, 'mcp.json');

writeFileSync(MCP_CONFIG, JSON.stringify({
  mcpServers: {
    reporter: {
      type: 'stdio',
      command: 'node',
      args: [join(here, 'mcp-server.mjs')],
      env: { POC_RESULT_FILE: RESULT_FILE },
    },
  },
}));

// 중첩 claude 감지 방지: 부모 Claude Code 세션의 환경변수 제거 (provider.getCleanEnv와 동일)
const cleanEnv = { ...process.env };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENABLE_TASKS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS']) {
  delete cleanEnv[k];
}

const PROMPT = 'Compute 17 multiplied by 23. Then call the report_result tool with just the resulting number as the payload.';

console.log('[poc] result file :', RESULT_FILE);
console.log('[poc] mcp config  :', MCP_CONFIG);
console.log('[poc] spawning interactive `claude` (NO -p) via PTY...\n');

const term = pty.spawn('claude', [
  '--mcp-config', MCP_CONFIG,
  '--dangerously-skip-permissions',
  '--append-system-prompt',
  'When you finish the task you MUST call the report_result MCP tool with your final answer as the payload. Do not only print the answer in chat — the tool call is how the result is delivered.',
  '--model', 'claude-sonnet-4-6',
], { name: 'xterm-256color', cols: 120, rows: 40, cwd: projectRoot, env: cleanEnv });

let injected = false;
const startedAt = Date.now();

term.onData((d) => process.stdout.write(d));

const iv = setInterval(() => {
  if (existsSync(RESULT_FILE)) {
    console.log('\n\n[poc] ✅ RESULT CAPTURED via MCP report_result tool:');
    console.log(readFileSync(RESULT_FILE, 'utf8'));
    clearInterval(iv);
    try { term.kill(); } catch { /* ignore */ }
    process.exit(0);
  }
  // TUI가 뜬 뒤 한 번만 프롬프트 주입
  if (!injected && Date.now() - startedAt > 5000) {
    console.log('\n[poc] >>> injecting prompt into PTY stdin\n');
    term.write(PROMPT);
    setTimeout(() => term.write('\r'), 600);
    injected = true;
  }
  if (Date.now() - startedAt > 120_000) {
    console.log('\n[poc] ❌ TIMEOUT — report_result not called within 120s');
    clearInterval(iv);
    try { term.kill(); } catch { /* ignore */ }
    process.exit(1);
  }
}, 1000);

term.onExit(({ exitCode }) => {
  if (!existsSync(RESULT_FILE)) {
    console.log(`\n[poc] claude session exited (code ${exitCode}) before reporting a result.`);
    clearInterval(iv);
    process.exit(2);
  }
});
