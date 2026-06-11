# star-cliproxy 전체 감사 보고서

- **일자**: 2026-06-12
- **범위**: packages/server, packages/shared, packages/dashboard, 설정/인프라/저장소 위생 (node_modules·dist 제외)
- **방법**: 보안 / 코드 품질 / 아키텍처 / 운영 4개 관점 병렬 감사 + 교차 검증 (충돌 항목은 직접 명령 실행으로 재확인)
- **테스트 기준선**: `vitest run` — 15 파일, 156 passed / 1 skipped (전체 통과)

---

## 종합 평가

| 영역 | 평가 | 요약 |
|------|------|------|
| 보안 | **MEDIUM 위험** | 시크릿 관리·인증은 견고. 의존성 취약점(런타임 HIGH 6건)과 SSRF·디버그 로그 평문 저장이 주요 이슈 |
| 코드 품질 | **양호하나 동시성 버그 4건(HIGH)** | 타입 규율 우수(`any` 0건). 스트리밍/동시성 경로에 실질 버그 존재 |
| 아키텍처 | **부채 누적 중** | 라우트 직접 DB 접근, 600줄+ God Function, config 무검증 캐스팅 |
| 운영/인프라 | **75% 양호** | 저장소 위생 정상. CI 부재, Docker root 실행, tsbuildinfo 추적이 결함 |

**비인증 원격 공격자가 시스템을 장악할 수 있는 CRITICAL 경로는 발견되지 않음.**

---

## 잘 되어 있는 점 (검증 완료)

- **시크릿 관리**: `.env`/`config.yaml`/백업 파일 모두 git 미추적, 히스토리에도 없음. config는 `${ADMIN_TOKEN}` env 치환만 사용, 하드코딩 0건
- **인증**: admin 토큰 `timingSafeEqual` 비교(`auth.ts:17-24`), API 키 SHA-256 해시 저장, Fastify 글로벌 onRequest 훅으로 우회 경로 없음, admin 토큰 미설정 시 부팅 차단
- **XSS**: `dangerouslySetInnerHTML`/`innerHTML`/`eval` 0건
- **로깅**: backend.log(21MB)·request_logs에 API 키/프롬프트 본문 누출 없음, 디버그 cliArgs에 시크릿 레닥션 적용
- **인젝션(POSIX)**: spawn args 배열 분리 전달로 macOS/Linux에서 셸 인젝션 불가, SQL은 drizzle 파라미터 바인딩
- **프로세스 관리**: `activeProcesses` Set 전역 추적 + 종료 시 `killAllChildProcesses`, 요청 취소 AbortController 전파, 큐 대기 중 취소 처리
- **타입 규율**: server 소스 `any` 0건, strict 모드 전역 활성화

---

## 1. 즉시 조치 (P0)

### 1-1. [HIGH·보안] 런타임 의존성 취약점 6 HIGH + 1 MODERATE — *직접 검증 완료*

`npm audit --omit=dev` 결과 (dev 전용 아닌 **운영 런타임** 의존성):

| 패키지 | 심각도 | 취약점 | 수정 |
|--------|--------|--------|------|
| drizzle-orm <0.45.2 | HIGH | SQL injection via escaped identifiers (GHSA-gpj5-g38j-94v9) | **breaking** — 0.45.2 업그레이드 후 테스트 필수 |
| fastify 5.3.2–5.8.4 | HIGH | Content-Type 선행 공백으로 body schema 검증 우회 (GHSA-247c-9743-5963) | `npm audit fix` |
| fast-uri ≤3.1.1 | HIGH | path traversal + host confusion | `npm audit fix` |
| lodash ≤4.17.23 | HIGH | `_.template` 코드 인젝션, prototype pollution | `npm audit fix` |
| react-router 7.0.0–7.14.2 | HIGH | turbo-stream 역직렬화 RCE 외 3건 | `npm audit fix` |
| ws 8.0.0–8.20.0 | MODERATE | 미초기화 메모리 노출 | `npm audit fix` |

