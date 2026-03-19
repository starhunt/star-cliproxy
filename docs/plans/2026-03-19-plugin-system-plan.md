# Plugin System for Custom Providers

## 목표

메인 코드 변경 없이 커스텀 프로바이더를 추가할 수 있는 플러그인 시스템 구축.
- 빌트인 프로바이더(claude, codex, gemini)는 메인에 유지
- 커스텀 프로바이더는 `plugins/` 디렉토리에서 동적 로드
- 엔드포인트 타입(chat, images, tts 등) 선언으로 라우팅 자동 분기

## 설계 핵심

### 플러그인 인터페이스

```typescript
// 플러그인이 export해야 하는 계약
export interface CliproxyPlugin {
  name: string;                              // 프로바이더 이름 (예: 'aioni')
  endpointTypes: EndpointType[];             // ['chat'] | ['images'] | ['chat', 'images']
  createProvider(config: ProviderConfigYaml): BaseProvider;
  createParser?(): StreamParser;             // 없으면 PlainTextParser 기본 제공
}

export type EndpointType = 'chat' | 'images' | 'tts' | 'embeddings';
```

### 디렉토리 구조

```
plugins/                          # .gitignore됨
  cliproxy-plugin-aioni/
    index.ts (or index.js)
    package.json                  # { "main": "index.js" }
```

### config.yaml 설정

```yaml
plugins:
  - path: "./plugins/cliproxy-plugin-aioni"   # 로컬 디렉토리
    config:                                    # 플러그인별 설정 (providers 섹션으로 병합)
      cli_path: "/usr/local/bin/aioni"
      default_model: "gemini-3-pro-image"
      timeout_ms: 120000
```

### 로딩 흐름

```
서버 시작
  ↓
config.yaml 로드 (plugins 섹션 포함)
  ↓
빌트인 3개 프로바이더 등록 (기존과 동일)
  ↓
plugins/ 디렉토리 스캔 + dynamic import
  ↓
각 플러그인의 createProvider() 호출 → 레지스트리에 등록
  ↓
엔드포인트 타입별 라우트 활성화
  - chat → /v1/chat/completions (기존)
  - images → /v1/images/generations (플러그인이 있을 때만 활성화)
```

## 태스크

### Phase 1: 타입 시스템 개방 (기반 작업)

#### 1. [ ] ProviderName 타입 개방
- **파일**: `packages/shared/src/types/provider.ts`
- **작업**:
  - `ProviderName = 'claude' | 'codex' | 'gemini'` → `string`으로 변경
  - `BUILTIN_PROVIDERS = ['claude', 'codex', 'gemini'] as const` 상수 추가
  - `BuiltinProviderName` 타입 추가 (기존 코드 자동완성 유지)
  - `EndpointType = 'chat' | 'images' | 'tts' | 'embeddings'` 추가
  - `CliproxyPlugin` 인터페이스 추가

#### 2. [ ] AppConfig 타입 동적화
- **파일**: `packages/shared/src/types/config.ts`
- **작업**:
  - `providers: Record<ProviderName, ...>` → `Record<string, ProviderConfigYaml>`
  - `perProvider: Partial<Record<ProviderName, ...>>` → `Record<string, { rpm: number }>`
  - `ModelMappingSeed.provider` 타입을 `string`으로 변경
  - `PluginEntry` 타입 추가 (path, config)
  - `AppConfig`에 `plugins: PluginEntry[]` 필드 추가

### Phase 2: 동적 프로바이더 레지스트리

#### 3. [ ] ProviderRegistry 동적화
- **파일**: `packages/server/src/providers/provider-registry.ts`
- **작업**:
  - `Map<ProviderName, ...>` → `Map<string, ...>`
  - `createProviderRegistry(configs)` → 빌트인 3개는 팩토리 패턴으로 등록
  - 커스텀 프로바이더용 `registerPlugin()` 메서드 추가

#### 4. [ ] BaseProvider name 타입 변경
- **파일**: `packages/server/src/providers/base-provider.ts`
- **작업**: `abstract readonly name: ProviderName` → `abstract readonly name: string`

#### 5. [ ] 빌트인 프로바이더 name 타입 정리
- **파일**: `claude-provider.ts`, `codex-provider.ts`, `gemini-provider.ts`
- **작업**: `as const` 유지, 타입은 자연스럽게 string 호환

#### 6. [ ] StreamParser 레지스트리화
- **파일**: `packages/server/src/utils/stream-transformer.ts`
- **작업**:
  - `getParserForProvider()` switch문 → Map 기반 레지스트리
  - `registerParser(provider, factory)` 함수 export
  - 빌트인 3개 파서는 초기화 시 등록
  - `PlainTextParser` 추가 (커스텀 프로바이더 기본 파서)

