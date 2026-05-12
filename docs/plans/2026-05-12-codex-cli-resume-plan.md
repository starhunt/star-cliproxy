# Codex CLI `exec resume` 세션 유지 + 모델 레벨 옵션 오버라이드 통합 계획

## 목표

1. **세션 유지**: `codex` 프로바이더의 CLI 모드에서 `codex exec --json`이 노출하는 `thread_id`를 캡처하고, 이어지는 호출을 `codex exec resume <thread_id> -`로 자동 전환하여 컨텍스트를 유지.
2. **모델 레벨 옵션 오버라이드**: 동일 프로바이더(`codex`)를 공유하는 여러 모델 매핑이 각자 다른 옵션(`ephemeral`, `enable_session_reuse`, `extra_args` 등)을 사용할 수 있도록 화이트리스트 기반 오버라이드 메커니즘 도입.

## 배경

### A. 세션 유지

- 현재 cliproxy의 codex CLI 모드는 `cli_options.ephemeral: true` 기본값으로 세션 jsonl 누적을 차단 → 세션 재사용 불가
- App Server 모드(`mode: app-server`)는 thread 재사용을 지원하나 codex CLI가 `[experimental]` 표기
- 사용자 확인 안정 방식: `codex exec --json` 첫 줄 `{"type":"thread.started","thread_id":"<UUID>"}` → 다음 호출 `codex exec resume <UUID>` (정식 서브커맨드, 실측 검증 완료)

### B. 모델 레벨 오버라이드

- 동일 프로바이더 + 동일 모델이라도 채팅용 / 일회성 / 긴 분석용 등 워크플로별로 옵션이 달라야 함
- 현재 `model_mappings.reasoning_effort`만 모델 레벨 오버라이드 지원 — 같은 패턴을 확장
- 예: `gpt-5.5-chat`은 세션 유지 + danger-full-access, `gpt-quick`은 ephemeral 1회용

## 사용자 결정 사항

| 항목 | 결정 |
|------|------|
| jsonl 디스크 정책 | 보존 (codex 기본 동작) |
| `enable_session_reuse: true` + `ephemeral: true` 충돌 | 자동 ephemeral=false 강제 + stderr 경고 1회 |
| clientKey 식별 | 헤더 우선 (`X-Cliproxy-Session-Id`) + apiKeyId fallback + 응답 헤더 `X-Cliproxy-Thread-Id` 노출 |
| 테스트 범위 | 단위 + 실제 codex 통합 1건 |
| 모델 레벨 오버라이드 진행 방식 | **본 계획에 완전 통합** (DB/타입/Provider merge/UI 모두 포함) |

## 접근 방식

| 방법 | 장점 | 단점 | 공수 |
|------|------|------|------|
| **(선택) B: CLI resume + model overrides 통합** | codex 정식 명령 사용, 요청별 격리 유지, 동일 프로바이더에서 모델별 다른 워크플로 운영 가능, 기존 reasoning_effort 패턴 자연스러운 확장 | 변경 범위 큼 (DB/Router/Provider/UI), 화이트리스트 검증 필수 | 큼 |
| A: app-server 모드 권장만 | 추가 구현 없음 | experimental, 모델 레벨 차별화 불가 | 0 |
| C: 단순 yaml 컬럼만 화이트리스트 추가 (`ephemeral` 컬럼 식) | 단순 | 옵션 추가마다 마이그레이션, 확장성 낮음 | 중 |

**선택: B** — 사용자 확정. 모델별 차별화 운영을 위한 표준 패턴 도입.

## 화이트리스트 (오버라이드 허용 키)

**codex 프로바이더 한정** (1차 범위, claude/gemini는 향후 별도 PR):