dev 의존성에도 vitest CRITICAL(GHSA-5xrq-8626-4rwp) 등 추가 12건 존재.

**조치**:
```bash
npm audit fix                    # non-breaking 일괄
npm audit fix --force            # drizzle-orm 0.45.2 (breaking) — 전체 테스트로 검증
npx vitest run                   # flip 확인 (기준선: 156 passed)
```

### 1-2. [HIGH·버그] codex app-server 동시 요청 시 응답 텍스트 교차 오염
`packages/server/src/providers/codex-appserver-executor.ts:587-617`

단일 `CodexAppServerProcess`를 모든 요청이 공유하는데, notification 필터가 `threadId`만 비교한다. 같은 `clientKey`+`model`의 동시 요청 2건이 **동일 threadId를 재사용**하므로 `max_concurrent > 1`이면 delta 이벤트가 양쪽에 섞이거나 상대 요청의 `turn/completed`로 조기 종료된다.

**조치**: `turnId`까지 필터에 포함하거나 thread 단위 turn 직렬화(per-thread mutex).

### 1-3. [HIGH·버그] 스트리밍 폴백 시 rate limit 중복 카운트
`packages/server/src/routes/v1/chat-completions.ts:356,419`

`checkAndIncrement`가 폴백 루프(`for route of routes`) **안**에 있어 첫 프로바이더 실패 → 폴백 시 글로벌 RPM/RPD가 다시 차감된다. 실제 1건이 N건으로 집계되어 한도 조기 소진. 큐 대기 중 클라이언트 abort 시 증가분 롤백도 없음.

**조치**: 글로벌/키 카운트는 루프 진입 전 1회, 프로바이더 카운트만 루프 내. abort 시 롤백.

### 1-4. [HIGH·버그] 스트리밍 리소스 누수 2건
- `http-provider.ts:335,346-348` — `done` 시 `reader.cancel()` 없이 `releaseLock()`만 호출 → 백엔드 소켓이 timeout까지 잔류. **조치**: finally에서 `await reader.cancel().catch(()=>{})`.
- `chat-completions.ts:416` — `request.raw.on('close', ...)` 리스너를 완료 후 미해제 + 폴백마다 누적. **조치**: `once` + 완료/에러 시 `off`, abortController는 루프 밖 1회 생성.

### 1-5. [MEDIUM·위생] tsconfig.tsbuildinfo git 추적 제거 — *git status에서도 M으로 노이즈 발생 중*
```bash
echo "*.tsbuildinfo" >> .gitignore
git rm --cached packages/server/tsconfig.tsbuildinfo packages/shared/tsconfig.tsbuildinfo
```

---

## 2. 단기 조치 (P1 — 스프린트 내)

### 보안

| # | 항목 | 위치 | 요점 |
|---|------|------|------|
| 2-1 | [MEDIUM] HTTP 프로바이더 `base_url` SSRF 차단 없음 | `routes/admin/http-providers.ts:22-33` | 프로토콜만 검사. admin 토큰 탈취 시 `169.254.169.254`(클라우드 메타데이터)·내부망 접근 가능. 로컬 추론 서버(Ollama) 유스케이스가 있으므로 **사설망 차단 + `allow_private_targets` 옵트인** 권장 |
| 2-2 | [MEDIUM] 디버그 로그에 프롬프트/응답 평문 영속화 | `services/debug.ts:103-129` | `cliArgs`만 레닥션, `requestMessages`/`rawStdout`는 평문 SQLite 저장. 레닥션 적용 + TTL 자동 삭제 도입 |
| 2-3 | [MEDIUM] admin 토큰 localStorage 저장 | `dashboard/src/auth/token.ts:3-22` | XSS 1건 발생 시 전체 admin 권한 탈취. httpOnly 쿠키 세션 전환 권장 (로컬 단독 운영이면 위험도 낮음) |
| 2-4 | [MEDIUM] CORS 무제한 헤더 reflect + `*` origin | `app.ts:150-155` | 운영 시 대시보드 origin으로 제한, README에 운영 권고 명시 |
| 2-5 | [MEDIUM] 플러그인 = 임의 코드 실행 (설계상) | `plugins/plugin-loader.ts:138` | 신뢰 모델 문서화 + config/plugins 디렉토리 권한(0600/0700) 안내 + 무결성 해시 옵션 검토 |
| 2-6 | [INFO] 보안 헤더 부재 | `app.ts` | `@fastify/helmet` 도입 (CSP/X-Frame-Options 등) |

