# HTTP Provider 구현 계획

## 목표

MLX, llama.cpp, vLLM 등 OpenAI 호환 HTTP API를 네이티브 HTTP Provider로 지원하여, CLI 래퍼 없이 직접 HTTP 요청으로 프록싱하고 디버그 뷰에서 요청/응답을 확인할 수 있게 한다.

## 배경

현재 모든 프로바이더가 CLI 프로세스 스폰 기반(`BaseProvider.execute()` → `spawn()`). 로컬 OpenAI 호환 서버(MLX serve, llama.cpp server, vLLM, Ollama API 등)를 사용하려면 curl 래퍼 스크립트가 필요한데, 이는 스트리밍이 어색하고 관리 부담이 있다. OpenAI 호환 API가 로컬 LLM 서비스의 사실상 표준이므로 네이티브 지원이 합리적.

## 접근 방식

| 방법 | 장점 | 단점 | 공수 |
|------|------|------|------|
| A: BaseProvider 확장 | 기존 인프라(registry, queue, health) 재사용 | buildArgs() 등 CLI 메서드 사문화 | 중 |
| B: 독립 클래스 + 동일 인터페이스 | 깔끔한 분리, CLI 잔재 없음 | registry/queue 통합 코드 필요 | 중 |

**선택: A** — BaseProvider를 확장하되 `execute()`, `executeStream()`, `checkHealth()`를 완전히 오버라이드. `buildArgs()`는 빈 배열 반환. registry/queue/debug 인프라를 그대로 재사용하여 공수를 줄인다. CLI 메서드 사문화는 실질적 문제 없음(호출되지 않음).

## 설계 결정

### HTTP Provider Config

```typescript
export interface HttpProviderConfig extends PluginProviderConfig {
  // HTTP 연결
  base_url: string;           // e.g. "http://localhost:8080"
  api_key?: string;           // Authorization: Bearer {api_key}
  custom_headers?: Record<string, string>;  // 추가 헤더

  // 메타
  display_name: string;
  description?: string;
}
```

- `PluginProviderConfig`에서 `enabled`, `default_model`, `max_concurrent`, `timeout_ms` 상속
- `cli_path`, `args_template` 등 CLI 전용 필드 불필요
- OpenAI 호환이므로 요청/응답 형식 고정 — 별도 파싱 설정 불필요

### 스트리밍

OpenAI SSE 형식(`data: {...}\n\n`, `data: [DONE]`)을 파싱하여 `StreamChunk`로 변환. CLIProxy 응답도 동일 형식이므로 변환이 최소화됨.

### 디버그 캡처

| 항목 | CLI Provider | HTTP Provider |
|------|-------------|---------------|
| 요청 | `cliArgs[]` | HTTP method, URL, headers, body |
| 응답 (non-stream) | `stdout` | HTTP status, response body |
| 응답 (stream) | `streamLines[]` | SSE lines[] |
| 에러 | `stderr` | HTTP status + error body |

`DebugCaptureInfo` 타입에 HTTP 전용 필드 추가 (기존 필드와 공존).

### DB 저장

Generic CLI와 동일 패턴: `http_provider:{name}` 키로 settings 테이블에 JSON 저장.

## 태스크

### Phase 1: 타입 및 설정 (shared)

- [ ] T1: HttpProviderConfig 타입 정의
  - 파일: `packages/shared/src/types/provider.ts`
  - Done: `HttpProviderConfig` 인터페이스가 export되고, `PluginProviderConfig` 확장
  - 검증: `npm run typecheck -w packages/shared`

- [ ] T2: DebugCaptureInfo에 HTTP 필드 추가
  - 파일: `packages/shared/src/types/provider.ts`
  - Done: `httpRequest?`, `httpResponse?` 옵셔널 필드 추가
  - 검증: `npm run typecheck -w packages/shared`

### Phase 2: 서버 코어 (server)

- [ ] T3: HttpProvider 클래스 구현
  - 파일: `packages/server/src/providers/http-provider.ts` (신규)
  - Done: `execute()` — fetch POST `/v1/chat/completions`, 응답 파싱, 토큰 사용량 추출
  - Done: `executeStream()` — SSE 스트리밍 파싱, `StreamChunk` yield
  - Done: `checkHealth()` — GET `/v1/models` 또는 base_url 접속 확인
  - Done: 디버그 캡처 (onDebug 콜백으로 HTTP 요청/응답 전달)
  - Done: AbortSignal, timeout 지원
  - 검증: 단위 테스트 통과

- [ ] T4: HttpProvider용 StreamParser 등록
  - 파일: `packages/server/src/utils/stream-transformer.ts`
  - Done: OpenAI SSE 파서가 등록됨 (다만 HTTP Provider는 자체 SSE 파싱하므로 별도 파서 불필요할 수 있음 — execute 내부에서 직접 처리)
  - 검증: 스트리밍 테스트 통과