| 키 | 타입 | 허용 사유 |
|----|------|----------|
| `cli_options.ephemeral` | boolean | 세션 jsonl 보존/비보존을 모델별 결정 |
| `cli_options.enable_session_reuse` | boolean | 일부 모델만 세션 유지 |
| `cli_options.session_ttl_ms` | number | 모델 작업 성격에 따라 TTL 차별 |
| `extra_args` | string[] | 모델별 sandbox 정책, profile 등 |
| `timeout_ms` | number | 추론량 다른 모델별 타임아웃 |
| `working_dir` | string | 모델별 작업 디렉토리 |

**금지 키 (오버라이드 불가)**: `cli_path`, `enabled`, `mode`, `default_model`, `max_concurrent`, `sdk_options.*`, `app_server_options.*` — 안정성/보안/구조적 이유.

## 태스크

### Phase 1: 타입 및 스키마

- [ ] **T1**: 공유 타입 확장
  - 파일: `packages/shared/src/types/config.ts`, `packages/shared/src/types/provider.ts`
  - 변경:
    - `CodexCliOptions`에 `enable_session_reuse?: boolean`, `session_ttl_ms?: number` 추가
    - `ModelMappingSeed`에 `provider_overrides?: Partial<ProviderConfigYaml>` 추가
    - `ExecuteOptions`에 `providerOverrides?: Partial<ProviderConfigYaml>` 추가
    - 신규 export: `CODEX_OVERRIDE_ALLOWED_KEYS` 상수 (화이트리스트)
  - Done: 타입 컴파일 통과 + 한국어 JSDoc
  - 검증: `cd packages/shared && bun run build`

- [ ] **T2**: DB 스키마 + 마이그레이션
  - 파일: `packages/server/src/db/schema.ts`, `packages/server/src/db/client.ts`
  - 변경:
    - schema.ts `modelMappings`에 `providerOverrides: text('provider_overrides')` 컬럼 추가
    - client.ts `createTables()`에 idempotent ALTER TABLE 추가:
      ```sql
      ALTER TABLE model_mappings ADD COLUMN provider_overrides TEXT
      ```
    - try/catch로 이미 존재 시 무시 (기존 `reasoning_effort` 마이그레이션 패턴 동일)
  - Done: 기존 DB도 자동 마이그레이션, 신규 DB는 컬럼 포함
  - 검증: 기존 sqlite 파일로 서버 기동 → 컬럼 추가 확인, 신규 DB로도 부팅 OK

- [ ] **T3**: config loader / example yaml / README
  - 파일: `packages/server/src/config/loader.ts`, `config.example.yaml`, `README.md`, `README.ko.md`
  - 변경:
    - loader: codex `cli_options` 정규화에 `enable_session_reuse`, `session_ttl_ms` 추가
    - loader: `modelMappings`에 `provider_overrides` 필드 파싱 (yaml에서 직접 정의도 가능하도록)
    - example yaml: codex/model_mappings 양쪽에 신규 옵션 예시 + 주석
  - Done: 기본값 (`enable_session_reuse: false`)로 하위 호환 보장
  - 검증: `bun run build` + example yaml 로드 테스트

### Phase 2: Provider Override 합병 로직

- [ ] **T4**: `mergeProviderConfig` helper + 화이트리스트 검증
  - 파일 (신규): `packages/server/src/providers/provider-override.ts`
  - 파일 (신규): `packages/server/src/providers/provider-override.test.ts`
  - 변경:
    - 함수 `mergeProviderConfig(base: ProviderConfigYaml, overrides?: Partial<ProviderConfigYaml>, provider: string): ProviderConfigYaml`
    - 화이트리스트 외 키는 warn 로그 + 무시
    - deep merge (특히 `cli_options`, `sdk_options`, `app_server_options` 객체)
    - `extra_args`는 배열 — 기본 동작은 **교체**, 옵션 `{ append: true }` 지원 가능 (T4 기본 교체로 시작, append는 후속)
  - Done: 단위 테스트 6+개 — 화이트리스트 통과/거부, deep merge, 배열 교체, null/undefined 처리
  - 검증: `bun test packages/server/src/providers/provider-override.test.ts`