### 버그/품질 (MEDIUM)

| # | 항목 | 위치 | 요점 |
|---|------|------|------|
| 2-7 | /v1/responses 가짜 스트리밍 + write 가드 없음 | `app.ts:211,280,304-312` | non-streaming 후 20자 청킹 → TTFB 지연. `reply.raw.write`에 destroyed 체크 없어 연결 끊김 시 크래시 가능 |
| 2-8 | gracefulKill SIGKILL 타이머 unref 없음 | `base-provider.ts:300-310` | `killTimer.unref()` + `exit`/`close` 양쪽에서 clear |
| 2-9 | app-server 재시작 타이머 미추적 | `codex-appserver-process.ts:282-288` | `stop()` 후 좀비 재시작 가능. 타이머 필드로 추적 + clearTimeout + unref |
| 2-10 | rate-limiter flushToDb 트랜잭션 없음 | `rate-limiter.ts:201-224` | flush 도중 크래시 시 부분 갱신. `db.transaction`으로 래핑 |
| 2-11 | health-checker 매 폴백마다 DB 조회 + stale 읽기 | `health-checker.ts:76-81` | 인메모리 캐시로 읽고 DB는 비동기 영속화만 |
| 2-12 | lint 게이트 미작동 | 루트 | ESLint v10인데 `eslint.config.js`(flat config) 없음 → `npm run lint` 실패. 정적 분석 게이트 사실상 부재 |

### 테스트 공백 (HIGH 버그들이 모두 이 공백 영역에서 발생)

- **인증 미들웨어(auth.ts) 테스트 0건** — 보안 핵심인데 미커버
- **rate-limiter 롤백/폴백 테스트 0건** — 1-3 버그를 잡을 회귀 테스트 부재
- **chat-completions 실제 SSE 스트리밍/abort/폴백 통합 테스트 없음**
- **codex-appserver 동시성 테스트 없음** — 1-2 버그 미탐지 원인

→ auth + rate-limiter 단위 테스트, 스트리밍 통합 테스트를 우선 추가.

### 운영

| # | 항목 | 조치 |
|---|------|------|
| 2-13 | [MEDIUM] CI 부재 (.github/ 없음) | GitHub Actions: lint + typecheck + test + build |
| 2-14 | [MEDIUM] Docker root 실행 | `USER node` 지시어 추가 |
| 2-15 | [LOW] HEALTHCHECK 없음 | `/health` 기반 HEALTHCHECK 추가 |

---

## 3. 중기 개선 (P2 — 아키텍처 부채)

### 3-1. 라우트의 직접 DB 접근 (Repository 계층 부재) — 부채 1순위
`routes/admin/*` 11개 파일 30+ 지점에서 `getDatabase()` + drizzle 쿼리 직접 수행. 스키마 변경 시 산탄총 수술 발생.

**권장**: 점진적(스트랭글러) 도입 — 변경 빈도 높은 `model-mappings`/`api-keys`부터 `db/repositories/*`로 추출, 신규 라우트는 repo 강제. (일괄 전환은 회귀 리스크가 커서 비추천)

### 3-2. chat-completions.ts God Function (600줄+ 단일 핸들러)
`chat-completions.ts:199-805` — 검증/라우팅/캐시/폴백/스트리밍/로깅/디버그가 한 핸들러에. 테스트 불가에 가깝고 `messages.ts`와 중복 가능성.

**권장**: `validateRequest → resolveRoutes → tryCache → executeWithFallback → streamResponse` 파이프라인 분해. 기존 `tools-error.test.ts`를 flip 기준선으로 사용.

