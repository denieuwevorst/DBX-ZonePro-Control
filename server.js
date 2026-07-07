'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const mqttBridge = require('./mqtt-bridge');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state.json');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const MAX_BACKUPS = 30;
const PORT = 3001;

fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

let config = loadConfig();

function hex(v) {
  return typeof v === 'string' ? parseInt(v, 16) : v;
}

// ---------------------------------------------------------------------------
// State (persisted to disk so a page load always shows the last known state,
// since the ZonePRO gives us no feedback of its own)
// ---------------------------------------------------------------------------

function defaultInputFor(zone) {
  const list = (zone && zone.inputs) || config.inputs || [];
  return list.length ? list[0].value : 0;
}

function defaultState() {
  const zones = {};
  for (const z of config.zones) {
    zones[z.id] = { volumeDb: 0, muted: false, input: defaultInputFor(z) };
  }
  return { zones };
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Make sure every configured zone has a state entry (with every field,
    // e.g. "input" didn't exist in older state.json files), even if the
    // config file gained zones since state.json was last written.
    const merged = defaultState();
    for (const id of Object.keys(parsed.zones || {})) {
      if (merged.zones[id]) merged.zones[id] = { ...merged.zones[id], ...parsed.zones[id] };
    }
    return merged;
  } catch (err) {
    return defaultState();
  }
}

let state = loadState();
let saveTimer = null;

// Called after a live config reload (via the /config editor) so zones that
// already existed keep their current volume/mute/input, new zones get
// sensible defaults, and removed zones are dropped.
function reconcileStateWithConfig() {
  const fresh = defaultState();
  for (const id of Object.keys(fresh.zones)) {
    if (state.zones[id]) fresh.zones[id] = { ...fresh.zones[id], ...state.zones[id] };
  }
  state = fresh;
  persistState();
}

function persistState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), (err) => {
      if (err) console.error('[state] failed to save state.json:', err.message);
    });
  }, 150); // small debounce so a slider drag doesn't hammer the disk
}

// ---------------------------------------------------------------------------
// ZonePRO TCP connection + packet building
// (see "1-way control of ZonePRO products with RS-232", Appendix: IP
//  Connections -- the IP payload is the same as RS-232 minus FS/FC/checksum)
// ---------------------------------------------------------------------------

let socket = null;
let connected = false;
let reconnectTimer = null;

function connectZonePro() {
  clearTimeout(reconnectTimer);
  socket = new net.Socket();

  socket.connect(config.zonepro.port, config.zonepro.ip, () => {
    connected = true;
    console.log(`[zonepro] connected to ${config.zonepro.ip}:${config.zonepro.port}`);
    broadcastStatus();
  });

  socket.on('error', (err) => {
    console.error('[zonepro] socket error:', err.message);
  });

  socket.on('close', () => {
    if (connected) console.log('[zonepro] connection closed, retrying in 5s');
    connected = false;
    broadcastStatus();
    reconnectTimer = setTimeout(connectZonePro, 5000);
  });
}