- [ ] **T5**: Router → ResolvedRoute에 providerOverrides 주입
  - 파일: `packages/server/src/services/router.ts`
  - 변경:
    - `ResolvedRoute`에 `providerOverrides?: Partial<ProviderConfigYaml>` 추가
    - DB row의 `providerOverrides` (JSON string) → JSON.parse → ResolvedRoute에 실음
    - 파싱 실패 시 warn 로그 + null fallback (라우팅은 계속 진행)
  - Done: 매핑에 overrides 있는 모델 호출 시 ResolvedRoute에 포함
  - 검증: router 단위 테스트 (있다면 확장, 없으면 신규 1건)

- [ ] **T6**: HTTP 라우트에서 ExecuteOptions에 providerOverrides 전달
  - 파일: `packages/server/src/routes/v1/messages.ts`, `packages/server/src/routes/v1/chat-completions.ts`, `packages/server/src/routes/v1/embeddings.ts`
  - 변경:
    - 4지점에서 `route.providerOverrides`를 `ExecuteOptions.providerOverrides`에 그대로 전달
    - embeddings 라우트도 동일 패턴 적용 (일관성)
  - Done: provider.execute 호출 시 overrides가 options에 포함
  - 검증: 통합 테스트 (T16)

### Phase 3: 세션 매니저 및 thread_id 캡처

- [ ] **T7**: `CodexCliSessionManager` 신규 + 단위 테스트
  - 파일 (신규): `packages/server/src/providers/codex-cli-session-manager.ts`
  - 파일 (신규): `packages/server/src/providers/codex-cli-session-manager.test.ts`
  - 변경: `CodexAppServerSessionManager` 복제 → `CliSession` 타입으로 명칭 변경
  - Done: 단위 테스트 4+개 (set/get/TTL/모델변경 무효화/invalidate)
  - 검증: `bun test packages/server/src/providers/codex-cli-session-manager.test.ts`

- [ ] **T8**: CodexProvider에 SessionManager + effective config 통합
  - 파일: `packages/server/src/providers/codex-provider.ts`
  - 변경:
    - lazy 초기화: `cliSessionManager: CodexCliSessionManager | null` (effective config의 `enable_session_reuse` 기준)
    - 신규 메서드 `private getEffectiveConfig(options: ExecuteOptions): ProviderConfigYaml`
      - `mergeProviderConfig(this.config, options.providerOverrides, 'codex')` 호출
    - 신규 메서드 `private extractThreadIdFromStdout(stdout: string): string | null` — 첫 라인 JSON.parse → `type === 'thread.started'` → `thread_id` 반환 (3가지 키 경로 모두 처리: `thread_id` / `threadId` / `thread.id`)
    - 충돌 처리: effective config에서 `enable_session_reuse: true` && `ephemeral: true` 시 `ephemeral=false` 자동 강제 + `console.warn('[codex] cli_options.ephemeral disabled because enable_session_reuse is true (mapping: ${alias})')` 1회 (per-alias)
  - Done: getEffectiveConfig가 base + overrides 정상 합병
  - 검증: 단위 테스트 — effective config 케이스 4종 (overrides 없음 / cli_options만 / extra_args / 화이트리스트 외 키)

- [ ] **T9**: CodexProvider `buildArgs`에서 resume 분기 + effective config 사용
  - 파일: `packages/server/src/providers/codex-provider.ts`
  - 변경:
    - `buildArgs(options)`가 `getEffectiveConfig(options)` 호출
    - effective `enable_session_reuse: true` && SessionManager.get(clientKey, model) 결과 있으면:
      - args: `['exec', 'resume', threadId, '--json', ...rest, '-']`
    - 없으면 기존: `['exec', '--json', ...rest, '-']`
    - effective `ephemeral` 기준으로 `--ephemeral` 주입 여부 결정
    - extra_args / reasoningEffort는 effective 기준
  - Done: 매핑별 overrides가 buildArgs 결과에 반영
  - 검증: 단위 테스트 — 같은 provider 인스턴스에 두 가지 overrides 시뮬레이션

