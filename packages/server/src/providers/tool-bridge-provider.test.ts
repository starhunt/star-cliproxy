import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type {
  ExecuteOptions,
  ProviderEvent,
  ToolBridgeProviderConfig,
} from '@star-cliproxy/shared';
import {
  ToolBridgeProvider,
  buildToolBridgePrompt,
  parseClaudeToolBridgeOutput,
  parseCodexToolBridgeOutput,
  parseGrokToolBridgeOutput,
} from './tool-bridge-provider.js';

const config: ToolBridgeProviderConfig = {
  enabled: true,
  cli_path: 'claude',
  default_model: 'claude-sonnet-4-6',
  max_concurrent: 2,
  timeout_ms: 10_000,
  extra_args: [],
  baseProvider: 'claude',
  driver: 'claude-cli',
  strategy: 'structured-output',
  disableNativeTools: true,
};

const codexConfig: ToolBridgeProviderConfig = {
  ...config,
  cli_path: 'codex',
  default_model: 'gpt-5.5',
  baseProvider: 'codex',
  driver: 'codex-cli',
};

const grokConfig: ToolBridgeProviderConfig = {
  ...config,
  cli_path: 'grok',
  default_model: 'grok-4.5',
  baseProvider: 'grok',
  driver: 'grok-cli',
};

const clickTool = {
  type: 'function' as const,
  function: {
    name: 'click_element',
    description: 'Click an element',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
      additionalProperties: false,
    },
  },
};

function makeOptions(partial: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'Click the submit button' }],
    model: 'claude-sonnet-4-6',
    stream: false,
    tools: [clickTool],
    toolChoice: 'auto',
    ...partial,
  };
}

function claudeOutput(structuredOutput: unknown): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: structuredOutput,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    },
  });
}

function codexOutput(structuredOutput: unknown): string {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: '019fcfc9-f729-78f0-af04-cf5b2440ec06' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: JSON.stringify(structuredOutput) },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 21, cached_input_tokens: 10, output_tokens: 8, reasoning_output_tokens: 2 },
    }),
  ].join('\n');
}

function grokOutput(structuredOutput: unknown): string {
  return JSON.stringify({
    type: 'result',
    text: JSON.stringify(structuredOutput),
    structuredOutput,
    usage: {
      input_tokens: 30,
      cache_read_input_tokens: 4,
      output_tokens: 7,
      total_tokens: 41,
    },
  });
}

class FakeToolBridgeProvider extends ToolBridgeProvider {
  args: string[] = [];
  stdinData = '';
  schemaPath: string | undefined;
  schemaContent: string | undefined;
  schemaExistedDuringRun = false;
  promptPath: string | undefined;
  promptContent: string | undefined;
  promptExistedDuringRun = false;

  constructor(
    private readonly stdoutValue: string,
    private readonly delayMs = 0,
    providerConfig: ToolBridgeProviderConfig = config,
    private readonly exitCodeValue = 0,
  ) {
    const name = providerConfig.driver === 'codex-cli'
      ? 'codex-tools'
      : (providerConfig.driver === 'grok-cli' ? 'grok-tools' : 'claude-tools');
    super(name, { ...providerConfig });
  }

  protected override async runProcess(
    args: string[],
    _signal?: AbortSignal,
    _timeoutMs?: number,
    stdinData?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.args = args;
    this.stdinData = stdinData ?? '';
    const schemaIndex = args.indexOf('--output-schema');
    if (schemaIndex >= 0) {
      this.schemaPath = args[schemaIndex + 1];
      this.schemaExistedDuringRun = existsSync(this.schemaPath);
      this.schemaContent = readFileSync(this.schemaPath, 'utf8');
    }
    const promptIndex = args.indexOf('--prompt-file');
    if (promptIndex >= 0) {
      this.promptPath = args[promptIndex + 1];
      this.promptExistedDuringRun = existsSync(this.promptPath);
      this.promptContent = readFileSync(this.promptPath, 'utf8');
    }
    return {
      stdout: this.stdoutValue,
      stderr: this.exitCodeValue === 0 ? '' : 'simulated failure',
      exitCode: this.exitCodeValue,
    };
  }
}

