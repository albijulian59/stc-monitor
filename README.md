# STC Monitor — Tahap 1 (Mode simulasi)

PWA monitoring pompa & panel untuk PT Surya Tirta Cemerlang. Tanpa build step: HTML/CSS/JS biasa.
**Semua data saat ini SIMULASI** — bukan dari pompa asli.

## File
- `index.html`, `style.css`, `app.js` — tampilan, mesin alarm, pengaturan batas (localStorage)
- `datasource.js` — lapisan data. Sekarang simulator; nanti diganti backend asli dengan antarmuka yang sama
- `manifest.json`, `sw.js`, `icon-*.png` — supaya bisa "Tambahkan ke Layar Utama"

## Antarmuka `dataSource` (wajib sama untuk backend asli)
```
dataSource.mode                 'simulasi' | 'live'
dataSource.start({getThresholds})
dataSource.getPumps()           -> [{id, name, type}]
dataSource.getLatest(id)        -> reading
dataSource.getHistory(id)       -> [reading] (~10 menit)
dataSource.onData(cb)           -> cb(reading) setiap update
dataSource.simulateFault(id?, type?)   (hanya simulasi)
```
Reading: `{pumpId, ts, running, trip, dryRun, pressure, currentR, currentS, currentT, voltage, motorTemp, runHours}`

## Rencana tahap berikut (data asli dari PLC)
PLC di panel → modem 4G (gateway Modbus RTU/TCP → MQTT/HTTPS) → server → aplikasi ini.

- **MQTT** (disarankan): topik `stc/{customerId}/{pumpId}/telemetry` (JSON reading di atas, tiap 2–5 detik),
  `stc/{customerId}/{pumpId}/alarm` (event dari PLC). Aplikasi berlangganan via MQTT over WebSocket (wss).
- **HTTP** alternatif: `POST /api/telemetry` dari gateway, aplikasi baca `GET /api/pumps/{id}/latest` & `/history?min=10`.
- Push notifikasi saat aplikasi tertutup butuh server (Web Push / FCM) — belum ada di tahap 1.

Contoh pemetaan register Modbus (holding register, sesuaikan dengan program PLC):

| Register | Field | Skala |
|---|---|---|
| 40001 | status bit: b0 running, b1 trip, b2 dryRun (level switch), b3 phase fail relay | bit |
| 40002 | pressure | ×0.01 bar (transmitter 4–20 mA) |
| 40003–40005 | currentR / S / T | ×0.1 A (CT / power meter) |
| 40006 | voltage | ×1 V (power meter) |
| 40007 | motorTemp | ×0.1 °C (PT100/PTC) |
| 40008–40009 | runHours | 32-bit, ×0.1 jam |

Batas alarm (tekanan, arus, tegangan, suhu) saat ini dicek di aplikasi; nantinya sebaiknya juga dicek di server agar notifikasi tetap terkirim walau aplikasi tertutup.