- [ ] T5: HTTP Provider 로더 구현
  - 파일: `packages/server/src/providers/http-provider-loader.ts` (신규)
  - Done: DB에서 `http_provider:*` 키를 로드하여 HttpProvider 인스턴스 생성 + registry 등록
  - 검증: `npm run typecheck -w packages/server`

- [ ] T6: 서버 부트스트랩에 HTTP 프로바이더 로딩 추가
  - 파일: `packages/server/src/index.ts` (또는 부트스트랩 파일)
  - Done: 서버 시작 시 `loadHttpProviders()` 호출
  - 검증: 서버 기동 시 HTTP 프로바이더 로드 로그 출력

### Phase 3: Admin API (server)

- [ ] T7: HTTP Provider Admin CRUD 라우트
  - 파일: `packages/server/src/routes/admin/http-providers.ts` (신규)
  - Done: GET/POST/PUT/DELETE + POST /test 엔드포인트
  - Done: 이름 검증, reserved name 체크, base_url 검증
  - 검증: curl로 CRUD 테스트

- [ ] T8: Admin 라우트 등록
  - 파일: `packages/server/src/routes/admin/index.ts` (또는 라우트 등록 지점)
  - Done: `/admin/http-providers` 경로 등록
  - 검증: `npm run typecheck -w packages/server`

### Phase 4: 대시보드 UI (dashboard)

- [ ] T9: API 클라이언트 함수 추가
  - 파일: `packages/dashboard/src/api/client.ts`
  - Done: `fetchHttpProviders`, `createHttpProvider`, `updateHttpProvider`, `deleteHttpProvider`, `testHttpProvider`
  - 검증: `npm run typecheck -w packages/dashboard`

- [ ] T10: ProvidersPage에 HTTP Provider 섹션 추가
  - 파일: `packages/dashboard/src/pages/ProvidersPage.tsx`
  - Done: HTTP Providers 섹션 (카드 리스트 + 추가 폼)
  - Done: 설정 필드: base_url, api_key, custom_headers, display_name, default_model, max_concurrent, timeout_ms
  - Done: 테스트 버튼, 토글, 삭제
  - 검증: 대시보드에서 HTTP 프로바이더 추가/수정/삭제 가능

- [ ] T11: i18n 번역 추가
  - 파일: `packages/dashboard/src/i18n/translations.ts`
  - Done: EN/KO 번역 키 추가 (providers.httpProvider, providers.baseUrl 등)
  - 검증: 영어/한국어 전환 시 레이블 정상 표시

- [ ] T12: DebugPage에 HTTP 디버그 정보 표시
  - 파일: `packages/dashboard/src/pages/DebugPage.tsx`
  - Done: HTTP 프로바이더 디버그 로그에서 요청 URL/헤더/바디, 응답 상태/바디 표시
  - 검증: HTTP 프로바이더 요청 후 디버그 페이지에서 페이로드 확인 가능

### Phase 5: 통합 검증

- [ ] T13: 통합 테스트
  - Done: HTTP Provider로 로컬 OpenAI 서버 프록싱 동작 확인
  - Done: 스트리밍/비스트리밍 모두 정상
  - Done: 디버그 뷰에 HTTP 페이로드 표시
  - 검증: `npm run build && npm test`

## 의존성 그래프

```
T1 ─┬─→ T3 ─→ T5 ─→ T6
T2 ─┘    │         ↘
         └─→ T4    T7 ─→ T8
                    ↓
         T9 ─→ T10 ─→ T11
                    ↓
                   T12
                    ↓
                   T13
```

병렬 가능: T1 ∥ T2, T4 ∥ T5, T9 ∥ T11
크리티컬 패스: T1 → T3 → T5 → T6 → T7 → T8 → T10 → T13

## 검증 방법

- [ ] 타입체크: `npm run typecheck` (전체)
- [ ] 빌드: `npm run build` (전체)
- [ ] 테스트: `npm test`
- [ ] 수동 테스트: MLX serve 또는 Ollama(`http://localhost:11434`)로 실제 프록싱 확인

## 리스크 및 대응

| 리스크 | 대응 방안 |
|--------|----------|
| BaseProvider의 CLI 전용 로직이 HttpProvider에 간섭 | execute/executeStream 완전 오버라이드로 CLI 코드 경로 우회 |
| SSE 파싱 엣지케이스 (비표준 구현체) | OpenAI 호환 표준만 우선 지원, 비표준은 후속 대응 |
| DebugCaptureInfo 타입 확장 시 기존 코드 영향 | 모든 새 필드를 옵셔널로 추가, 기존 코드 무영향 |
| 대시보드 ProvidersPage 크기 증가 | HTTP 섹션을 별도 컴포넌트로 추출 가능 (필요시) |