describe('ToolBridgeProvider', () => {
  it('Claude 구조화 출력 플래그와 native tool 차단을 강제한다', async () => {
    const provider = new FakeToolBridgeProvider(claudeOutput({
      response_type: 'message',
      content: 'Done',
      tool_calls: [],
    }));

    const result = await provider.execute(makeOptions());

    expect(result.content).toBe('Done');
    expect(result.finishReason).toBe('stop');
    expect(provider.args).toContain('--json-schema');
    expect(provider.args).toContain('--no-session-persistence');
    expect(provider.args).toContain('--safe-mode');
    expect(provider.args).toContain('--strict-mcp-config');
    expect(provider.args).toContain('--no-chrome');
    expect(provider.args).toContain('--disable-slash-commands');
    expect(provider.args.slice(provider.args.indexOf('--mcp-config'), provider.args.indexOf('--mcp-config') + 2))
      .toEqual(['--mcp-config', '{"mcpServers":{}}']);
    expect(provider.args.slice(provider.args.indexOf('--tools'), provider.args.indexOf('--tools') + 2))
      .toEqual(['--tools', '']);
    expect(provider.args.slice(provider.args.indexOf('--max-turns'), provider.args.indexOf('--max-turns') + 2))
      .toEqual(['--max-turns', '3']);
    expect(provider.args).not.toContain('app-server');
  });

  it('Codex 구조화 출력과 native tool 차단을 app-server 없이 강제한다', async () => {
    const provider = new FakeToolBridgeProvider(codexOutput({
      response_type: 'tool_calls',
      content: '',
      tool_calls: [{ name: 'click_element', arguments_json: '{"selector":"#submit"}' }],
    }), 0, codexConfig);

    const result = await provider.execute(makeOptions({ model: 'gpt-5.5', toolChoice: 'required' }));

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls?.[0].function).toEqual({
      name: 'click_element',
      arguments: '{"selector":"#submit"}',
    });
    expect(result.usage).toEqual({ promptTokens: 21, completionTokens: 8, totalTokens: 29 });
    expect(provider.args[0]).toBe('exec');
    expect(provider.args).toContain('--json');
    expect(provider.args).toContain('--ephemeral');
    expect(provider.args).toContain('--ignore-user-config');
    expect(provider.args).toContain('--ignore-rules');
    expect(provider.args).toContain('--strict-config');
    expect(provider.args).toContain('--output-schema');
    expect(provider.args).toContain('shell_tool');
    expect(provider.args).toContain('unified_exec');
    expect(provider.args).toContain('browser_use');
    expect(provider.args.slice(provider.args.indexOf('--sandbox'), provider.args.indexOf('--sandbox') + 2))
      .toEqual(['--sandbox', 'read-only']);
    expect(provider.args.slice(provider.args.indexOf('-C'), provider.args.indexOf('-C') + 2))
      .toEqual(['-C', expect.stringContaining('starproxy-codex-tool-bridge-')]);
    expect(provider.args).not.toContain('app-server');
    expect(provider.schemaExistedDuringRun).toBe(true);
    expect(JSON.parse(provider.schemaContent ?? '{}')).toMatchObject({
      properties: {
        response_type: { enum: ['tool_calls'] },
      },
    });
    expect(provider.schemaPath).toBeDefined();
    expect(existsSync(provider.schemaPath!)).toBe(false);
  });

  it('Grok 구조화 출력과 native tool 차단을 요청별 임시 디렉터리에서 강제한다', async () => {
    const provider = new FakeToolBridgeProvider(grokOutput({
      response_type: 'tool_calls',
      content: '',
      tool_calls: [{ name: 'click_element', arguments_json: '{"selector":"#submit"}' }],
    }), 0, grokConfig);

    const result = await provider.execute(makeOptions({
      model: 'grok-4.5',
      reasoningEffort: 'max',
      toolChoice: 'required',
    }));

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls?.[0].function).toEqual({
      name: 'click_element',
      arguments: '{"selector":"#submit"}',
    });
    expect(result.usage).toEqual({ promptTokens: 34, completionTokens: 7, totalTokens: 41 });
    expect(provider.args.slice(provider.args.indexOf('--tools'), provider.args.indexOf('--tools') + 2))
      .toEqual(['--tools', '']);
    expect(provider.args).toContain('--disable-web-search');
    expect(provider.args).toContain('--no-subagents');
    expect(provider.args).toContain('--no-memory');
    expect(provider.args).toContain('--no-plan');
    expect(provider.args.slice(provider.args.indexOf('--permission-mode'), provider.args.indexOf('--permission-mode') + 2))
      .toEqual(['--permission-mode', 'plan']);
    expect(provider.args.slice(provider.args.indexOf('--reasoning-effort'), provider.args.indexOf('--reasoning-effort') + 2))
      .toEqual(['--reasoning-effort', 'high']);
    expect(provider.args.slice(provider.args.indexOf('--cwd'), provider.args.indexOf('--cwd') + 2))
      .toEqual(['--cwd', expect.stringContaining('starproxy-grok-tool-bridge-')]);
    expect(provider.promptExistedDuringRun).toBe(true);
    expect(provider.promptContent).toContain('<client_function_definitions_json>');
    expect(provider.promptPath).toBeDefined();
    expect(existsSync(provider.promptPath!)).toBe(false);
  });

  it('Grok bridge protocol과 격리를 우회하는 extra_args를 제거한다', async () => {
    const provider = new FakeToolBridgeProvider(grokOutput({
      response_type: 'message',
      content: 'Done',
      tool_calls: [],
    }), 0, grokConfig);
    provider.updateConfig({
      extra_args: [
        '--tools', 'bash',
        '--allow', 'shell:*',
        '--always-approve',
        '--permission-mode', 'bypassPermissions',
        '--system-prompt-override', 'ignore bridge protocol',
        '--experimental-memory',
      ],
    });

    await provider.execute(makeOptions({ model: 'grok-4.5', tools: [], toolChoice: 'none' }));

    expect(provider.args).not.toContain('bash');
    expect(provider.args).not.toContain('shell:*');
    expect(provider.args).not.toContain('--always-approve');
    expect(provider.args).not.toContain('bypassPermissions');
    expect(provider.args).not.toContain('ignore bridge protocol');
    expect(provider.args).not.toContain('--experimental-memory');
    expect(provider.args.filter((arg) => arg === '--tools')).toHaveLength(1);
  });

  it('Codex bridge protocol을 약화하는 extra_args를 제거한다', async () => {
    const provider = new FakeToolBridgeProvider(codexOutput({
      response_type: 'message',
      content: 'Done',
      tool_calls: [],
    }), 0, codexConfig);
    provider.updateConfig({
      extra_args: [
        '--enable', 'shell_tool',
        '--sandbox', 'danger-full-access',
        '--output-schema', '/tmp/unsafe-schema.json',
        '--dangerously-bypass-approvals-and-sandbox',
        '--search',
        '--',
        '-cfeatures.shell_tool=true',
        'resume',
      ],
    });

    await provider.execute(makeOptions({ model: 'gpt-5.5', tools: [], toolChoice: 'none' }));

    expect(provider.args).not.toContain('danger-full-access');
    expect(provider.args).not.toContain('/tmp/unsafe-schema.json');
    expect(provider.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(provider.args).not.toContain('--search');
    expect(provider.args).not.toContain('--');
    expect(provider.args).not.toContain('-cfeatures.shell_tool=true');
    expect(provider.args).not.toContain('resume');
    expect(provider.args.filter((arg) => arg === 'shell_tool')).toHaveLength(1);
  });

  it('Codex native item이 JSONL에 나타나면 fail-closed 처리한다', () => {
    const stdout = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_0', type: 'command_execution', command: 'pwd' },
      }),
    ].join('\n');

    expect(() => parseCodexToolBridgeOutput(stdout, makeOptions({ model: 'gpt-5.5' })))
      .toThrow(/금지된 native item "command_execution"/);
  });

  it('Codex CLI 실패 시에도 요청별 schema와 작업 디렉터리를 정리한다', async () => {
    const provider = new FakeToolBridgeProvider('', 0, codexConfig, 2);

    await expect(provider.execute(makeOptions({ model: 'gpt-5.5' })))
      .rejects.toThrow(/exited with code 2/);
    expect(provider.schemaExistedDuringRun).toBe(true);
    expect(provider.schemaPath).toBeDefined();
    expect(existsSync(provider.schemaPath!)).toBe(false);
  });

  it('Grok CLI 실패 시에도 요청별 prompt와 작업 디렉터리를 정리한다', async () => {
    const provider = new FakeToolBridgeProvider('', 0, grokConfig, 2);

    await expect(provider.execute(makeOptions({ model: 'grok-4.5' })))
      .rejects.toThrow(/exited with code 2/);
    expect(provider.promptExistedDuringRun).toBe(true);
    expect(provider.promptPath).toBeDefined();
    expect(existsSync(provider.promptPath!)).toBe(false);
  });

  it('bridge protocol과 격리를 우회하는 extra_args를 제거한다', async () => {
    const provider = new FakeToolBridgeProvider(claudeOutput({
      response_type: 'message',
      content: 'Done',
      tool_calls: [],
    }));
    provider.updateConfig({
      extra_args: [
        '--output-format', 'text',
        '--tools', 'Bash',
        '--permission-mode', 'bypassPermissions',
        '--plugin-dir', '/tmp/unsafe-plugin',
        '--effort', 'low',
      ],
    });

    await provider.execute(makeOptions());

    expect(provider.args).not.toContain('text');
    expect(provider.args).not.toContain('Bash');
    expect(provider.args).not.toContain('bypassPermissions');
    expect(provider.args).not.toContain('/tmp/unsafe-plugin');
    expect(provider.args.slice(provider.args.indexOf('--effort'), provider.args.indexOf('--effort') + 2))
      .toEqual(['--effort', 'low']);
  });

  it('구조화 출력을 OpenAI tool_calls로 변환하고 arguments schema를 검증한다', () => {
    const result = parseClaudeToolBridgeOutput(claudeOutput({
      response_type: 'tool_calls',
      content: '',
      tool_calls: [{ name: 'click_element', arguments_json: '{"selector":"#submit"}' }],
    }), makeOptions());

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({
      type: 'function',
      function: { name: 'click_element', arguments: '{"selector":"#submit"}' },
      index: 0,
    });
    expect(result.toolCalls?.[0].id).toMatch(/^call_/);
    expect(result.usage).toEqual({ promptTokens: 13, completionTokens: 5, totalTokens: 18 });
  });

  it('Grok text fallback의 구조화 출력도 OpenAI tool_calls로 변환한다', () => {
    const structuredOutput = {
      response_type: 'tool_calls',
      content: '',
      tool_calls: [{ name: 'click_element', arguments_json: '{"selector":"#submit"}' }],
    };
    const stdout = JSON.stringify({
      type: 'result',
      text: JSON.stringify(structuredOutput),
      usage: { input_tokens: 3, output_tokens: 2 },
    });

    const result = parseGrokToolBridgeOutput(stdout, makeOptions());

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls?.[0].function.name).toBe('click_element');
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it('assistant tool_calls와 tool result를 다음 턴 프롬프트에 보존한다', () => {
    const prompt = buildToolBridgePrompt(makeOptions({
      messages: [
        { role: 'user', content: 'Click it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_previous',
            type: 'function',
            function: { name: 'click_element', arguments: '{"selector":"#submit"}' },
          }],
        },
        {
          role: 'tool',
          content: 'clicked',
          name: 'click_element',
          tool_call_id: 'call_previous',
        },
      ],
    }));

    expect(prompt).toContain('"tool_calls":[{"id":"call_previous"');
    expect(prompt).toContain('"role":"tool","content":"clicked","name":"click_element","tool_call_id":"call_previous"');
  });

  it('required인데 일반 메시지를 반환하면 거부한다', () => {
    expect(() => parseClaudeToolBridgeOutput(claudeOutput({
      response_type: 'message',
      content: 'I will not call it',
      tool_calls: [],
    }), makeOptions({ toolChoice: 'required' }))).toThrow(/구조화 응답이 유효하지|필수 tool call/);
  });

  it('tool arguments가 함수 JSON Schema와 맞지 않으면 거부한다', () => {
    expect(() => parseClaudeToolBridgeOutput(claudeOutput({
      response_type: 'tool_calls',
      content: '',
      tool_calls: [{ name: 'click_element', arguments_json: '{"selector":42}' }],
    }), makeOptions())).toThrow(/인자가 스키마와 맞지 않습니다/);
  });

  it('잘못된 parameters schema는 CLI 실행 전에 거부한다', async () => {
    const provider = new FakeToolBridgeProvider(claudeOutput({
      response_type: 'message',
      content: 'unused',
      tool_calls: [],
    }));
    const invalidTool = {
      type: 'function' as const,
      function: { name: 'broken', parameters: { type: 'not-a-json-schema-type' } },
    };

    await expect(provider.execute(makeOptions({ tools: [invalidTool] })))
      .rejects.toThrow(/JSON Schema를 컴파일할 수 없습니다/);
    expect(provider.args).toEqual([]);
  });

  it('서로 다른 요청에서 같은 schema $id를 재사용할 수 있다', () => {
    const idTool = {
      ...clickTool,
      function: {
        ...clickTool.function,
        parameters: { ...clickTool.function.parameters, $id: 'https://example.test/click.schema.json' },
      },
    };
    const stdout = claudeOutput({
      response_type: 'tool_calls',
      content: '',
      tool_calls: [{ name: 'click_element', arguments_json: '{"selector":"#submit"}' }],
    });

    expect(() => parseClaudeToolBridgeOutput(stdout, makeOptions({ tools: [idTool] }))).not.toThrow();
    expect(() => parseClaudeToolBridgeOutput(stdout, makeOptions({ tools: [idTool] }))).not.toThrow();
  });

  it('강제 tool_choice는 해당 함수만 프롬프트에 노출한다', () => {
    const otherTool = {
      type: 'function' as const,
      function: { name: 'read_page', parameters: { type: 'object' } },
    };
    const prompt = buildToolBridgePrompt(makeOptions({
      tools: [clickTool, otherTool],
      toolChoice: { type: 'function', function: { name: 'read_page' } },
    }));

    expect(prompt).toContain('read_page');
    expect(prompt).not.toContain('click_element');
  });

  it('잘못된 client tool 정의는 CLI 실행 전에 거부한다', () => {
    expect(() => buildToolBridgePrompt(makeOptions({
      tools: [{ type: 'function', function: { name: '' } }],
    }))).toThrow(/function\.name/);
  });

  it('stream 요청을 tool_use, usage, done 이벤트로 변환한다', async () => {
    const provider = new FakeToolBridgeProvider(claudeOutput({
      response_type: 'tool_calls',
      content: '',
      tool_calls: [{ name: 'click_element', arguments_json: '{"selector":"#submit"}' }],
    }));
    const events: ProviderEvent[] = [];

    for await (const event of provider.executeStream(makeOptions({ stream: true }))) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'click_element',
      input: '{"selector":"#submit"}',
      index: 0,
    });
    expect(events[1]).toMatchObject({ type: 'usage' });
    expect(events[2]).toEqual({ type: 'done', finishReason: 'tool_use' });
  });

  it('buffered structured output 대기 중 SSE heartbeat를 방출한다', async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeToolBridgeProvider(claudeOutput({
        response_type: 'message',
        content: 'Finished',
        tool_calls: [],
      }), 20_000);
      const iterator = provider.executeStream(makeOptions())[Symbol.asyncIterator]();

      const heartbeatPromise = iterator.next();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await heartbeatPromise).toEqual({
        done: false,
        value: { type: 'text_delta', text: '' },
      });

      const contentPromise = iterator.next();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await contentPromise).toEqual({
        done: false,
        value: { type: 'text_delta', text: 'Finished' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
