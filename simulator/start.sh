#!/bin/bash
# Menjalankan simulator perangkat di latar belakang
cd "$(dirname "$0")"
if [ -f sim.pid ] && kill -0 "$(cat sim.pid)" 2>/dev/null; then echo "Simulator sudah jalan (PID $(cat sim.pid))"; exit 0; fi
[ -d node_modules ] || npm install --silent
nohup node device-sim.js >> sim.log 2>&1 &
echo $! > sim.pid
echo "Simulator jalan (PID $(cat sim.pid)). Log: $(pwd)/sim.log"
