# star-cliproxy 컨테이너 이미지 (멀티 타겟)
#
#  서버:      docker build -t star-cliproxy:local .
#  대시보드:  docker build -t star-cliproxy-dashboard:local --target dashboard .
#
# 실행:
#  - 서버: config.yaml(server.host: 0.0.0.0)을 /app/config.yaml로 마운트
#  - 대시보드: CLIPROXY_UPSTREAM 환경변수로 서버 주소 지정 (기본 http://cliproxy:8300)
# 비고:
#  - CLI 프로바이더(claude/codex 등)는 호스트 인증 의존이라 컨테이너에선 비활성 권장.
#  - server 패키지는 현재 tsc 전체 빌드가 통과하지 않는 상태(테스트/실험 코드 타입 오류)라
#    호스트 dev 실행과 동일하게 tsx 런타임으로 구동한다. shared만 tsc 빌드.

# ── 공통 베이스: 의존성 + 소스 ──────────────────────────
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
RUN npm ci
COPY tsconfig*.json ./
COPY packages/shared packages/shared
RUN npm run build --workspace=packages/shared

# ── 서버 (기본 타겟) ────────────────────────────────────
FROM base AS server
COPY packages/server packages/server
RUN mkdir -p /app/data
EXPOSE 8300
CMD ["npx", "tsx", "packages/server/src/index.ts"]

# ── 대시보드 빌드 ───────────────────────────────────────
FROM base AS dashboard-build
COPY packages/dashboard packages/dashboard
RUN npm run build --workspace=packages/dashboard

# ── 대시보드 (nginx 정적 서빙 + API 프록시) ─────────────
FROM nginx:alpine AS dashboard
COPY --from=dashboard-build /app/packages/dashboard/dist /usr/share/nginx/html
# /admin, /v1, /health → cliproxy 서버 프록시 (Vite dev 프록시와 동일 구성)
# nginx 변수($host 등)는 ${...}가 아니므로 envsubst 대상에서 제외됨 (NGINX_ENVSUBST_FILTER)
COPY <<'CONF' /etc/nginx/templates/default.conf.template
server {
    listen 80;
    location /admin { proxy_pass ${CLIPROXY_UPSTREAM}; proxy_set_header Host $host; }
    location /v1 { proxy_pass ${CLIPROXY_UPSTREAM}; proxy_set_header Host $host; proxy_buffering off; }
    location /health { proxy_pass ${CLIPROXY_UPSTREAM}; }
    location / { root /usr/share/nginx/html; try_files $uri /index.html; }
}
CONF
ENV CLIPROXY_UPSTREAM=http://cliproxy:8300
ENV NGINX_ENVSUBST_FILTER=CLIPROXY_UPSTREAM
EXPOSE 80

# 기본 타겟 = 서버
FROM server
