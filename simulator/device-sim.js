/* STC Monitor — simulator perangkat (pura-pura PLC + Teltonika RUT241)
 * Mengirim data pompa ke broker MQTT (format sama seperti RUT241 nanti),
 * mendeteksi alarm seperti "server/gateway" dan mengirim push ke ntfy.sh.
 * Jalankan: ./start.sh   Hentikan: ./stop.sh   Log: sim.log
 */
const mqtt = require('mqtt');
const CFG = {
  url: process.env.MQTT_URL || 'wss://public.cloud.shiftr.io',
  username: process.env.MQTT_USER || 'public', password: process.env.MQTT_PASS || 'public',
  prefix: process.env.PREFIX || 'stc-monitor/8a50f39eb100',
  ntfy: process.env.NTFY_TOPIC || 'stc-alarm-0a25f56fa0fa',
  appUrl: 'https://albijulian59.github.io/stc-monitor/#/alarm',
  intervalMs: +process.env.INTERVAL_MS || 5000,
  faultEveryMin: +process.env.FAULT_EVERY_MIN || 45,   // rata-rata 1 gangguan acak tiap N menit
};
const PUMPS = [
  { id: 'bp1', name: 'Booster Pump 1', type: 'booster', p: 4.5, a: 18 },
  { id: 'bp2', name: 'Booster Pump 2', type: 'booster', p: 4.5, a: 18 },
  { id: 'fp1', name: 'Fire Pump', type: 'fire', p: 8.0, a: 62 },
];
const THR = {
  booster: { pressureLow: 2.0, pressureHigh: 7.0, currentMax: 22, voltageMin: 342, voltageMax: 418, tempMax: 85 },
  fire: { pressureLow: 5.0, pressureHigh: 11.0, currentMax: 75, voltageMin: 342, voltageMax: 418, tempMax: 90 },
};
const ALARM = { trip: 'Pompa trip', overcurrent: 'Arus berlebih', phase: 'Phase loss / tegangan tidak normal',
  lowPressure: 'Tekanan rendah', highPressure: 'Tekanan tinggi', dryRun: 'Dry run (pompa jalan kering)', highTemp: 'Suhu motor tinggi' };
const FAULTS = Object.keys(ALARM);
const rnd = (a, b) => a + Math.random() * (b - a), r1 = v => Math.round(v * 10) / 10;
const log = (...a) => console.log(new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }), ...a);
const wib = () => new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }) + ' WIB';

const st = {}, active = {};
PUMPS.forEach(p => st[p.id] = { running: p.type === 'booster', runHours: p.type === 'fire' ? rnd(40, 90) : rnd(1200, 4800), temp: p.type === 'fire' ? 31 : 52, fault: null, until: 0 });

function startFault(id, type) {
  const p = PUMPS.find(x => x.id === id) || PUMPS[Math.floor(Math.random() * PUMPS.length)], s = st[p.id];
  type = FAULTS.includes(type) ? type : FAULTS[Math.floor(Math.random() * FAULTS.length)];
  if (type !== 'highPressure') s.running = true;
  s.fault = type; s.until = Date.now() + rnd(30000, 60000);
  log('GANGGUAN dibuat:', p.name, type);
}

function reading(p) {
  const s = st[p.id], t = THR[p.type], now = Date.now();
  if (s.fault && now > s.until) { s.fault = null; if (p.type === 'fire') s.running = false; }
  if (p.id === 'bp2' && !s.fault && Math.random() < 0.01) s.running = !s.running;
  const f = s.fault; let running = s.running, trip = false, dryRun = false;
  let pressure = running ? p.p + rnd(-.25, .25) : (p.type === 'fire' ? 7 + rnd(-.1, .1) : 3.2 + rnd(-.1, .1));
  const base = running ? p.a : 0;
  let cR = base ? base + rnd(-.6, .6) : 0, cS = base ? base + rnd(-.6, .6) : 0, cT = base ? base + rnd(-.6, .6) : 0;
  let voltage = 380 + rnd(-5, 5), tT = running ? (p.type === 'fire' ? 60 : 55) : 32;
  if (f === 'trip') { running = false; trip = true; cR = cS = cT = 0; pressure = 1.2 + rnd(-.2, .2); }
  if (f === 'overcurrent') { cR *= 1.35; cS *= 1.35; cT *= 1.35; }
  if (f === 'phase') { cT = 0; voltage = 327; }
  if (f === 'lowPressure') pressure = t.pressureLow * .6;
  if (f === 'highPressure') pressure = t.pressureHigh * 1.12;
  if (f === 'dryRun') { dryRun = true; cR *= .45; cS *= .45; cT *= .45; pressure = .4; }
  if (f === 'highTemp') tT = t.tempMax + 12;
  s.temp += (tT - s.temp) * (f === 'highTemp' ? .5 : .1) + rnd(-.2, .2);
  if (running) s.runHours += CFG.intervalMs / 3600000;
  return { ts: Math.floor(now / 1000), running: running ? 1 : 0, trip: trip ? 1 : 0, dryRun: dryRun ? 1 : 0,
    pressure: r1(Math.max(0, pressure)), currentR: r1(cR), currentS: r1(cS), currentT: r1(cT),
    voltage: Math.round(voltage), motorTemp: r1(s.temp), runHours: r1(s.runHours) };
}

