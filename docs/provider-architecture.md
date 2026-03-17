# Provider 아키텍처 및 줄바꿈/출력 처리 가이드

## 개요

star-cliproxy는 CLI 도구(Claude, Codex, Gemini)를 spawn하여 OpenAI 호환 API(`/v1/chat/completions`)를 노출하는 프록시 서버입니다. 각 provider는 CLI의 출력 형식 차이와 줄바꿈 보존 문제를 고유한 방식으로 해결합니다.

## Provider별 처리 방식

### Claude Provider (`claude-provider.ts`)

| 항목 | 설명 |
|------|------|
| CLI | `claude` |
| 출력 모드 | `--output-format json` (단일 JSON 객체) |
| 파싱 | `JSON.parse(stdout)` → `data.result` 추출 |
| 줄바꿈 | JSON 내부에 `\n`이 `\\n`으로 이스케이프 → `JSON.parse`가 자동 복원. **문제 없음** |
| 스트리밍 | non-streaming 결과를 20자 청크로 시뮬레이트 |
| 특이사항 | `--max-tokens` CLI 옵션 미지원 (API 전용) |

**핵심**: Claude CLI의 `json` 포맷은 전체 응답을 하나의 JSON 객체로 출력하므로 줄바꿈이 완벽히 보존됩니다.

### Codex Provider (`codex-provider.ts`)

| 항목 | 설명 |
|------|------|
| CLI | `codex exec` |
| 출력 모드 | NDJSON 또는 plain text (json 모드 미지원) |
| 파싱 | 전체 JSON 파싱 우선 → 실패 시 base NDJSON 파싱 → 줄바꿈 부족하면 stdout 원본 사용 |
| 줄바꿈 | NDJSON 라인 파싱에서 줄바꿈 소실 가능 → fallback으로 stdout 원본 보존 |
| 스트리밍 | non-streaming 결과를 20자 청크로 시뮬레이트 |
| 특이사항 | `--` 마커로 prompt가 CLI 플래그로 해석되는 것 방지 |

**핵심**: Codex CLI는 json 출력 모드가 없으므로, NDJSON 파싱 결과에 줄바꿈이 부족하면 stdout 원본 텍스트를 그대로 content로 사용합니다.

### Gemini Provider (`gemini-provider.ts`)

| 항목 | 설명 |
|------|------|
| CLI | `gemini` |
| 출력 모드 | `-o json` (단일 JSON 객체, pretty-printed) |
| 파싱 | `JSON.parse` → `data.response` 추출. 실패 시 정규식 fallback |
| 줄바꿈 | JSON 내부에 `\\n`으로 이스케이프 → `replace(/\\n/g, '\n')` 수동 복원 |
| 스트리밍 | non-streaming 결과를 20자 청크로 시뮬레이트 |
| 특이사항 | **stdout pipe 잘림 문제** → shell 리다이렉트로 우회 |

**핵심**: Gemini CLI는 `-o json` 모드에서 `{ session_id, response, stats }` 구조의 JSON을 출력합니다. `response` 필드에 LLM 응답이 담기고, `stats`에 토큰 사용량이 포함됩니다.

## Gemini stdout 잘림 문제와 해결

### 문제

Node.js `spawn()`으로 Gemini CLI를 실행하면 stdout이 **중간에 잘리는** 현상이 발생합니다:

```
// spawn 방식: stdout이 ~4KB에서 잘림
spawn('gemini', ['-p', prompt, '-o', 'json'])
→ child.stdout.on('data') → Buffer.concat → 잘린 JSON

// 직접 실행: 정상 출력
gemini -p "..." -o json > output.json
→ 완전한 JSON 파일
```

`spawn`의 stdout pipe를 통한 데이터 수집에서 Gemini CLI와의 조합에서 조기 종료가 발생합니다. pipe 방식(`child.stdout.pipe(writeStream)`)이나 event 방식(`child.stdout.on('data')`)에서도 동일한 문제가 재현되었습니다.

### 해결: Shell 리다이렉트 방식

stdout pipe를 **아예 사용하지 않고**, shell에서 `>` 리다이렉트로 파일에 직접 출력합니다:

```typescript
// gemini-provider.ts의 execute() 오버라이드
const shellCmd = `${cliPath} ${escapedArgs} > '${tmpFile}' 2>/dev/null`;
spawn('sh', ['-c', shellCmd], { stdio: 'ignore' });
// → 프로세스 종료 후 readFile(tmpFile)로 전체 출력 읽기
```

