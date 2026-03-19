[English](#plugin-system) | [한국어](#플러그인-시스템)

---

# Plugin System

Extend star-cliproxy with custom providers — image generators, custom LLM APIs, or any HTTP-based service — without modifying the main codebase.

## Directory Structure

```
plugins/
  my-provider/
    index.js          # CliproxyPlugin interface implementation
    package.json      # (optional) if the plugin has dependencies
```

Each subdirectory under `plugins/` is treated as a potential plugin. Failed plugins are skipped — the server starts normally without them.

## Plugin Interface (CliproxyPlugin)

```typescript
interface CliproxyPlugin {
  // Unique plugin name
  name: string;

  // Endpoint types this plugin handles
  endpointTypes: Array<'chat' | 'images' | 'tts' | 'embeddings'>;

  // Factory: receives config from config.yaml, returns a provider instance
  createProvider(config: Record<string, unknown>): {
    name: string;
    execute(options: ExecuteOptions): Promise<ExecuteResult>;
    checkHealth(): Promise<'healthy' | 'unhealthy' | 'unknown'>;
  };

  // (optional) Custom streaming parser — defaults to PlainTextParser
  // createParser?(): { parse(line: string): string | null };
}

interface ExecuteOptions {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  stream?: boolean;
  // ...other OpenAI-compatible fields
}

interface ExecuteResult {
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: 'stop' | 'length' | 'error';
}
```

## Endpoint Types

| Type | Description | API Path | Status |
|------|-------------|----------|--------|
| `chat` | Text conversation | `/v1/chat/completions` | Supported |
| `images` | Image generation | `/v1/images/generations` | Supported |
| `tts` | Text-to-speech | `/v1/audio/speech` | Planned |
| `embeddings` | Embeddings | `/v1/embeddings` | Planned |

## Minimal Chat Plugin

```javascript
// plugins/my-provider/index.js

export default {
  name: 'my-provider',
  endpointTypes: ['chat'],

  createProvider(config) {
    return {
      name: 'my-provider',

      async execute(options) {
        const lastMessage = options.messages.at(-1)?.content ?? '';

        // Implement: CLI call, HTTP request, or any logic
        const responseText = `Echo: ${lastMessage}`;

        return {
          content: responseText,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
        };
      },

      async checkHealth() {
        return 'healthy';
      },
    };
  },
};
```

## Image Provider Example

For image generation plugins, the `execute` method must return an OpenAI Images API-compatible JSON string as `content`.

```javascript
// plugins/my-image-provider/index.js

export default {
  name: 'my-image-provider',
  endpointTypes: ['images'],

  createProvider(config) {
    const cliPath = config.cli_path ?? 'my-cli';
    const timeoutMs = config.timeout_ms ?? 120000;

    return {
      name: 'my-image-provider',

      async execute(options) {
        // The prompt arrives as the last message content
        const prompt = options.messages.at(-1)?.content ?? '';

        // --- Option A: spawn a CLI tool ---
        // const { stdout } = await runCli(cliPath, ['generate', prompt], timeoutMs);
        // const imageUrl = parseUrl(stdout);

        // --- Option B: call an HTTP API ---
        // const res = await fetch('https://api.example.com/generate', {
        //   method: 'POST',
        //   body: JSON.stringify({ prompt }),
        // });
        // const { url: imageUrl } = await res.json();

        const imageUrl = 'https://example.com/generated-image.png';

        // Must return OpenAI Images API format
        const openaiResponse = {
          created: Math.floor(Date.now() / 1000),
          data: [{ url: imageUrl }],
        };

        return {
          content: JSON.stringify(openaiResponse),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
        };
      },

      async checkHealth() {
        return 'healthy';
      },
    };
  },
};
```

The proxy returns the `content` string directly as the HTTP response body for `/v1/images/generations`, so it must be valid JSON matching the OpenAI Images API format:

```json
{
  "created": 1234567890,
  "data": [{ "url": "https://..." }]
}
```

## config.yaml Configuration

```yaml
plugins:
  - path: "./plugins/my-image-provider"
    config:
      cli_path: "my-cli"
      default_model: "my-model"
      timeout_ms: 120000
  - path: "./plugins/another-provider"
    config:
      api_key_env: "MY_API_KEY"
```

The `config` object is passed as-is to `createProvider(config)`.

## How It Works (Loading Flow)

1. Server starts and reads `plugins` from `config.yaml`
2. Each entry's `path` is resolved relative to the project root
3. The `index.js` (or `index.mjs`) is imported via dynamic `import()`
4. `createProvider(config)` is called with the entry's `config` object
5. The resulting provider is registered in the provider engine
6. Model mappings in the dashboard can target plugin providers by name
7. Requests routed to the plugin go through the standard auth → rate-limit → cache pipeline

## Authentication Patterns

### Environment Variable

```javascript
createProvider(config) {
  const apiKey = process.env[config.api_key_env ?? 'MY_API_KEY'];
  if (!apiKey) throw new Error('API key env var not set');

  return {
    name: 'my-provider',
    async execute(options) {
      // use apiKey
    },
    async checkHealth() { return 'healthy'; },
  };
},
```

### Cached Token (CLI Login)

```javascript
createProvider(config) {
  let cachedToken = null;

  async function getToken() {
    if (cachedToken) return cachedToken;
    // e.g. read from ~/.config/my-cli/token
    cachedToken = await readTokenFromFile();
    return cachedToken;
  }

  return {
    name: 'my-provider',
    async execute(options) {
      const token = await getToken();
      // use token
    },
    async checkHealth() {
      try { await getToken(); return 'healthy'; }
      catch { return 'unhealthy'; }
    },
  };
},
```

## Testing Plugins

```bash
# 1. Register the plugin in config.yaml (see above)
# 2. Add a model mapping in the dashboard pointing to your plugin
# 3. Use Test Model on the mapping to validate before saving
# 4. Call the endpoint directly:

curl http://localhost:8300/v1/images/generations \
  -H "Authorization: Bearer sk-proxy-your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-image-model",
    "messages": [{"role": "user", "content": "A sunset over the ocean"}]
  }'
```

Image URLs returned in debug logs and test results are shown as clickable previews in the dashboard.

## Notes

- `plugins/*/` is gitignored by default — add personal plugins freely
- Plugins must provide built `.js` files; TypeScript must be compiled before use
- Plugin load failure is isolated — only that plugin is skipped, the server starts normally
- Plugins go through the same auth, rate-limit, and cache pipeline as built-in providers
- The `example-plugin/` directory contains a working reference implementation

---

# 플러그인 시스템

메인 코드 수정 없이 커스텀 프로바이더를 star-cliproxy에 추가할 수 있습니다. 이미지 생성기, 커스텀 LLM API, HTTP 기반 서비스 등을 플러그인으로 연동하세요.

## 디렉토리 구조

```
plugins/
  my-provider/
    index.js          # CliproxyPlugin 인터페이스 구현
    package.json      # (선택) 의존성이 있는 경우
```

`plugins/` 하위의 각 디렉토리가 플러그인 후보로 처리됩니다. 로드에 실패한 플러그인은 건너뛰고, 서버는 정상 시작합니다.

## 플러그인 인터페이스 (CliproxyPlugin)

```typescript
interface CliproxyPlugin {
  // 고유한 플러그인 이름
  name: string;

  // 이 플러그인이 처리하는 엔드포인트 타입
  endpointTypes: Array<'chat' | 'images' | 'tts' | 'embeddings'>;

  // 팩토리: config.yaml의 config를 받아 프로바이더 인스턴스 반환
  createProvider(config: Record<string, unknown>): {
    name: string;
    execute(options: ExecuteOptions): Promise<ExecuteResult>;
    checkHealth(): Promise<'healthy' | 'unhealthy' | 'unknown'>;
  };

  // (선택) 커스텀 스트리밍 파서 — 없으면 PlainTextParser 사용
  // createParser?(): { parse(line: string): string | null };
}
```

## 엔드포인트 타입

| 타입 | 설명 | API 경로 | 상태 |
|------|------|----------|------|
| `chat` | 텍스트 대화 | `/v1/chat/completions` | 지원 |
| `images` | 이미지 생성 | `/v1/images/generations` | 지원 |
| `tts` | 음성 합성 | `/v1/audio/speech` | 예정 |
| `embeddings` | 임베딩 | `/v1/embeddings` | 예정 |

## 최소 Chat 플러그인 예시

```javascript
// plugins/my-provider/index.js

export default {
  name: 'my-provider',
  endpointTypes: ['chat'],

  createProvider(config) {
    return {
      name: 'my-provider',

      async execute(options) {
        const lastMessage = options.messages.at(-1)?.content ?? '';

        // CLI 호출, HTTP 요청 등 자유롭게 구현
        const responseText = `Echo: ${lastMessage}`;

        return {
          content: responseText,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
        };
      },

      async checkHealth() {
        return 'healthy';
      },
    };
  },
};
```

## 이미지 프로바이더 예시

이미지 생성 플러그인의 `execute` 메서드는 OpenAI Images API 호환 JSON 문자열을 `content`로 반환해야 합니다.

```javascript
// plugins/my-image-provider/index.js

export default {
  name: 'my-image-provider',
  endpointTypes: ['images'],

  createProvider(config) {
    const cliPath = config.cli_path ?? 'my-cli';
    const timeoutMs = config.timeout_ms ?? 120000;

    return {
      name: 'my-image-provider',

      async execute(options) {
        // 프롬프트는 마지막 메시지의 content로 전달됩니다
        const prompt = options.messages.at(-1)?.content ?? '';

        // --- 방법 A: CLI 도구 실행 ---
        // const { stdout } = await runCli(cliPath, ['generate', prompt], timeoutMs);
        // const imageUrl = parseUrl(stdout);

        // --- 방법 B: HTTP API 호출 ---
        // const res = await fetch('https://api.example.com/generate', {
        //   method: 'POST',
        //   body: JSON.stringify({ prompt }),
        // });
        // const { url: imageUrl } = await res.json();

        const imageUrl = 'https://example.com/generated-image.png';

        // OpenAI Images API 형식으로 반환 필수
        const openaiResponse = {
          created: Math.floor(Date.now() / 1000),
          data: [{ url: imageUrl }],
        };

        return {
          content: JSON.stringify(openaiResponse),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
        };
      },

      async checkHealth() {
        return 'healthy';
      },
    };
  },
};
```

프록시는 `/v1/images/generations` 응답으로 `content` 문자열을 그대로 반환하므로, 반드시 OpenAI Images API 형식의 유효한 JSON이어야 합니다:

```json
{
  "created": 1234567890,
  "data": [{ "url": "https://..." }]
}
```

## config.yaml 설정

```yaml
plugins:
  - path: "./plugins/my-image-provider"
    config:
      cli_path: "my-cli"
      default_model: "my-model"
      timeout_ms: 120000
  - path: "./plugins/another-provider"
    config:
      api_key_env: "MY_API_KEY"
```

`config` 객체는 `createProvider(config)`에 그대로 전달됩니다.

## 동작 방식 (로딩 흐름)

1. 서버 시작 시 `config.yaml`의 `plugins` 섹션을 읽음
2. 각 항목의 `path`를 프로젝트 루트 기준으로 resolve
3. `index.js` (또는 `index.mjs`)를 동적 `import()`로 로드
4. 항목의 `config` 객체를 인자로 `createProvider(config)` 호출
5. 반환된 프로바이더를 프로바이더 엔진에 등록
6. 대시보드 모델 매핑에서 플러그인 프로바이더를 이름으로 지정 가능
7. 플러그인으로 라우팅된 요청은 기본 제공 프로바이더와 동일하게 auth → rate-limit → cache 파이프라인 통과

## 인증 패턴

### 환경 변수 방식

```javascript
createProvider(config) {
  const apiKey = process.env[config.api_key_env ?? 'MY_API_KEY'];
  if (!apiKey) throw new Error('API 키 환경 변수가 설정되지 않았습니다');

  return {
    name: 'my-provider',
    async execute(options) {
      // apiKey 사용
    },
    async checkHealth() { return 'healthy'; },
  };
},
```

### 캐시된 토큰 방식 (CLI 로그인)

```javascript
createProvider(config) {
  let cachedToken = null;

  async function getToken() {
    if (cachedToken) return cachedToken;
    // 예: ~/.config/my-cli/token 파일에서 읽기
    cachedToken = await readTokenFromFile();
    return cachedToken;
  }

  return {
    name: 'my-provider',
    async execute(options) {
      const token = await getToken();
      // token 사용
    },
    async checkHealth() {
      try { await getToken(); return 'healthy'; }
      catch { return 'unhealthy'; }
    },
  };
},
```

## 플러그인 테스트

```bash
# 1. config.yaml에 플러그인 등록 (위 설정 참고)
# 2. 대시보드에서 플러그인 프로바이더를 지정하는 모델 매핑 추가
# 3. 매핑 저장 전 Test Model로 검증
# 4. 엔드포인트 직접 호출:

curl http://localhost:8300/v1/images/generations \
  -H "Authorization: Bearer sk-proxy-your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-image-model",
    "messages": [{"role": "user", "content": "바다 위의 노을"}]
  }'
```

디버그 로그와 테스트 결과에서 반환된 이미지 URL은 대시보드에서 클릭 가능한 미리보기로 표시됩니다.

## 참고 사항

- `plugins/*/`는 기본적으로 gitignore 처리 — 개인용 플러그인을 자유롭게 추가 가능
- 플러그인은 빌드된 `.js` 파일을 제공해야 함 (TypeScript는 미리 컴파일)
- 플러그인 로드 실패는 해당 플러그인만 건너뛰며 서버는 정상 시작
- 플러그인은 기본 제공 프로바이더와 동일한 auth, rate-limit, cache 파이프라인 적용
- `example-plugin/` 디렉토리에 동작하는 참조 구현체가 있음
