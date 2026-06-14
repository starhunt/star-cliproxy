#!/bin/bash
# star-cliproxy - 백엔드/대시보드 시작 스크립트
# 사용법: ./start.sh [start|stop|restart|status]

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PID_FILE="$PROJECT_DIR/.backend.pid"
DASHBOARD_PID_FILE="$PROJECT_DIR/.dashboard.pid"
LOG_DIR="$PROJECT_DIR/logs"

mkdir -p "$LOG_DIR"

start_servers() {
    if [ -f "$BACKEND_PID_FILE" ] && kill -0 "$(cat "$BACKEND_PID_FILE")" 2>/dev/null; then
        echo "백엔드가 이미 실행 중입니다 (PID: $(cat "$BACKEND_PID_FILE"))"
    else
        echo "백엔드 시작 중..."
        cd "$PROJECT_DIR"
        nohup npm run dev > "$LOG_DIR/backend.log" 2>&1 &
        echo $! > "$BACKEND_PID_FILE"
        echo "백엔드 시작됨 (PID: $!, http://localhost:8300)"
    fi

    if [ -f "$DASHBOARD_PID_FILE" ] && kill -0 "$(cat "$DASHBOARD_PID_FILE")" 2>/dev/null; then
        echo "대시보드가 이미 실행 중입니다 (PID: $(cat "$DASHBOARD_PID_FILE"))"
    else
        echo "대시보드 시작 중..."
        cd "$PROJECT_DIR"
        nohup npm run dev:dashboard > "$LOG_DIR/dashboard.log" 2>&1 &
        echo $! > "$DASHBOARD_PID_FILE"
        echo "대시보드 시작됨 (PID: $!, http://localhost:5300)"
    fi
}

stop_servers() {
    if [ -f "$BACKEND_PID_FILE" ]; then
        PID=$(cat "$BACKEND_PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            pkill -P "$PID" 2>/dev/null
            kill "$PID" 2>/dev/null
            echo "백엔드 종료됨 (PID: $PID)"
        fi
        rm -f "$BACKEND_PID_FILE"
    else
        echo "백엔드가 실행 중이 아닙니다"
    fi

    if [ -f "$DASHBOARD_PID_FILE" ]; then
        PID=$(cat "$DASHBOARD_PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            pkill -P "$PID" 2>/dev/null
            kill "$PID" 2>/dev/null
            echo "대시보드 종료됨 (PID: $PID)"
        fi
        rm -f "$DASHBOARD_PID_FILE"
    else
        echo "대시보드가 실행 중이 아닙니다"
    fi
}

show_status() {
    echo "=== star-cliproxy 서버 상태 ==="
    if [ -f "$BACKEND_PID_FILE" ] && kill -0 "$(cat "$BACKEND_PID_FILE")" 2>/dev/null; then
        echo "백엔드:   ✅ 실행 중 (PID: $(cat "$BACKEND_PID_FILE"), http://localhost:8300)"
    else
        echo "백엔드:   ❌ 중지됨"
    fi

    if [ -f "$DASHBOARD_PID_FILE" ] && kill -0 "$(cat "$DASHBOARD_PID_FILE")" 2>/dev/null; then
        echo "대시보드: ✅ 실행 중 (PID: $(cat "$DASHBOARD_PID_FILE"), http://localhost:5300)"
    else
        echo "대시보드: ❌ 중지됨"
    fi
}

case "${1:-start}" in
    start)  start_servers ;;
    stop)   stop_servers ;;
    status) show_status ;;
    restart)
        stop_servers
        sleep 2
        start_servers
        ;;
    *)
        echo "사용법: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
