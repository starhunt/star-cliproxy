# Competitive Analysis

star-cliproxy와 유사 프로젝트 비교 분석 (2026-03-17 기준)

---

## 1. CLIProxyAPI (router-for-me)

- **Repository**: https://github.com/router-for-me/CLIProxyAPI
- **Stars**: 16.7k | **Language**: Go | **Releases**: 530+

### 아키텍처 차이

| | CLIProxyAPI | star-cliproxy |
|---|---|---|
| **방식** | OAuth 토큰 재사용 → HTTP API 직접 호출 | CLI subprocess spawn → stdout 파싱 |
| **장점** | 더 빠름 (프로세스 오버헤드 없음) | 단순함 (CLI 인증 그대로 활용) |
| **단점** | OAuth 토큰 관리 복잡 | 프로세스 spawn 오버헤드 |

### CLIProxyAPI 우위

| 기능 | 설명 |
|------|------|
| 10+ 프로바이더 | Claude, Codex, Gemini, Qwen, iFlow, AI Studio, Vertex AI 등 |
| 4개 프로토콜 변환 | OpenAI/Claude/Gemini/Codex 양방향 |
| 멀티-계정 로드밸런싱 | Round-Robin / Fill-First |
| Retry + Credential 로테이션 | 실패 시 다른 자격증명으로 자동 전환 |
| Hot Reload | fsnotify 기반 설정 변경 자동 감지 |
| Docker/Homebrew 배포 | 원클릭 설치 |

### star-cliproxy 우위

| 기능 | 설명 |
|------|------|
| 통합 대시보드 | 서버+대시보드 단일 프로젝트, 별도 설치 불필요 |
| 실시간 활성 요청 추적 | 처리 중 요청 시각적 표시 |
| Test Model 엔드포인트 | 매핑 저장 전 CLI 호출 검증 |
| 3-tier Rate Limiting | 대시보드에서 즉시 변경 가능 |
| 입력 보안 | 메시지 수/길이 제한, null byte 제거, CLI 인젝션 방지 |
| DB 기반 모델 매핑 | priority 폴백 체인, 동적 관리 |

### 채택 권장

- Cooldown 메커니즘 (429/5xx 시 provider 일시 비활성화)
- HTTP 에러별 auto-retry

### 채택 불필요

- OAuth/HTTP 프록시 전환 (아키텍처 전면 재작성 필요)
- 멀티-계정 로드밸런싱 (개인 사용에 불필요)
- Go 재작성 (현 규모에서 TS 개발 속도 이점이 더 큼)

---

## 2. claude_n_codex_api_proxy (jimmc414)

- **Repository**: https://github.com/jimmc414/claude_n_codex_api_proxy
- **Language**: Python | **방식**: mitmproxy 기반 HTTP 인터셉터

### 아키텍처

API 키가 올 나인(999...)일 때 로컬 CLI로 라우팅, 그 외는 클라우드 API로 통과시키는 투명 프록시 패턴.

### 비교

| 기능 | claude_n_codex_api_proxy | star-cliproxy |
|------|------------------------|---------------|
| 스트리밍 | 미지원 (`NotImplementedError`) | 지원 (시뮬레이트) |
| 모델 매핑 | 하드코딩 | DB 기반 동적 |
| 폴백 | 없음 | priority 체인 |
| Rate Limiting | 없음 | 3-tier |
| 대시보드 | 없음 | React UI |
| 입력 검증 | 프롬프트 길이/메시지 수/null byte | 동일 수준 (이 프로젝트에서 차용) |

### 차용한 기능

- 입력 검증 하드닝 (메시지 수/길이 제한, null byte 제거, role 화이트리스트)
- HTTP 요청 본문 크기 제한 (bodyLimit)
- 응답 크기 truncation

---

## 3. Claudian (YishenTu)

- **Repository**: https://github.com/YishenTu/claudian
- **Language**: TypeScript | **용도**: Obsidian 플러그인

### 인증 방식 비교

**양쪽 모두 Claude CLI의 기존 인증(로그인)에 의존** — OAuth 토큰을 직접 관리하지 않음.

| | Claudian | star-cliproxy |
|---|---|---|
| **호출** | `@anthropic-ai/claude-agent-sdk` | `spawn('claude', ['-p', ...])` |
| **구조** | SDK → 내부적으로 CLI subprocess spawn | CLI subprocess 직접 spawn |
| **스트리밍** | SDK AsyncIterable (네이티브 실시간) | JSON 결과 청크 분할 (시뮬레이트) |
| **세션** | 멀티턴 세션 유지/복구 | 무상태 (매 요청 독립) |
| **도구 실행** | 파일 CRUD, bash, MCP | 없음 (`--max-turns 1`) |

### 핵심 발견

Claudian의 SDK도 **내부적으로 CLI를 spawn**한다. 같은 레이어를 쓰되 SDK가 세션 관리/스트리밍/도구 실행의 추상화를 제공.

### Agent SDK 도입 가능성

`@anthropic-ai/claude-agent-sdk` 도입 시:
- 네이티브 실시간 스트리밍 가능 (현재 시뮬레이트 스트리밍 한계 해소)
- 멀티턴 세션 유지
- 인증 방식 동일 유지

트레이드오프:
- SDK 의존성 추가
- Codex/Gemini에는 해당 SDK 없음 (Claude provider만 적용)
- 현재 CLI 직접 호출의 단순성 상실

---

## 종합 포지셔닝

```
                    기능 풍부함
                        ↑
                        |
    CLIProxyAPI ●       |
    (Go, 16.7k stars)   |
    OAuth HTTP 프록시    |
                        |
                        |       ● star-cliproxy
                        |       (TS, 개인 프로젝트)
                        |       CLI subprocess + 대시보드
                        |
    claude_n_codex ●    |
    (Python, mitmproxy) |
                        |
    ─────────────────────────────→ 단순성
                        |
                        |  ● Claudian
                        |  (TS, Obsidian 플러그인)
                        |  Agent SDK, 단일 provider
```

star-cliproxy의 니치: **CLI subprocess 기반 + 통합 대시보드 + 멀티 provider** — CLIProxyAPI보다 단순하면서도 claude_n_codex_api_proxy보다 기능이 풍부한 중간 지점.