// Builds one MultiSVSet (0x0100) message for a single state variable.
// dataType: 1 = UBYTE (1 byte value), 3 = UWORD (2 byte value)
function buildMultiSVSet({ destObject, svId, dataType, value }) {
  const srcDevice = hex(config.protocol.srcDevice);
  const destDevice = hex(config.protocol.destDevice);

  const valueBuf = Buffer.alloc(dataType === 3 ? 2 : 1);
  if (dataType === 3) valueBuf.writeUInt16BE(value, 0);
  else valueBuf.writeUInt8(value, 0);

  const payload = Buffer.concat([
    u16(1),                // NumSVs
    u16(svId),             // SV_ID
    Buffer.from([dataType]), // Data type
    valueBuf,               // SV_Val
  ]);

  // Version, Length, Src[Device:Object], Dest[Device:Object], MsgID, Flags, Payload
  const version = Buffer.from([0x01]);
  // The SRC object field mirrors the DEST object field (the object being
  // controlled) -- confirmed against real captured ZonePRO strings, e.g.
  // ...,00,33,01,05,00,18, 00,23,01,05,00,18,... (same object twice).
  const src = Buffer.concat([u16(srcDevice), u32(destObject)]);
  const dest = Buffer.concat([u16(destDevice), u32(destObject)]);
  const msgId = u16(0x0100);
  const flags = u16(0x0000);

  const bodyWithoutLength = Buffer.concat([src, dest, msgId, flags, payload]);
  const length = 1 + 4 + bodyWithoutLength.length; // version + length field + rest

  const packet = Buffer.concat([version, u32(length), bodyWithoutLength]);
  return packet;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function sendPacket(buf) {
  if (!connected || !socket) {
    console.warn('[zonepro] not connected, dropping command');
    return false;
  }
  socket.write(buf);
  return true;
}

function dbToRaw(db) {
  const min = config.protocol.volumeMinDb;
  const max = config.protocol.volumeMaxDb;
  const clamped = Math.max(min, Math.min(max, db));
  return Math.round((clamped + 90) * 2) + 1; // see README: 0.5dB steps, -90dB=1 .. +20dB=221
}

function zoneById(id) {
  return config.zones.find((z) => String(z.id) === String(id));
}

function setVolume(zoneId, db) {
  const zone = zoneById(zoneId);
  if (!zone || !zone.object) return false;
  const raw = dbToRaw(db);
  const packet = buildMultiSVSet({
    destObject: hex(zone.object),
    svId: hex(config.protocol.volumeSvId),
    dataType: 3,
    value: raw,
  });
  const ok = sendPacket(packet);
  if (ok) {
    state.zones[zoneId].volumeDb = db;
    persistState();
  }
  return ok;
}

function setMute(zoneId, muted) {
  const zone = zoneById(zoneId);
  if (!zone || !zone.object) return false;
  const packet = buildMultiSVSet({
    destObject: hex(zone.object),
    svId: hex(config.protocol.muteSvId),
    dataType: 1,
    value: muted ? 1 : 0,
  });
  const ok = sendPacket(packet);
  if (ok) {
    state.zones[zoneId].muted = muted;
    persistState();
  }
  return ok;
}

function setInput(zoneId, value) {
  const zone = zoneById(zoneId);
  if (!zone || !zone.object) return false;
  const packet = buildMultiSVSet({
    destObject: hex(zone.object),
    svId: hex(config.protocol.inputSvId),
    dataType: 1,
    value: Number(value),
  });
  const ok = sendPacket(packet);
  if (ok) {
    state.zones[zoneId].input = Number(value);
    persistState();
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Web server + WebSocket sync
// ---------------------------------------------------------------------------

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function publicConfig() {
  return {
    zones: config.zones
      .filter((z) => !!z.object)
      .map((z) => ({ id: z.id, name: z.name, inputs: z.inputs || config.inputs || [] })),
    volumeMinDb: config.protocol.volumeMinDb,
    volumeMaxDb: config.protocol.volumeMaxDb,
    volumeStepDb: config.protocol.volumeStepDb,
  };
}

app.get('/api/config', (req, res) => {
  res.json(publicConfig());
});

app.get('/api/state', (req, res) => {
  res.json({ state, connected });
});

// /zone1, /zone2, ... serve the same single-page app; app.js reads the
// path and shows just that one zone. Falls through to index.html for any
// zone number -- app.js decides whether it's actually configured.
app.get(/^\/zone\d+\/?$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// /config -- the settings editor page.
app.get('/config', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'config.html'));
});

// --- raw config.json editor API (used by /config) -------------------------

function validateConfigShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'Config must be a JSON object.';
  if (!parsed.zonepro || !parsed.zonepro.ip || !parsed.zonepro.port) {
    return 'Missing "zonepro.ip" / "zonepro.port".';
  }
  if (!parsed.protocol || !parsed.protocol.destDevice || !parsed.protocol.srcDevice) {
    return 'Missing required "protocol" fields (srcDevice/destDevice).';
  }
  if (!Array.isArray(parsed.zones) || parsed.zones.length === 0) {
    return '"zones" must be a non-empty array.';
  }
  for (const z of parsed.zones) {
    if (z.id === undefined || z.id === null) return 'Every zone needs an "id".';
    if (!z.name) return `Zone ${z.id} is missing a "name".`;
  }
  if (parsed.mqtt && parsed.mqtt.enabled && !parsed.mqtt.host) {
    return '"mqtt.enabled" is true but "mqtt.host" is empty.';
  }
  return null;
}

