# STC Monitor — Tahap 2 (data via MQTT + push ntfy)

PWA monitoring pompa & panel untuk PT Surya Tirta Cemerlang. Tanpa build step: HTML/CSS/JS biasa.
Aplikasi memakai data perangkat via MQTT jika ada; jika belum ada data, otomatis memakai simulasi di browser.
Indikator di atas layar: ✅ *Terhubung ke perangkat* / ⚠️ *Mode simulasi* / ❌ *Perangkat tidak mengirim data*.

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

## Tahap 2: jalur data (gratis, tanpa akun)
```
PLC --Modbus RTU/TCP--> Teltonika RUT241 --MQTT--> broker publik --wss--> aplikasi (HP)
                                       \--HTTPS POST--> ntfy.sh --> aplikasi ntfy di HP (push walau app tertutup)
                                       \--SMS (fitur bawaan RUT241) --> cadangan
```
- **Broker uji**: `public.cloud.shiftr.io` (user `public`, password `public`).
  Aplikasi: `wss://public.cloud.shiftr.io` (port 443). RUT241: `public.cloud.shiftr.io` port 1883 (TCP) atau 8883 (TLS).
  Dipilih karena port 443 jalan dari semua jaringan (HiveMQ 8884 / Mosquitto 8081 diblokir di sebagian jaringan).
  Bisa diganti di Pengaturan → Sumber data → Pengaturan lanjutan.
- **Topik awal** (sulit ditebak): `stc-monitor/8a50f39eb100`

| Topik | Arah | Isi |
|---|---|---|
| `stc-monitor/8a50f39eb100/{pumpId}/telemetry` | perangkat → app | JSON reading (retain), tiap 2–10 detik |
| `stc-monitor/8a50f39eb100/{pumpId}/alarm` | perangkat → app | `{"pumpId","type","state":"active"/"cleared","value","ts"}` |
| `stc-monitor/8a50f39eb100/status` | perangkat | `online` / `offline` (retain, LWT) |
| `stc-monitor/8a50f39eb100/cmd/simulate` | app → simulator | uji gangguan (diabaikan RUT241 asli) |

`pumpId`: `bp1` (Booster Pump 1), `bp2` (Booster Pump 2), `fp1` (Fire Pump).

Contoh payload telemetry (satu pesan JSON per pompa):
```json
{"ts":1793357597,"running":1,"trip":0,"dryRun":0,"pressure":4.3,"currentR":17.5,"currentS":18,
 "currentT":17.6,"voltage":383,"motorTemp":52.5,"runHours":1347.5}
```
Aturan: `ts` boleh detik atau ms (boleh dihilangkan → pakai waktu terima). Boolean boleh `0/1`, `true/false`.
Angka boleh string. Alternatif: kirim `"status"` = nilai register 40001 (bit0 running, bit1 trip, bit2 dryRun).
Nilai harus sudah diskala (bar, A, V, °C, jam) — atur skala di PLC atau di format RUT241.

### Setting RUT241 (untuk teknisi, cek ulang di firmware RUT2M terbaru)
1. *Services → Modbus → Modbus Serial Master* (RTU) atau *Modbus TCP Client*: tambahkan PLC, buat request register 40001–40009 per pompa.
2. *Services → Data to Server*: Type **Modbus**, Protocol **MQTT**, server `public.cloud.shiftr.io:1883`, user/password `public`,
   topic `stc-monitor/8a50f39eb100/bp1/telemetry` (satu instance per pompa), format **Custom** JSON dengan nama field di atas, period 5 s.
3. Alarm: *Services → Modbus → Alarms* (atau Events Reporting) bisa kirim **SMS** langsung ke nomor HP (cadangan tanpa internet)
   dan/atau HTTP POST ke ntfy (lihat di bawah).

### Push notifikasi (ntfy.sh, gratis tanpa akun)
Topik: **`stc-alarm-0a25f56fa0fa`** → https://ntfy.sh/stc-alarm-0a25f56fa0fa
```
curl -H "Title: ALARM Booster Pump 1: Tekanan rendah" -H "Priority: urgent" -H "Tags: rotating_light" \
     -d "1.2 bar - segera periksa panel" https://ntfy.sh/stc-alarm-0a25f56fa0fa
```
Yang mendeteksi alarm & mengirim ntfy adalah sisi perangkat/gateway (sekarang: simulator), bukan aplikasi.

### Simulator perangkat (pura-pura PLC + RUT241) — folder `simulator/`
```
cd /workspace/stc-monitor/simulator
./start.sh        # jalan di latar belakang (nohup), PID di sim.pid
./stop.sh         # hentikan
tail -f sim.log   # lihat log
```
Kirim data tiap 5 detik, gangguan acak rata-rata tiap 45 menit (`FAULT_EVERY_MIN`), dan menerima perintah uji dari
tombol "Simulasi alarm" di aplikasi saat terhubung. Alarm → MQTT `.../alarm` + push ntfy (prioritas urgent).

### Batasan
- Broker & ntfy publik: **siapa pun yang tahu topik bisa membaca/mengirim**. Hanya untuk uji coba. Untuk produk: broker
  dengan username/password sendiri (mis. HiveMQ Cloud / EMQX Serverless free tier) dan topik ntfy unik per pembeli.
- Batas alarm di Pengaturan aplikasi hanya berlaku di HP tsb; push ntfy memakai batas default di sisi perangkat.

## Catatan awal (tahap 1)
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