- [ ] **T10**: execute/executeStream에서 thread_id 캡처 → SessionManager 저장
  - 파일: `packages/server/src/providers/codex-provider.ts`
  - 변경:
    - `execute(options)` 후 stdout 첫 라인 peek → thread_id 추출 → effective config의 `enable_session_reuse: true`면 `set(clientKey, threadId, model)`
    - `executeStream(options)` 첫 NDJSON 라인 peek → 동일 처리 (wrapper generator)
    - ExecuteResult에 `meta?: { threadId?: string, threadReused: boolean }` 추가
    - 실패/타임아웃/AbortError 시 `invalidate(clientKey)`
  - Done: 정상 호출 후 다음 호출이 resume args로 빌드됨
  - 검증: 통합 테스트 (T16)

- [ ] **T11**: 사전 수동 검증 — `codex exec resume <id> --json -` 출력 포맷
  - 행동: `echo "내 이름은 foo" \| codex exec --json -` → thread_id 캡처 → `echo "이름이 뭐였지" \| codex exec resume <id> --json -` 직접 실행
  - Done: 두 번째 호출의 stdout이 첫 호출과 동일 NDJSON 포맷인지 확인. 다르면 파서 분기 추가 결정
  - 검증: 수동, 결과를 본 계획 PR description에 첨부

### Phase 4: HTTP 라우트 헤더

- [ ] **T12**: 요청 헤더 `X-Cliproxy-Session-Id` 수용
  - 파일: `messages.ts`, `chat-completions.ts`
  - 변경: `clientKey = sessionHeader (valid) || apiKeyId || 'anonymous'`. 검증: `/^[A-Za-z0-9._:-]+$/`, 1~128자, 미충족 시 fallback
  - Done: 헤더 전송 시 clientKey가 그 값과 일치
  - 검증: curl 수동

- [ ] **T13**: 응답 헤더 `X-Cliproxy-Thread-Id` 노출
  - 파일: `messages.ts`, `chat-completions.ts`
  - 변경: ExecuteResult `meta.threadId` 있으면 `reply.header('X-Cliproxy-Thread-Id', threadId)`. stream도 SSE 시작 전 set
  - Done: 응답 헤더 확인 가능
  - 검증: curl `-i`

### Phase 5: 대시보드 UI

- [ ] **T14**: `ModelMappingsPage` 폼에 Provider Overrides 섹션
  - 파일: `packages/dashboard/src/pages/ModelMappingsPage.tsx`, `packages/dashboard/src/api/client.ts`, `packages/dashboard/src/i18n/translations.ts`
  - 변경:
    - 폼 상태 `providerOverrides`에 다음 필드 (codex일 때만 표시):
      - `cli_options.ephemeral` (toggle, default null = 기본값 따름)
      - `cli_options.enable_session_reuse` (toggle, default null)
      - `cli_options.session_ttl_ms` (number input, optional)
      - `extra_args` (textarea per line, optional)
      - `timeout_ms` (number input, optional)
      - `working_dir` (text input, optional)
    - 매핑 저장 시 비어있지 않은 필드만 JSON으로 직렬화하여 API 전송
    - i18n: ko/en 라벨 + helper text ("기본값 사용 시 비워두기" 안내)
    - 화이트리스트 안내 툴팁
  - Done: UI에서 codex 매핑 편집 시 overrides 설정/저장/로드 정상
  - 검증: 대시보드 dev 서버 (`bun run dev:dashboard`) → 매핑 편집 → DB 값 확인

