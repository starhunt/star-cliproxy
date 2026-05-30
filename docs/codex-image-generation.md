# Image Generation with Codex (gpt-image-2 / "Image2")

> Generate images through the Codex CLI's builtin `image_gen` tool — **no `OPENAI_API_KEY` required**. Authentication reuses your existing `codex login` (ChatGPT account).

This guide answers the recurring question *"how do I use gpt-image-2 in cliproxy?"* ([#5](https://github.com/starhunt/star-cliproxy/issues/5)).

**The key thing to understand:** `/v1/images/generations` (`packages/server/src/routes/v1/images-generations.ts`) is **just a router**. It forwards the request's `model` to whatever provider that model is mapped to. For Codex-backed image generation, that provider is a **plugin** that wraps [`duct-cli`](https://github.com/starhunt/duct-cli). You don't call OpenAI's API directly.

> [!IMPORTANT]
> The author's personal plugins under `plugins/*/` are **gitignored** (only `plugins/example-plugin/` and `plugins/README.md` ship in the repo). So a fresh fork does **not** include the duct plugin or the matching `config.yaml` entries — you create them yourself using the copy-paste sources below. An LLM (Claude/Codex) can do all of this for you if you paste this doc in.

---

## How the pieces fit

```
POST /v1/images/generations  { "model": "gpt-image-2", "messages": [...] }
        │
        ▼  model mapping (config.yaml):  gpt-image-2  ->  provider "duct"
        ▼
  plugins/cliproxy-plugin-duct/index.js
        │  spawns:  duct-cli openai:images --in req.json --out res.json
        ▼
  duct-cli  ->  codex exec  ->  codex builtin image_gen (gpt-image 2.0)
        │  saves PNG to ~/.codex/generated_images/<thread>/ig_*.png
        ▼
  plugin returns OpenAI Images JSON  { "data": [{ "url": "file://…/ig_*.png" }] }
```

---

## Prerequisites

1. **Codex CLI installed + logged in** — this is what authorizes `image_gen`:
   ```bash
   codex login        # ChatGPT account
   codex --version
   ```
2. **Bun ≥ 1.2** — only needed once, to build `duct-cli`: <https://bun.sh>

---

## Setup (macOS / Linux)

### 1. Build the `duct-cli` binary

From [starhunt/duct-cli](https://github.com/starhunt/duct-cli):

```bash
git clone https://github.com/starhunt/duct-cli
cd duct-cli
bun install
mkdir -p ~/.duct-cli
bun build ./src/cli.ts --compile --outfile ~/.duct-cli/duct-cli

# sanity check — should print OpenAI-style JSON with a local file path
~/.duct-cli/duct-cli image "a minimalist polar bear logo" -v
```

### 2. Create the plugin

Create `plugins/cliproxy-plugin-duct/index.js` in your cliproxy checkout with the source below. (This directory is gitignored, so it stays local to your fork — exactly what we want for a personal provider.)

```javascript
// plugins/cliproxy-plugin-duct/index.js
// Duct (Codex Image Gen 2.0) image-generation plugin.
// Wraps duct-cli `openai:images`, returns an OpenAI Images API-compatible response.
// Auth uses the codex CLI login (ChatGPT account) — no OPENAI_API_KEY.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** @type {import('@star-cliproxy/shared').CliproxyPlugin} */
export default {
  name: 'duct',
  endpointTypes: ['images'],

  createProvider(config) {
    const cliPath = config.cli_path
      || process.env.DUCT_CLI_BIN
      || path.join(os.homedir(), '.duct-cli', 'duct-cli');
    // codex's ChatGPT account does not accept image-only model names like
    // 'gpt-image-*'; leave empty so codex's default model calls image_gen.
    const defaultModel = config.default_model || '';
    const timeoutMs = config.timeout_ms || 300000;

    return {
      name: 'duct',
      endpointTypes: ['images'],

      async execute(options) {
        const lastUserMsg = [...options.messages].reverse().find((m) => m.role === 'user');
        const prompt = lastUserMsg?.content ?? '';

        if (!prompt) {
          throw new Error('No prompt provided in messages.');
        }

        // openai:images mode — JSON file in / out.
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duct-plugin-'));
        const inFile = path.join(tmpDir, 'req.json');
        const outFile = path.join(tmpDir, 'res.json');

        // Drop image-only aliases (gpt-image-*, dall-e-*) so codex's default
        // multimodal model invokes the builtin image_gen tool.
        const requestedModel = options.model || defaultModel || '';
        const codexModel = isCodexCompatibleModel(requestedModel) ? requestedModel : '';

        const reqPayload = {
          ...(codexModel ? { model: codexModel } : {}),
          prompt,
          response_format: 'url',
        };

        await fs.writeFile(inFile, JSON.stringify(reqPayload, null, 2), 'utf-8');

        const args = [
          'openai:images',
          '--in', inFile,
          '--out', outFile,
          '--timeout-ms', String(timeoutMs),
        ];
        if (codexModel) {
          args.push('--model', codexModel);
        }

        try {
          await runCli(cliPath, args, timeoutMs, options.signal);

          const response = JSON.parse(await fs.readFile(outFile, 'utf-8'));

          if (response.error) {
            throw new Error(response.error.message || 'Image generation failed');
          }

          const imageData = response.data || [];
          const openaiResponse = {
            created: response.created || Math.floor(Date.now() / 1000),
            data: imageData.map((item) => {
              // POSIX absolute path -> file:// URL for dashboard preview.
              if (item.url && item.url.startsWith('/')) {
                return { url: `file://${item.url}` };
              }
              return item;
            }),
          };

          return {
            content: JSON.stringify(openaiResponse),
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            finishReason: 'stop',
            _imageResponse: openaiResponse,
          };
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      },

      async checkHealth() {
        try {
          await runCli(cliPath, ['--help'], 10000);
          return 'healthy';
        } catch {
          return 'unhealthy';
        }
      },
    };
  },
};