### 3-3. config 스키마 검증 부재
`config/loader.ts:100-189` 전 구간 무검증 `as` 캐스팅. port에 문자열이 들어와도 런타임까지 통과.

**권장**: shared에 Zod `AppConfigSchema` 정의 → loader에서 `parse()` fail-fast. adminToken의 이중 설정 경로(env 치환 vs `?? process.env`)도 단일화.

### 3-4. 대시보드-서버 타입 미공유 (드리프트 위험)
대시보드가 `@star-cliproxy/shared`를 **한 번도 import하지 않고** `api/client.ts`에 응답 타입을 손으로 재정의. 서버 필드 변경이 컴파일 타임에 잡히지 않음.

**권장**: `shared/src/types/admin-api.ts`로 응답 타입 이동, 양쪽에서 import.

### 3-5. graceful shutdown이 in-flight 요청 미대기
`index.ts:43-52` — SIGTERM 즉시 자식 프로세스 kill. `ActiveRequestTracker`가 있는데 종료 시퀀스에 미연동.

**권장**: drain 패턴 — 신규 요청 503 → activeRequests 0 또는 타임아웃까지 대기 → killAll.

### 3-6. 기타
- DB 스키마 이중화: `db/client.ts`의 raw CREATE/ALTER와 `db/schema.ts` drizzle 정의 공존 → drizzle-kit migrate로 SSOT 통일. 마이그레이션 try-catch가 모든 에러를 삼키는 문제(`client.ts:135-181`)도 함께 해결
- `HttpProvider`가 `BaseProvider`(CLI 전제)를 상속하며 메서드 무효화 → `Provider` 인터페이스 아래 형제로 분리
- 세션 매니저 3종(codex-cli/appserver/claude-sdk) 거의 동일한 Map+TTL 로직 → 제네릭 `SessionStore<T>` 추출
- 전역 child process 상한 없음 (프로바이더별 큐 합이 OS 한계 초과 가능)
- 800줄 초과: `http-provider.ts`(824), `chat-completions.ts`(805), `ProvidersPage.tsx`(1957)
- Windows 한정 셸 인젝션 2건(LOW): `base-provider.ts:195-203` `shell: isWin`, `gemini-provider.ts:116-126` 수동 셸 조립 — Windows 배포 계획 있으면 수정
- console.log 32건 → logger 통일, `.bak` 파일 디스크 정리

---

## 4. 권장 실행 순서

| 순서 | 작업 | 규모 | 비고 |
|------|------|------|------|
| 1 | `npm audit fix` + drizzle 0.45.2 별도 검증 | TRIVIAL~SCOPED | 기준선 156 passed 대비 flip 확인 |
| 2 | tsbuildinfo gitignore + eslint flat config 추가 | TRIVIAL | |
| 3 | HIGH 버그 4건 수정 (1-2 ~ 1-4) + 회귀 테스트 | SCOPED | 이슈→브랜치→PR. rate-limiter/스트리밍 테스트 동반 |
| 4 | SSRF 차단 + 디버그 로그 레닥션 + CORS 제한 | SCOPED | 보안 묶음 PR |
| 5 | CI 워크플로 + Dockerfile USER/HEALTHCHECK | SCOPED | |
| 6 | Zod config 검증 + admin-api 타입 shared 이동 | SCOPED | 한 PR로 묶기 적합 |
| 7 | drain shutdown + Repository 점진 도입 시작 | SCOPED~COMPLEX | 스트랭글러 패턴 |
| 8 | chat-completions 파이프라인 분해 | COMPLEX | `/plan` 선행 권장 |

---

## 부록: 교차 검증 메모

- 보안 에이전트는 취약점을 "dev 전용"으로 보고했으나 `npm audit --omit=dev` 직접 실행 결과 **런타임 의존성에 HIGH 6건** 확인 — 운영 점검 결과 채택 (1-1).
- 시크릿 git 미추적, 로그 무누출, 인증 훅 적용은 두 에이전트가 독립적으로 동일 확인 — 신뢰도 높음.
- `messages.ts`의 chat-completions 로직 복제 여부는 미확인 (3-2 착수 전 확인 필요).
