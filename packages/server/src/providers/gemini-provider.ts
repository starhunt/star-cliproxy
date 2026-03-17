import type { ExecuteOptions, ExecuteResult, StreamChunk, ProviderConfigYaml } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { readFile, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const prompt = convertMessagesToSinglePrompt(options.messages);
    const model = options.model || this.config.default_model;

    const args: string[] = [
      '-p', prompt,
      '-m', model,
      '-o', options.stream ? 'stream-json' : 'json',
    ];

    args.push(...this.config.extra_args);
    return args;
  }

  // spawn() + 파일 스트림으로 stdout 캡처 (exec shell injection 방지)
  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const args = this.buildArgs({ ...options, stream: false });
    const tmpFile = join(tmpdir(), `gemini-out-${randomBytes(8).toString('hex')}.json`);

    try {
      // shell 리다이렉트로 실행: spawn의 stdout pipe 잘림 문제 완전 우회
      const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      const shellCmd = `${this.config.cli_path} ${escapedArgs} > '${tmpFile}' 2>/dev/null`;

      await new Promise<void>((resolve, reject) => {
        const child = spawn('sh', ['-c', shellCmd], {
          stdio: 'ignore',
          env: this._cleanEnv(),
          cwd: tmpdir(),
        });

        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`gemini CLI timed out after ${this.config.timeout_ms}ms`));
        }, this.config.timeout_ms);

        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(new Error(`Failed to spawn gemini CLI: ${err.message}`));
        });

        child.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      const stdout = await readFile(tmpFile, 'utf-8');
      console.log(`[Gemini] tmpFile size: ${stdout.length} bytes`);
      return this.parseNonStreamOutput(stdout);
    } catch (err) {
      // 에러 시에도 부분 출력이 파일에 있을 수 있음
      try {
        const stdout = await readFile(tmpFile, 'utf-8');
        if (stdout.trim()) {
          return this.parseNonStreamOutput(stdout);
        }
      } catch { /* 파일 없음 */ }
      throw err;
    } finally {
      try { await unlink(tmpFile); } catch { /* 이미 없으면 무시 */ }
    }
  }

  // 환경변수 정리 (부모 프로세스의 Claude Code 변수 제거)
  private _cleanEnv(): Record<string, string | undefined> {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.CLAUDE_CODE_ENABLE_TASKS;
    delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    return env;
  }

  // Gemini json 출력에서 결과 추출
  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { content: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'error' };
    }

    // JSON 파싱 우선 시도
    console.log(`[Gemini parseNonStreamOutput] input length: ${trimmed.length}, starts: ${JSON.stringify(trimmed.slice(0, 80))}, ends: ${JSON.stringify(trimmed.slice(-80))}`);
    try {
      const data = JSON.parse(trimmed);
      console.log(`[Gemini] JSON.parse SUCCESS, keys: ${Object.keys(data).join(',')}`);

      let content = data.response ?? data.result ?? data.text ?? data.content ?? '';
      // 리터럴 \n 복원
      if (typeof content === 'string' && content.includes('\\n')) {
        content = content.replace(/\\n/g, '\n');
      }
      const inputTokens = data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0;

      return {
        content,
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        finishReason: 'stop',
      };
    } catch (e) {
      console.log(`[Gemini] JSON.parse FAILED: ${(e as Error).message}`);
      // JSON 실패 → JSON 객체 추출 시도
      const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[0]);
          let content = data.response ?? data.result ?? data.text ?? data.content ?? '';
          if (typeof content === 'string' && content.includes('\\n')) {
            content = content.replace(/\\n/g, '\n');
          }
          return {
            content,
            usage: { promptTokens: 0, completionTokens: Math.ceil(content.length / 4), totalTokens: Math.ceil(content.length / 4) },
            finishReason: 'stop',
          };
        } catch { /* fallback */ }
      }

      // "response" 필드를 정규식으로 추출
      const responseMatch = trimmed.match(/"response"\s*:\s*"([\s\S]*)$/);
      if (responseMatch) {
        let content = responseMatch[1];
        content = content.replace(/"\s*,?\s*"session_id[\s\S]*$/, '');
        content = content.replace(/"\s*\}\s*$/, '');
        content = content
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
        return {
          content,
          usage: { promptTokens: 0, completionTokens: Math.ceil(content.length / 4), totalTokens: Math.ceil(content.length / 4) },
          finishReason: 'stop',
        };
      }

      // 최종 fallback
      return super.parseNonStreamOutput(stdout);
    }
  }

  // 스트리밍: non-streaming 결과를 청크로 분할
  override async *executeStream(options: ExecuteOptions): AsyncIterable<StreamChunk> {
    const result = await this.execute(options);
    const content = result.content;

    const chunkSize = 20;
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.substring(i, i + chunkSize);
      yield { type: 'delta', content: chunk };
    }

    yield { type: 'done', usage: result.usage };
  }
}