// image-only API models are rejected by codex's agent path.
function isCodexCompatibleModel(model) {
  if (!model) return false;
  const blocked = /^(gpt-image|dall-e|imagen|stable-|sd-|flux|midjourney)/i;
  return !blocked.test(model);
}

function runCli(cmd, args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: os.tmpdir(),
    });

    child.stdin?.end();

    const stdoutChunks = [];
    const stderrChunks = [];

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 3000);
      reject(new Error(`duct-cli timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        child.kill('SIGTERM');
        reject(new Error('Request cancelled'));
      }, { once: true });
    }

    child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn duct-cli: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      if (code !== 0) {
        reject(new Error(`duct-cli exited with code ${code}: ${stderr || stdout}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
```

### 3. Register the plugin + model mapping in `config.yaml`

`config.yaml` is gitignored too; start from `config.example.yaml` if you don't have one. Add:

```yaml
plugins:
  - path: "./plugins/cliproxy-plugin-duct"
    config:
      cli_path: "/Users/<you>/.duct-cli/duct-cli"   # <-- your absolute path
      default_model: ""        # leave empty — see note below
      max_concurrent: 1
      timeout_ms: 300000

model_mappings:
  - alias: "gpt-image-2"
    provider: "duct"
    actual_model: "gpt-image-2"
```

You can also add the mapping from the dashboard **Models** page instead of editing YAML.

### 4. Restart and test

```bash
curl http://localhost:8300/v1/images/generations \
  -H "Authorization: Bearer sk-proxy-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "messages": [{ "role": "user", "content": "a stylised polar bear logo" }]
  }'
```

You'll get an OpenAI Images-style response with a `file://…/ig_*.png` URL. The dashboard (Debug / Test Model) renders these as clickable previews.

### Why `default_model: ""` and the alias gets stripped

Codex's ChatGPT-account path **rejects image-only model names** (`gpt-image-2`, `dall-e-*`, `imagen-*`) — those belong to the standalone image API, not the agent. The plugin detects this (`isCodexCompatibleModel`) and **drops the model arg**, letting Codex's default multimodal model invoke its builtin `image_gen` tool. So:

- Keep `default_model: ""`.
- You still **call** the endpoint with `"model": "gpt-image-2"` — that's just your alias; the plugin handles the rest.

---

## Windows

`duct-cli` was built and validated on macOS/Unix, so Windows needs two extra considerations.

### 1. Build a Windows binary

Bun can cross-compile, or you can build natively on Windows:

```powershell
# in the duct-cli repo, on Windows
bun install
bun build .\src\cli.ts --compile --target=bun-windows-x64 --outfile duct-cli.exe
```

(The same `--target=bun-windows-x64` also works when cross-compiling from macOS/Linux.)

Point `cli_path` at the `.exe` — use forward slashes in YAML to avoid escaping:

```yaml
cli_path: "C:/Users/<you>/.duct-cli/duct-cli.exe"
```

Codex's home on Windows is `%USERPROFILE%\.codex` — make sure `codex login` succeeded there.

### 2. Heads-up: the `file://` conversion is POSIX-only

The plugin turns local paths into preview URLs with:

```js
if (item.url && item.url.startsWith('/')) return { url: `file://${item.url}` };
```

Windows paths (`C:\Users\…`) don't start with `/`, so the raw path is returned and the dashboard preview won't render. Two ways to handle it:

- **Recommended — run cliproxy + codex + duct-cli under WSL2.** Everything stays POSIX and behaves exactly like the macOS/Linux path above. Fewest surprises.
- **Native Windows — patch the plugin** to normalize drive-letter paths. Replace the `.map(...)` body in `index.js` with:
  ```js
  data: imageData.map((item) => {
    const p = item.url;
    if (p && /^[A-Za-z]:\\/.test(p)) {
      return { url: `file:///${p.replace(/\\/g, '/')}` }; // file:///C:/Users/...
    }
    if (p && p.startsWith('/')) {
      return { url: `file://${p}` };
    }
    return item;
  }),
  ```

If you'd rather get base64 back instead of file paths (handy for remote clients on any OS), `duct-cli openai:images` supports `"response_format": "b64_json"`. The plugin currently hardcodes `url`, so change `response_format` in `reqPayload` to pass it through.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Failed to spawn duct-cli` | `cli_path` wrong, or binary not executable (`chmod +x ~/.duct-cli/duct-cli`). |
| Provider health = `unhealthy` | `duct-cli --help` fails — rebuild the binary. |
| `image generation failed` / auth error | `codex login` not done, or session expired — re-run `codex login`. |
| Request times out | First generation can be slow; raise `timeout_ms` (default `300000` = 5 min). |
| Blank preview on Windows | The `file://` path issue above — use WSL or patch the plugin. |

Once it works, map as many aliases as you like (`gpt-image-2`, `duct-image`, …) all to `provider: duct`.

---

## 한국어 요약

cliproxy에서 이미지 생성은 **OpenAI API 직접 호출이 아닙니다.** `/v1/images/generations`는 라우터일 뿐이고, 요청의 `model`을 매핑된 프로바이더로 넘깁니다. Codex 기반 이미지 생성은 [`duct-cli`](https://github.com/starhunt/duct-cli)를 감싸는 **플러그인**이 처리하며, 인증은 `codex login`(ChatGPT 계정)을 그대로 씁니다 — **`OPENAI_API_KEY` 불필요**.

포크 사용자 주의: 개인 플러그인(`plugins/*/`)과 `config.yaml`은 **gitignore**라 포크에 포함되지 않습니다. 위 소스를 복사해 직접 만들면 됩니다(LLM에게 이 문서를 붙여주면 대신 해줍니다).

1. **codex 로그인** → `codex login`
2. **duct-cli 빌드** (Bun): `bun build ./src/cli.ts --compile --outfile ~/.duct-cli/duct-cli`
3. **플러그인 생성**: 위 소스로 `plugins/cliproxy-plugin-duct/index.js` 작성
4. **config.yaml 등록**: `plugins`에 `cli_path` 지정 + `model_mappings`에 `gpt-image-2 → duct` 추가 (`default_model: ""` 유지 — codex가 image-only 모델명을 거부하므로 플러그인이 자동으로 떨굼)
5. **재시작 + 테스트**: `/v1/images/generations`에 `"model": "gpt-image-2"`로 호출

**Windows**: ① duct-cli를 `--target=bun-windows-x64`로 빌드해 `cli_path`를 `.exe`로 지정. ② 플러그인의 `file://` 변환이 POSIX 경로(`/` 시작) 가정이라 Windows 네이티브에선 미리보기가 깨짐 → **WSL2 권장**, 또는 위 "Native Windows" 패치 적용.