- [ ] **T15**: admin `model-mappings` API에 providerOverrides CRUD
  - 파일: `packages/server/src/routes/admin/model-mappings.ts`
  - 변경:
    - POST/PUT body에 `providerOverrides?: Record<string, unknown>` 수용 → JSON.stringify 후 DB 저장
    - GET 응답에 `providerOverrides`를 JSON.parse 후 객체로 반환 (null이면 undefined)
    - 입력 검증: 화이트리스트 외 키 거부(또는 무시 + 경고). 객체 깊이 제한 (2단계)
  - Done: API로 overrides CRUD 가능
  - 검증: curl로 POST → GET → PUT → DELETE 흐름

### Phase 6: 통합 검증 및 문서화

- [ ] **T16**: 실제 codex CLI 통합 테스트 (오버라이드 시나리오 포함)
  - 파일 (신규): `packages/server/src/providers/codex-cli-resume.integration.test.ts`
  - 변경:
    - `which codex` 실패 시 `test.skip`
    - 시나리오 A (세션 유지): 같은 clientKey + 같은 alias로 2회 호출 → 2번째 응답이 1번째 컨텍스트 반영
    - 시나리오 B (모델별 오버라이드): 같은 codex 인스턴스에 두 alias 등록 (`gpt-chat`: session_reuse=true, `gpt-quick`: ephemeral=true 강제). 같은 clientKey로 번갈아 호출 → 각 alias의 args가 다름을 검증
    - cleanup: 테스트가 만든 `~/.codex/sessions/*.jsonl` 삭제
  - Done: codex 설치 환경에서 통과
  - 검증: `bun test packages/server/src/providers/codex-cli-resume.integration.test.ts`

- [ ] **T17**: 빌드/타입체크/lint/회귀 테스트
  - Done: 전체 통과
  - 검증:
    - `cd /Users/starhunter/StudyProj/aiporj/star-cliproxy && bun run build`
    - `bun test` 전체

- [ ] **T18**: 문서 업데이트
  - 파일: `README.md`, `README.ko.md`, `config.example.yaml`
  - 변경:
    - codex 섹션에 "CLI 모드 세션 재사용" 절 추가
    - "Model-Level Provider Overrides" 신규 절 — 화이트리스트, 사용 예시, 보안 주의사항
    - 헤더 사용법 (`X-Cliproxy-Session-Id` / `X-Cliproxy-Thread-Id`)
    - app-server vs cli+resume vs cli 비교 표
  - Done: 신규 옵션이 양 언어 README + example yaml에 반영
  - 검증: 문서만 보고 설정 가능

## 의존성 그래프

```
T1(타입) ─┬─→ T2(DB) ──→ T15(admin API)
          ├─→ T3(loader)
          ├─→ T4(merge helper) ──→ T5(Router) ──→ T6(라우트 transit)
          │                                              │
          └─→ T7(SessionManager) ──→ T8(provider effective) ──→ T9(buildArgs) ──→ T10(execute capture)
                                          ↑                                              │
                                          T11(사전 수동 검증) ──────────────────────────┘
                                                                                          │
                                                          T12(요청 헤더) ∥ T13(응답 헤더) ┘
                                                                          ↓
                                                                    T14(UI) ∥ T15(admin API)
                                                                          ↓
                                                                    T16(통합 테스트)
                                                                          ↓
                                                                    T17(빌드) → T18(문서)
```

**병렬 가능:** T3 ∥ T4 ∥ T7, T12 ∥ T13, T14 ∥ T15
**크리티컬 패스:** T1 → T2 → T8 → T9 → T10 → T16 → T17 → T18
**진입 게이트:** T11(수동 검증)이 출력 포맷 차이를 드러내면 T9 파서 분기 수정 필요

## 검증 방법

