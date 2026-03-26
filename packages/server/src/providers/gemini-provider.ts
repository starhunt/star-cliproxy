import type { ExecuteOptions, ExecuteResult, StreamChunk, ProviderConfigYaml } from '@star-cliproxy/shared';
import { BaseProvider, gracefulKill } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  protected override getStdinData(options: ExecuteOptions): string {
    return convertMessagesToSinglePrompt(options.messages);
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const model = options.model || this.config.default_model;

    const args: string[] = [
      '-m', model,
      '-o', options.stream ? 'stream-json' : 'json',
    ];

    args.push(...this.config.extra_args);
    return args;
  }

  // shell redirect로 stdout 완전 수집
  // Gemini CLI는 stdout이 pipe일 때 8KB 버퍼를 마지막에 flush하지 않아 데이터 잘림 발생
  // 파일 리다이렉트(> file)로 우회하면 프로세스 종료 시 OS가 파일을 완전히 flush함
  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const args = this.buildArgs({ ...options, stream: false });
    const tmpFile = join(tmpdir(), `gemini-out-${randomBytes(8).toString('hex')}.json`);

    const stdinData = this.getStdinData({ ...options, stream: false });

    try {
      await new Promise<void>((resolve, reject) => {
        // shell을 통해 stdout을 파일로 리다이렉트
        // { shell: true }로 Node.js가 플랫폼별 셸 자동 선택 (macOS: sh, Windows: cmd.exe)
        // null byte 제거: 일부 셸에서 문자열 종단자로 해석될 수 있음
        const isWin = process.platform === 'win32';
        const shellEscape = isWin
          ? (s: string) => '"' + s.replace(/\x00/g, '').replace(/"/g, '\\"') + '"'
          : (s: string) => "'" + s.replace(/\x00/g, '').replace(/'/g, "'\\''") + "'";
        const shellCmd = [shellEscape(this.config.cli_path), ...args.map(shellEscape)].join(' ') + ' > ' + shellEscape(tmpFile);
        const child = spawn(shellCmd, {
          stdio: ['pipe', 'ignore', 'ignore'],
          shell: true,
          env: this.getCleanEnv(),
          cwd: this.workingDir,
        });

        // stdin으로 프롬프트 전달 후 닫기
        if (stdinData) {
          child.stdin?.write(stdinData);
        }
        child.stdin?.end();

        const timeout = setTimeout(() => {
          gracefulKill(child);
          reject(new Error(`gemini CLI timed out after ${this.config.timeout_ms}ms`));
        }, this.config.timeout_ms);

        // 클라이언트 취소 시 프로세스 정리
        if (options.signal) {
          options.signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            gracefulKill(child);
            reject(new Error('Request cancelled'));
          }, { once: true });
        }

        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(new Error(`Failed to spawn gemini CLI: ${err.message}`));
        });

        child.on('close', (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new Error(`gemini CLI exited with code ${code}`));
          } else {
            resolve();
          }
        });
      });

      const stdout = await readFile(tmpFile, 'utf-8');
      options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout });
      return this.parseNonStreamOutput(stdout);
    } catch (err) {
      // 에러 시에도 부분 출력이 파일에 있을 수 있음
      try {
        const stdout = await readFile(tmpFile, 'utf-8');
        if (stdout.trim()) {
          options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout });
          return this.parseNonStreamOutput(stdout);
        }
      } catch { /* 파일 없음 */ }
      options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stderr: (err as Error).message });
      throw err;
    } finally {
      try { await unlink(tmpFile); } catch { /* 이미 없으면 무시 */ }
    }
  }

  // Gemini json 출력에서 결과 추출
  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { content: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'error' };
    }

    // JSON 파싱 우선 시도
    try {
      const data = JSON.parse(trimmed);

      let content = data.response ?? data.result ?? data.text ?? data.content ?? '';
      // 리터럴 \n 복원
      if (typeof content === 'string' && content.includes('\\n')) {
        content = content.replace(/\\n/g, '\n');
      }

      // stats에서 토큰 정보 추출 시도
      const { inputTokens, outputTokens } = this.extractTokenUsage(data);

      return {
        content,
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        finishReason: 'stop',
      };
    } catch {
      // JSON 실패 → JSON 객체 추출 시도
      const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[0]);
          let content = data.response ?? data.result ?? data.text ?? data.content ?? '';
          if (typeof content === 'string' && content.includes('\\n')) {
            content = content.replace(/\\n/g, '\n');
          }
          const { inputTokens, outputTokens } = this.extractTokenUsage(data);
          return {
            content,
            usage: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens },
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

  // Gemini stats 구조에서 토큰 사용량 추출
  private extractTokenUsage(data: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
    // 직접 usage 필드
    const usage = data.usage as Record<string, number> | undefined;
    if (usage) {
      return {
        inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
        outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
      };
    }

    // Gemini stats 구조: { stats: { models: { "model-name": { tokens: { input, candidates, total } } } } }
    const stats = data.stats as Record<string, unknown> | undefined;
    if (stats?.models && typeof stats.models === 'object') {
      const models = stats.models as Record<string, Record<string, unknown>>;
      const firstModel = Object.values(models)[0];
      if (firstModel?.tokens && typeof firstModel.tokens === 'object') {
        const tokens = firstModel.tokens as Record<string, number>;
        return {
          inputTokens: tokens.input ?? 0,
          outputTokens: tokens.candidates ?? 0,
        };
      }
    }

    return { inputTokens: 0, outputTokens: 0 };
  }

  // 스트리밍: -o stream-json을 pipe로 실시간 파싱
  // Gemini는 delta=true 이벤트로 진짜 실시간 스트리밍 지원
  // BaseProvider.executeStream()이 readline + parser로 처리하므로 오버라이드 불필요
  // (buildArgs에서 stream=true일 때 stream-json 포맷 지정)
}
