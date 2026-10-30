#!/bin/bash
# Menghentikan simulator perangkat
cd "$(dirname "$0")"
if [ -f sim.pid ] && kill "$(cat sim.pid)" 2>/dev/null; then echo "Simulator dihentikan (PID $(cat sim.pid))"; else echo "Simulator tidak sedang jalan"; fi
rm -f sim.pid
