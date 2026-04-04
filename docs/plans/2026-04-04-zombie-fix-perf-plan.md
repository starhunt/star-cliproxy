# 좀비 프로세스 방지 + 성능 개선 계획

## 목표

Gemini 좀비 프로세스 재발을 방지하고, 프록시 전반의 요청 처리 성능을 개선한다.

## 배경

3월 21일자 Gemini 프로세스 2개가 `max_concurrent:2` 슬롯을 점유한 채 좀비화 → 이후 모든 Gemini 요청이 큐에서 무한 대기. 근본 원인: `gracefulKill()`이 shell만 죽이고 실제 gemini 자식 프로세스는 살아남음 + 서버 재시작 시 고아 프로세스 정리 없음. 추가로 Gemini의 임시 파일 I/O, Buffer 처리 등 성능 병목도 개선.

## 접근 방식

| 방법 | 장점 | 단점 | 공수 |
|------|------|------|------|
| A: process group kill (`-pid`) | OS 레벨 트리 종료 | 정상 프로세스 오킬 위험 | 소 |
| B: PID 추적 + lifecycle 정리 | 안전, 추적 가능 | 추적 코드 필요 | 중 |

**선택: B** — 스폰된 자식 프로세스 PID를 Set으로 추적하고, 서버 종료 시 전체 정리. 큐 타임아웃도 강화하여 hang 방지. process group kill보다 안전.

## 태스크

### Phase 1: 좀비 프로세스 방지 (안정성)

- [ ] T1: 자식 프로세스 PID 추적 + 서버 종료 시 정리
  - 파일: `packages/server/src/providers/base-provider.ts`, `packages/server/src/index.ts`
  - 변경: Set<ChildProcess>로 활성 프로세스 추적, spawn 시 add / close 시 delete. 서버 shutdown 시 남은 프로세스 전부 gracefulKill. export로 공개하여 index.ts에서 호출.
  - Done: 서버 종료 시 모든 자식 프로세스 정리됨
  - 검증: 타입체크 통과

- [ ] T2: Gemini execute() 프로세스도 추적 대상에 포함
  - 파일: `packages/server/src/providers/gemini-provider.ts`
  - 변경: 자체 spawn한 child를 공유 Set에 등록/해제
  - Done: Gemini non-streaming 프로세스도 추적됨
  - 검증: 타입체크 통과

### Phase 2: 성능 개선

- [ ] T3: health checker 비활성 프로바이더 스킵 + 최소 체크 간격
  - 파일: `packages/server/src/services/health-checker.ts`
  - 변경: checkAll()에서 disabled 프로바이더 필터링, 프로바이더별 최소 체크 간격 5초 보호
  - Done: disabled 프로바이더에 대해 CLI spawn 없음
  - 검증: 타입체크 통과

### Phase 3: 검증

- [ ] T4: 전체 빌드 + 테스트
  - Done: `npm run build` 성공, `npm test` 46+ 통과
  - 검증: `npm run build && npm test`

## 의존성 그래프

```
T1 → T2 (추적 인프라 먼저, Gemini에 적용)
T3 (독립 — health checker)
T1,T2,T3 → T4 (통합 검증)
```

병렬 가능: T3 ∥ (T1→T2)
크리티컬 패스: T1 → T2 → T4

## 검증 방법

- [ ] 빌드: `npm run build`
- [ ] 테스트: `npm test`
- [ ] 수동: 프록시 통해 gemini-flash 호출, `ps aux | grep gemini`로 프로세스 누수 확인

## 리스크 및 대응

| 리스크 | 대응 방안 |
|--------|----------|
| Set이 메모리 누수 가능 | close 이벤트에서 반드시 delete, finally 블록 보장 |
| 서버 crash (process.exit 없이 종료) 시 정리 불가 | OS 레벨 해결 불가 — 다음 시작 시 프로세스 이름으로 고아 탐지는 과잉, 문서로 안내 |
| gracefulKill 중복 호출 | child.killed 체크로 이미 보호됨 |
