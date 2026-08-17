#!/usr/bin/env bash
#
# deepseek-anchor-gateway 启动脚本
#
# 用法:
#   ./start.sh [start|stop|restart|status]
#
# 行为:
#   - 自动从 ~/.config/bingo/settings.json 读取 opencode-go 的 apiKey
#   - 上游固定为 https://opencode.ai/zen/go
#   - 默认开启 ANCHOR_PROMOTE_AFTER_FIRST=1（首轮锚定后提升全量工具）
#   - 用 pidfile 管理单实例（默认 ~/.local/run/deepseek-anchor-gateway.pid）
#   - 日志追加到项目目录 gateway.log
#
# 环境变量覆盖:
#   ANCHOR_UPSTREAM_KEY  显式指定 key（不指定则从 bingo 配置读）
#   ANCHOR_PORT          端口（默认 8787）
#   ANCHOR_DEBUG         设为 1 开启调试日志

set -euo pipefail

# ── 路径 ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="${SCRIPT_DIR}/server.mjs"
LOGFILE="${SCRIPT_DIR}/gateway.log"
RUNDIR="${XDG_RUNTIME_DIR:-${HOME}/.local/run}"
PIDFILE="${RUNDIR}/deepseek-anchor-gateway.pid"

DEFAULT_UPSTREAM="https://opencode.ai/zen/go"
DEFAULT_PORT=8787
BINGO_SETTINGS="${HOME}/.config/bingo/settings.json"
BINGO_PROVIDER="opencode-go"

# ── 从 bingo 配置读取 key ───────────────────────────────────────────────────
read_bingo_key() {
  python3 - "$@" <<'PY'
import json, os, sys
try:
    cfg = json.load(open(os.path.expanduser("~/.config/bingo/settings.json")))
    p = cfg.get("providers", {}).get("opencode-go", {})
    key = p.get("apiKey", "")
    if key:
        print(key)
except Exception:
    sys.exit(1)
PY
}

# ── 子命令 ──────────────────────────────────────────────────────────────────
is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

cmd_start() {
  if is_running; then
    echo "already running (pid $(cat "$PIDFILE"))"
    return 0
  fi

  local key="${ANCHOR_UPSTREAM_KEY:-}"
  if [ -z "$key" ]; then
    if [ -f "$BINGO_SETTINGS" ]; then
      key="$(read_bingo_key)" || {
        echo "✗ 无法从 ${BINGO_SETTINGS} 读取 ${BINGO_PROVIDER} 的 apiKey"
        echo "  请用 ANCHOR_UPSTREAM_KEY=... 显式指定"
        exit 1
      }
    else
      echo "✗ 未找到 ${BINGO_SETTINGS}，请用 ANCHOR_UPSTREAM_KEY=... 指定"
      exit 1
    fi
  fi

  mkdir -p "$RUNDIR"
  local env_args=(
    ANCHOR_UPSTREAM_KEY="$key"
    ANCHOR_UPSTREAM_URL="${ANCHOR_UPSTREAM_URL:-$DEFAULT_UPSTREAM}"
    ANCHOR_PORT="${ANCHOR_PORT:-$DEFAULT_PORT}"
    ANCHOR_PROMOTE_AFTER_FIRST=1
  )
  if [ "${ANCHOR_DEBUG:-}" = "1" ]; then
    env_args+=(ANCHOR_DEBUG=1)
  fi

  echo "starting deepseek-anchor-gateway ..."
  echo "  upstream: ${ANCHOR_UPSTREAM_URL:-$DEFAULT_UPSTREAM}"
  echo "  port:     ${ANCHOR_PORT:-$DEFAULT_PORT}"
  echo "  mode:     promote-after-first"
  echo "  log:      ${LOGFILE}"

  env "${env_args[@]}" node "$SERVER" >>"$LOGFILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  echo "started (pid ${pid})"
}

cmd_stop() {
  if ! is_running; then
    echo "not running"
    return 0
  fi
  local pid="$(cat "$PIDFILE")"
  kill "$pid" 2>/dev/null || true
  # 等它退出
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.2
  done
  rm -f "$PIDFILE"
  echo "stopped (pid ${pid})"
}

cmd_status() {
  if is_running; then
    echo "running (pid $(cat "$PIDFILE"))"
    echo "  log: ${LOGFILE}"
  else
    echo "stopped"
  fi
}

cmd_restart() {
  cmd_stop
  sleep 0.3
  cmd_start
}

# ── 分发 ────────────────────────────────────────────────────────────────────
case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  *)       echo "usage: $0 [start|stop|restart|status]" >&2; exit 2 ;;
esac