### Phase 3: Config Loader 확장

#### 7. [ ] Config Loader 동적 프로바이더 지원
- **파일**: `packages/server/src/config/loader.ts`
- **작업**:
  - 빌트인 3개는 기존 로직 유지 (기본값 병합)
  - `plugins` 섹션 파싱 추가
  - 플러그인 config를 providers에 동적 병합
  - 커스텀 프로바이더의 rate limit 기본값 자동 설정

### Phase 4: 플러그인 로더

#### 8. [ ] Plugin Loader 구현
- **파일**: `packages/server/src/plugins/plugin-loader.ts` (신규)
- **작업**:
  - `loadPlugins(pluginEntries, registry, parserRegistry)` 함수
  - 각 플러그인 경로에서 `dynamic import()`
  - `CliproxyPlugin` 인터페이스 검증 (이름 충돌, 필수 필드)
  - 프로바이더 등록 + 파서 등록 (있으면)
  - 에러 핸들링: 플러그인 로드 실패 시 경고만 (서버 시작 차단하지 않음)

### Phase 5: 서비스 레이어 ProviderName 타입 전환

#### 9. [ ] 의존 서비스 타입 변경
- **파일들**:
  - `services/router.ts` — `ResolvedRoute.provider: string`, `inferProvider(): string | null`
  - `services/queue.ts` — `Map<string, PQueue>`, 메서드 시그니처
  - `services/health-checker.ts` — 메서드 파라미터 `string`으로
  - `middleware/rate-limiter.ts` — `checkAndIncrement` provider 파라미터
  - `routes/admin/providers.ts` — 타입 캐스팅 제거
  - `routes/admin/rate-limits.ts` — `RateLimitsBody.perProvider` 동적화
  - `routes/admin/test-model.ts` — 타입 캐스팅 제거
  - `routes/v1/chat-completions.ts` — import 정리
  - `app.ts` — 큐 등록 `as` 캐스팅 제거, 플러그인 로드 호출 추가

### Phase 6: .gitignore + 플러그인 예제

#### 10. [ ] gitignore 및 예제 플러그인
- **파일**: `.gitignore`에 `plugins/*/` 추가
- **파일**: `plugins/.gitkeep` (디렉토리 유지)
- **파일**: `plugins/README.md` — 플러그인 작성 가이드
- **파일**: `plugins/example-plugin/` — 최소 예제 (gitignore 제외)

## 검증 방법

- [ ] 빌드 확인: `npm run build` (packages/shared + packages/server)
- [ ] 타입 체크: `npx tsc --noEmit`
- [ ] 기존 테스트: `npm test` (빌트인 3개 프로바이더 동작 불변)
- [ ] 플러그인 없이 시작: 기존과 동일하게 동작
- [ ] 예제 플러그인으로 시작: 플러그인 등록 + /admin/providers에 표시 확인

## 리스크

| 리스크 | 대응 |
|--------|------|
| ProviderName→string 변경 시 타입 안전성 감소 | BUILTIN_PROVIDERS 상수로 빌트인 타입 가드 유지 |
| 플러그인 dynamic import 경로 문제 (ESM/CJS) | `pathToFileURL` + `import()` 조합으로 ESM 호환 |
| 플러그인이 서버를 크래시시킬 수 있음 | try-catch로 격리, 실패 시 경고 로그만 |
| 대시보드가 ProviderName 타입 사용할 수 있음 | 대시보드는 API 응답 기반이라 영향 없을 것 (확인 필요) |
| config.yaml 없이 plugins만 있는 경우 | plugins 섹션은 선택적, 없으면 빌트인만 동작 |

## 변경 영향 범위

- `packages/shared`: 2파일 (타입 정의)
- `packages/server`: 12파일 (레지스트리, 로더, 서비스, 라우트)
- 신규 파일: 3-4개 (plugin-loader, PlainTextParser, 예제)
- `packages/dashboard`: 0파일 (API 기반이므로 영향 없음 예상)

## 구현 순서 요약

```
Phase 1 (타입 개방) → Phase 2 (레지스트리) → Phase 3 (config)
    → Phase 4 (플러그인 로더) → Phase 5 (서비스 전환) → Phase 6 (문서/예제)
```

Phase 1~3이 핵심. Phase 4가 플러그인 고유 로직. Phase 5는 기계적 타입 변환. Phase 6은 마무리.
