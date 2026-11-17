#!/bin/bash
# 最小闸门：纪律 0.1 —— 绿灯的定义是退出码。日志落盘，先看退出码再看内容。
# 变量一律 ${} 包裹：紧跟中文全角字符时裸 $var 会被 bash 拼进变量名（本脚本因此事故过一次）。
set -u
cd "$(dirname "$0")/.."
LOG=/tmp/ordin-gate.log
npm run check > "$LOG" 2>&1
code=$?
echo "退出码: ${code}（日志: ${LOG}）"
if [ "${code}" -ne 0 ]; then tail -40 "$LOG"; fi
exit "${code}"