**검증 결과**:
- pipe 방식: 4584 bytes에서 잘림 → JSON 파싱 실패
- shell 리다이렉트: 6113+ bytes 정상 출력 → JSON 파싱 성공

### 임시 파일 관리

```
생성: /tmp/gemini-out-{random16hex}.json
삭제: finally 블록에서 unlink() (성공/실패 무관)
```

## JSON 파싱 Fallback 체인

### Gemini (`parseNonStreamOutput`)

```
1. JSON.parse(전체 stdout)
   → 성공: data.response 추출
   → 실패: ↓

2. 정규식으로 {…} JSON 객체 추출 후 JSON.parse
   → 성공: data.response 추출
   → 실패: ↓

3. 정규식으로 "response": "..." 값 추출
   → response 뒤의 stats 부분 제거
   → 이스케이프 문자 수동 복원 (\\n → \n 등)
   → 실패: ↓

4. base-provider의 NDJSON 라인 파싱 (최종 fallback)
```

### Codex (`parseNonStreamOutput`)

```
1. JSON.parse(전체 stdout)
   → 성공: data.result / data.content / data.message 추출
   → 실패: ↓

2. base-provider NDJSON 라인 파싱
   → 결과에 줄바꿈이 거의 없으면 (< 3줄):
     stdout 원본 텍스트를 content로 사용 (줄바꿈 보존)
   → 그 외: NDJSON 파싱 결과 사용
```

## Gemini CLI JSON 출력 구조

```json
{
  "session_id": "uuid",
  "response": "LLM 응답 텍스트 (\\n으로 줄바꿈 이스케이프)",
  "stats": {
    "models": {
      "gemini-3-flash-preview": {
        "api": { "totalRequests": 1, "totalErrors": 0, "totalLatencyMs": 17240 },
        "tokens": { "input": 11251, "candidates": 2060, "total": 14454 }
      }
    }
  }
}
```

**주의**: `response` 내의 `\n`은 리터럴 `\\n`으로 이스케이프되어 있으므로, JSON 파싱 후 `content.replace(/\\n/g, '\n')`으로 수동 복원이 필요합니다.

## Gemini CLI 설정

`~/.gemini/settings.json`:

```json
{
  "maxOutputTokens": 65535
}
```

- 기본값 8192 → 긴 응답이 잘림 (Gemini CLI의 알려진 이슈)
- 최대값: 65536 미만 (API 제한)
- 설정이 무시되는 경우도 있음 ([GitHub Issue #2104](https://github.com/google-gemini/gemini-cli/issues/2104))

## 공통 스트리밍 처리

세 provider 모두 **시뮬레이트 스트리밍** 방식을 사용합니다:

```
1. execute() → 전체 응답 수신 (non-streaming)
2. content를 20자 청크로 분할
3. 각 청크를 StreamChunk { type: 'delta', content } 로 yield
4. 마지막에 { type: 'done', usage } yield
```

진정한 스트리밍이 아니므로 TTFB(Time To First Byte)는 전체 응답 생성 시간과 동일합니다. 하지만 줄바꿈 보존이 보장됩니다.

## 환경변수 정리

모든 provider는 CLI 실행 시 부모 프로세스(Claude Code)의 환경변수를 제거합니다:

```
CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ACCESS_TOKEN,
CLAUDE_CODE_SSE_PORT, CLAUDE_CODE_ENABLE_TASKS, CLAUDE_CODE_MAX_OUTPUT_TOKENS
```

이는 CLI가 자기 자신을 Claude Code의 자식 프로세스로 인식하여 동작이 변경되는 것을 방지합니다.

## 트러블슈팅 체크리스트

| 증상 | 원인 | 해결 |
|------|------|------|
| 응답에 `"stats": {` JSON 포함 | Gemini JSON 파싱 실패 → fallback에서 response와 stats 미분리 | shell 리다이렉트 방식 확인, 프록시 재빌드/재시작 |
| 응답이 짧게 잘림 (문장 중간 끊김) | Gemini CLI `maxOutputTokens` 기본값 8192 | `~/.gemini/settings.json`에서 65535로 설정 |
| 줄바꿈이 모두 소실 | NDJSON 라인 파싱에서 줄바꿈 소실 | 각 provider의 `parseNonStreamOutput` 오버라이드 확인 |
| `\n`이 리터럴 텍스트로 표시 | Gemini JSON에서 `\\n` 이중 이스케이프 | `content.replace(/\\n/g, '\n')` 처리 확인 |
| 프록시 요청 중 다른 API 블로킹 | `execSync` 사용 (동기 실행) | 비동기 `spawn` + Promise 방식 사용 확인 |