function pruneBackups() {
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();
  for (const f of files.slice(MAX_BACKUPS)) {
    fs.unlinkSync(path.join(BACKUPS_DIR, f));
  }
}

function backupFilename() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `config-${ts}.json`;
}

app.get('/api/config/raw', (req, res) => {
  res.type('text/plain').send(fs.readFileSync(CONFIG_PATH, 'utf8'));
});

app.get('/api/config/backups', (req, res) => {
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, f));
      return { file: f, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});

app.get('/api/config/backups/:file', (req, res) => {
  const safeName = path.basename(req.params.file);
  const filePath = path.join(BACKUPS_DIR, safeName);
  if (!filePath.startsWith(BACKUPS_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup not found.' });
  }
  res.type('text/plain').send(fs.readFileSync(filePath, 'utf8'));
});

app.post('/api/config/raw', (req, res) => {
  const raw = req.body && req.body.raw;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({ error: 'No config text received.' });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return res.status(400).json({ error: `Invalid JSON: ${err.message}` });
  }

  const shapeError = validateConfigShape(parsed);
  if (shapeError) {
    return res.status(400).json({ error: shapeError });
  }

  const previousIp = config.zonepro.ip;
  const previousPort = config.zonepro.port;

  try {
    // Back up the config as it currently is on disk before overwriting it.
    fs.copyFileSync(CONFIG_PATH, path.join(BACKUPS_DIR, backupFilename()));
    pruneBackups();
    fs.writeFileSync(CONFIG_PATH, raw);
  } catch (err) {
    return res.status(500).json({ error: `Failed to save: ${err.message}` });
  }

  config = parsed;
  reconcileStateWithConfig();

  if (parsed.zonepro.ip !== previousIp || parsed.zonepro.port !== previousPort) {
    console.log('[zonepro] address changed, reconnecting...');
    clearTimeout(reconnectTimer);
    if (socket) socket.destroy();
    connectZonePro();
  }

  broadcast({ type: 'config', config: publicConfig() });
  broadcast({ type: 'state', state, connected });
  mqttBridge.refresh(config);

  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

// Called after any successful volume/mute/input change, regardless of
// whether it came from the web UI (WebSocket) or Home Assistant (MQTT), so
// both stay in sync no matter which one triggered the change.
function notifyChanged(zoneId) {
  broadcast({ type: 'state', state, connected });
  mqttBridge.publishZoneState(zoneId);
}

function broadcastStatus() {
  broadcast({ type: 'status', connected });
  mqttBridge.publishLink(connected);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', state, connected }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'volume' && zoneById(msg.zone)) {
      const ok = setVolume(msg.zone, Number(msg.db));
      if (ok) notifyChanged(msg.zone);
    } else if (msg.type === 'mute' && zoneById(msg.zone)) {
      const ok = setMute(msg.zone, !!msg.muted);
      if (ok) notifyChanged(msg.zone);
    } else if (msg.type === 'input' && zoneById(msg.zone)) {
      const ok = setInput(msg.zone, msg.value);
      if (ok) notifyChanged(msg.zone);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[web] ZonePRO control panel running at http://localhost:${PORT}`);
});

connectZonePro();

mqttBridge.init(config, {
  setVolume,
  setMute,
  setInput,
  zoneById,
  getState: () => state,
  isZoneProConnected: () => connected,
  onChanged: notifyChanged,
});