// Deteksi alarm di sisi perangkat/server (logika sama dengan aplikasi)
function check(p, r) {
  const t = THR[p.type], I = [r.currentR, r.currentS, r.currentT];
  const cond = {
    trip: !!r.trip, overcurrent: !!r.running && Math.max(...I) > t.currentMax,
    phase: (!!r.running && Math.min(...I) < .5 && Math.max(...I) > 1) || r.voltage < t.voltageMin || r.voltage > t.voltageMax,
    lowPressure: !!r.running && !r.dryRun && r.pressure < t.pressureLow, highPressure: r.pressure > t.pressureHigh,
    dryRun: !!r.dryRun, highTemp: r.motorTemp > t.tempMax,
  };
  const val = { trip: 'Status trip dari panel', overcurrent: `Arus ${Math.max(...I)} A`, phase: `R/S/T ${I.join('/')} A, ${r.voltage} V`,
    lowPressure: `${r.pressure} bar`, highPressure: `${r.pressure} bar`, dryRun: 'Sensor level: air tidak ada', highTemp: `${r.motorTemp} °C` };
  for (const k in cond) {
    const key = p.id + '|' + k;
    if (cond[k] && !active[key]) {
      active[key] = Date.now();
      const ev = { pumpId: p.id, type: k, state: 'active', value: val[k], ts: r.ts };
      client.publish(`${CFG.prefix}/${p.id}/alarm`, JSON.stringify(ev));
      ntfy(`🚨 ALARM ${p.name}: ${ALARM[k]}`, `${val[k]}\nWaktu: ${wib()}\nSegera periksa panel pompa.`, 5, ['rotating_light']);
    } else if (!cond[k] && active[key]) {
      delete active[key];
      client.publish(`${CFG.prefix}/${p.id}/alarm`, JSON.stringify({ pumpId: p.id, type: k, state: 'cleared', ts: r.ts }));
      ntfy(`✅ Normal kembali: ${p.name}`, `${ALARM[k]} sudah normal.\nWaktu: ${wib()}`, 3, ['white_check_mark']);
    }
  }
}

async function ntfy(title, message, priority, tags) {
  try {
    const res = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: CFG.ntfy, title, message, priority, tags, click: CFG.appUrl }) });
    log('ntfy', res.status, title);
  } catch (e) { log('ntfy GAGAL', e.message); }
}

const client = mqtt.connect(CFG.url, { username: CFG.username, password: CFG.password,
  clientId: 'stc-sim-' + Math.random().toString(16).slice(2, 8), reconnectPeriod: 5000,
  will: { topic: CFG.prefix + '/status', payload: 'offline', retain: true, qos: 1 } });
client.on('connect', () => {
  log('Terhubung ke broker', CFG.url, 'prefix', CFG.prefix);
  client.publish(CFG.prefix + '/status', 'online', { retain: true, qos: 1 });
  client.subscribe(CFG.prefix + '/cmd/simulate');
});
client.on('message', (topic, msg) => {
  let j = {}; try { j = JSON.parse(msg.toString()); } catch (e) {}
  log('Perintah uji dari aplikasi:', msg.toString()); startFault(j.pumpId, j.type);
});
client.on('error', e => log('MQTT error', e.message));
client.on('offline', () => log('MQTT offline, mencoba lagi...'));

setInterval(() => {
  if (!client.connected) return;
  const chance = CFG.intervalMs / (CFG.faultEveryMin * 60000);
  PUMPS.forEach(p => {
    if (!st[p.id].fault && Math.random() < chance / PUMPS.length) startFault(p.id);
    const r = reading(p);
    client.publish(`${CFG.prefix}/${p.id}/telemetry`, JSON.stringify(r), { retain: true });
    check(p, r);
  });
}, CFG.intervalMs);
process.on('SIGTERM', () => { client.publish(CFG.prefix + '/status', 'offline', { retain: true }, () => process.exit(0)); setTimeout(() => process.exit(0), 2000); });