| 항목 | 명령 |
|------|------|
| 타입 체크 | `bun run build` (각 패키지) |
| 단위 테스트 | `bun test packages/server/src/providers/*.test.ts` |
| 통합 테스트 | `bun test packages/server/src/providers/codex-cli-resume.integration.test.ts` |
| 전체 회귀 | `bun test` |
| 수동 E2E A (세션) | curl 2회, 동일 `X-Cliproxy-Session-Id` → 1차 응답의 `X-Cliproxy-Thread-Id`를 2차에 그대로 → 컨텍스트 유지 확인 |
| 수동 E2E B (오버라이드) | 동일 codex 인스턴스에 두 alias 등록 후 번갈아 호출 → 디버그 로그에서 args 차이 확인 |
| 대시보드 | dev 서버 → 모델 매핑 편집 → overrides 설정/저장/로드 |

## 리스크 및 대응

| 리스크 | 영향 | 대응 |
|-------|------|------|
| T11에서 `codex exec resume <id> --json` 출력 포맷이 첫 호출과 다른 경우 | T9 파서 깨짐 | 사전 수동 검증 → 다를 시 codex-provider 파서 분기 추가. 최악의 경우 resume 응답을 별도 파서로 처리 |
| 화이트리스트 우회 시도 (사용자가 yaml/DB에 금지 키 직접 입력) | 보안/안정성 | mergeProviderConfig가 화이트리스트 외 키를 silent drop + warn 로그. config loader에서도 동일 검증 |
| extra_args 교체 vs 추가 정책 모호 | 사용자 혼선 | 본 계획은 **교체**로 통일. README 명시. 추후 `{ extra_args: { mode: 'append', items: [] } }` 형태 확장 가능 |
| Override JSON 파싱 실패 (잘못된 입력) | 라우팅 중단 | T5에서 try/catch + warn 로그 + null fallback. 라우팅은 계속 진행 |
| 동일 clientKey + 동시 호출로 thread set 충돌 | 일시적 thread 중복 | TTL 만료로 자연 정리. 필요시 후속 PR에서 in-flight lock |
| 자동 ephemeral=false 강제 시 사용자 의도 충돌 | jsonl 누적 의도치 않게 발생 | 시작 시 warn 로그 + README 명시 |
| 기존 model_mappings 사용자 회귀 | 기본 동작 변화 | `enable_session_reuse` 기본값 false + `provider_overrides` null → 기존 동작 그대로 |
| 통합 테스트가 codex 미설치 환경에서 실패 | CI 깨짐 | `which codex` 체크 후 skip + README 명시 |
| 헤더/매핑 값 인젝션 | 메모리/저장 키 오염 | T12 정규식 검증 + T15 화이트리스트 + JSON 깊이 제한 |
| 화이트리스트 확장 부담 (다른 프로바이더) | 향후 작업 | 본 계획은 codex만. claude/gemini는 별도 PR(`CLAUDE_OVERRIDE_ALLOWED_KEYS`, `GEMINI_*`) — 동일 패턴 적용 |

## 비-수술적 편집 금지 (Surgical Scope)

**포함되지 않는** 변경:
- claude/copilot/gemini/generic-cli/http/plugin 프로바이더의 overrides 지원 (별도 후속 PR)
- 대시보드 활성 세션 모니터링/강제 무효화 UI (별도 PR)
- `extra_args` append 모드 (현재는 교체만, 향후 확장)
- 기존 app-server 모드 동작 변경
- `previous_response_id` 스타일의 응답 ID 체이닝 (현재는 thread_id로 충분)

## 예상 변경 규모

| 카테고리 | 추정 |
|---------|-----|
| 신규 파일 | 5개 (session-manager, override helper, 각 단위 테스트, 통합 테스트) |
| 수정 파일 | ~12개 (config/provider/server/router/routes/dashboard/i18n/docs/yaml) |
| 신규 LoC | ~500-650줄 |
| 수정 LoC | ~150-200줄 |
| DB 마이그레이션 | 1줄 ALTER TABLE |
| 신규 UI 컴포넌트 | ModelMappingsPage 폼 섹션 1개 |
