# Gemini CLI stdout 잘림 문제 수정

## 날짜
2026-03-24

## 문제
Gemini Flash 모델로 긴 응답(유튜브 영상 요약 → 마크다운 변환 등)을 처리할 때, 응답 데이터가 중간에 잘리는 현상 발생.

### 증상
- 비스트리밍(non-streaming) 모드에서 JSON 응답이 불완전하게 수신됨
- `parseNonStreamOutput`에서 `JSON.parse` 실패 → regex fallback → stats JSON이 content에 포함
- Flash 모델처럼 빠르고 긴 응답일수록 발생 빈도 높음

## 근본 원인
**Gemini CLI는 stdout이 pipe일 때 8KB(8192 bytes) 블록 버퍼링을 사용하며, 프로세스 종료 시 마지막 불완전 버퍼를 flush하지 않음.**

### 검증 결과

| 수집 방식 | 수신 바이트 | JSON 유효성 | 비고 |
|-----------|------------|-------------|------|
| `spawn` pipe + `data` 이벤트 | 8192 (정확히 8KB) | ✗ 잘림 | 마지막 버퍼 미flush |
| `execFile` (Node.js 내장) | 8192 (정확히 8KB) | ✗ 잘림 | 내부적으로 동일 pipe 사용 |
| shell redirect (`> file`) | 8418 | ✓ 완전 | OS 레벨 파일 flush |
| 터미널 직접 실행 | 8316 | ✓ 완전 | TTY 모드 (라인 버퍼링) |

### 디버그 로그 증거
```
[GEMINI DEBUG] stdout end: 1 chunks, 8192 bytes
[GEMINI DEBUG] JSON.parse FAILED: Expected double-quoted property name in JSON at position 4792
```
- data 이벤트가 1번만 발생 (8192 bytes)
- end 이벤트 이후 추가 데이터 없음
- 프로세스 exit code는 0 (정상 종료)

## 수정 내용

### 변경 파일
- `packages/server/src/providers/gemini-provider.ts`

### 수정 방식
`execute()` 메서드에서 shell redirect 방식으로 stdout 수집:

```typescript
// shell을 통해 stdout을 파일로 리다이렉트
const shellCmd = [cli_path, ...args.map(a => JSON.stringify(a))].join(' ') + ' > ' + tmpFile;
const child = spawn('sh', ['-c', shellCmd], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
// 프로세스 종료 후 파일 읽기
const stdout = await readFile(tmpFile, 'utf-8');
```

### 왜 이 방식인가
- pipe 방식(`spawn`/`execFile`)은 Gemini CLI의 버퍼 flush 문제를 우회할 수 없음
- 파일 리다이렉트는 OS 커널이 프로세스 종료 시 파일 디스크립터를 닫으면서 자동으로 모든 데이터를 flush
- 스트리밍(`executeStream`)은 readline 기반으로 별도 동작하므로 영향 없음

## 시도했던 접근과 실패 이유

| 접근 | 결과 | 실패 이유 |
|------|------|-----------|
| 메모리 수집 (`data` + `end` 이벤트) | 실패 | CLI가 pipe에 8KB만 flush |
| `child.on('close')` 대기 | 실패 | close 시점에도 추가 데이터 없음 |
| `execFile` (maxBuffer: 10MB) | 실패 | 내부적으로 동일 pipe 메커니즘 |
| shell redirect (`> file`) | **성공** | OS 레벨 파일 flush |

## 관련 히스토리
- 이전 커밋 `7fe21ec`에서 동일 유형의 pipe 잘림(4KB) 문제를 shell redirect로 해결한 이력 있음
- 이후 리팩토링 과정에서 pipe 방식으로 회귀했었음
