'use strict';

// Publishes Home Assistant MQTT-discovery entities for every configured
// zone (number = volume, switch = mute, select = input source) plus one
// binary_sensor for "is the server actually connected to the ZonePRO unit".
// Runs entirely alongside the existing web UI -- both drive the exact same
// setVolume/setMute/setInput functions and the same state.json, so either
// one can be used interchangeably and they always stay in sync.

const mqtt = require('mqtt');

let client = null;
let cfg = null;
let handlers = null;
let discoveryPrefix = 'homeassistant';
let baseTopic = 'zonepro';

function zoneInputs(zone) {
  const list = (zone && zone.inputs) || cfg.inputs || [];
  return list;
}

function configuredZones() {
  return cfg.zones.filter((z) => !!z.object);
}

function deviceFor(zone) {
  return {
    identifiers: [`zonepro_zone${zone.id}`],
    name: zone.name,
    manufacturer: 'dbx',
    model: 'ZonePRO zone',
    via_device: 'zonepro_bridge',
  };
}

function availability() {
  return [
    { topic: `${baseTopic}/bridge/status` },
    { topic: `${baseTopic}/link`, payload_available: 'online', payload_not_available: 'offline' },
  ];
}

function topic(zoneId, feature, suffix) {
  return `${baseTopic}/zone${zoneId}/${feature}/${suffix}`;
}

function publish(t, payload) {
  if (!client) return;
  client.publish(t, payload, { retain: true });
}

function publishDiscoveryForZone(zone) {
  const device = deviceFor(zone);
  const avail = availability();

  publish(`${discoveryPrefix}/number/zonepro_zone${zone.id}_volume/config`, JSON.stringify({
    name: 'Volume',
    unique_id: `zonepro_zone${zone.id}_volume`,
    object_id: `zonepro_zone${zone.id}_volume`,
    device,
    availability: avail,
    availability_mode: 'all',
    command_topic: topic(zone.id, 'volume', 'set'),
    state_topic: topic(zone.id, 'volume', 'state'),
    min: cfg.protocol.volumeMinDb,
    max: cfg.protocol.volumeMaxDb,
    step: cfg.protocol.volumeStepDb,
    unit_of_measurement: 'dB',
    mode: 'slider',
  }));

  publish(`${discoveryPrefix}/switch/zonepro_zone${zone.id}_mute/config`, JSON.stringify({
    name: 'Mute',
    unique_id: `zonepro_zone${zone.id}_mute`,
    object_id: `zonepro_zone${zone.id}_mute`,
    device,
    availability: avail,
    availability_mode: 'all',
    command_topic: topic(zone.id, 'mute', 'set'),
    state_topic: topic(zone.id, 'mute', 'state'),
    payload_on: 'ON',
    payload_off: 'OFF',
    icon: 'mdi:volume-mute',
  }));

  const inputs = zoneInputs(zone);
  if (inputs.length) {
    publish(`${discoveryPrefix}/select/zonepro_zone${zone.id}_input/config`, JSON.stringify({
      name: 'Source',
      unique_id: `zonepro_zone${zone.id}_input`,
      object_id: `zonepro_zone${zone.id}_input`,
      device,
      availability: avail,
      availability_mode: 'all',
      command_topic: topic(zone.id, 'input', 'set'),
      state_topic: topic(zone.id, 'input', 'state'),
      options: inputs.map((i) => i.name),
      icon: 'mdi:import',
    }));
  } else {
    // No inputs configured for this zone (any more) -- remove a
    // previously-published select entity by publishing an empty config.
    publish(`${discoveryPrefix}/select/zonepro_zone${zone.id}_input/config`, '');
  }
}

function publishBridgeBinarySensor() {
  publish(`${discoveryPrefix}/binary_sensor/zonepro_bridge_link/config`, JSON.stringify({
    name: 'ZonePRO Link',
    unique_id: 'zonepro_bridge_link',
    object_id: 'zonepro_bridge_link',
    device: {
      identifiers: ['zonepro_bridge'],
      name: 'ZonePRO Control',
      manufacturer: 'dbx',
      model: 'ZonePRO',
    },
    availability: [{ topic: `${baseTopic}/bridge/status` }],
    state_topic: `${baseTopic}/link`,
    payload_on: 'online',
    payload_off: 'offline',
    device_class: 'connectivity',
  }));
}

function publishAllDiscovery() {
  publishBridgeBinarySensor();
  for (const zone of configuredZones()) publishDiscoveryForZone(zone);
}

function publishZoneState(zoneId) {
  if (!client) return;
  const zone = handlers.zoneById(zoneId);
  if (!zone) return;
  const zs = handlers.getState().zones[zoneId];
  if (!zs) return;

  publish(topic(zoneId, 'volume', 'state'), String(zs.volumeDb));
  publish(topic(zoneId, 'mute', 'state'), zs.muted ? 'ON' : 'OFF');

  const inputs = zoneInputs(zone);
  const match = inputs.find((i) => Number(i.value) === Number(zs.input));
  if (match) publish(topic(zoneId, 'input', 'state'), match.name);
}

function publishAllZoneStates() {
  for (const zone of configuredZones()) publishZoneState(zone.id);
}

function publishLink(connected) {
  publish(`${baseTopic}/link`, connected ? 'online' : 'offline');
}

function handleCommand(t, payloadBuf) {
  const parts = t.split('/'); // [baseTopic, "zoneN", feature, "set"]
  if (parts.length !== 4 || parts[0] !== baseTopic || parts[3] !== 'set') return;

  const zoneId = parts[1].replace(/^zone/, '');
  const feature = parts[2];
  const zone = handlers.zoneById(zoneId);
  if (!zone) return;

  const payload = payloadBuf.toString();
  let ok = false;

  if (feature === 'volume') {
    const db = parseFloat(payload);
    if (!Number.isNaN(db)) ok = handlers.setVolume(zoneId, db);
  } else if (feature === 'mute') {
    ok = handlers.setMute(zoneId, payload === 'ON');
  } else if (feature === 'input') {
    const match = zoneInputs(zone).find((i) => i.name === payload);
    if (match) ok = handlers.setInput(zoneId, match.value);
  }

  if (ok) handlers.onChanged(zoneId);
}

function disconnect() {
  if (client) {
    try {
      client.end(true);
    } catch (err) {
      // ignore
    }
    client = null;
  }
}

// (Re)connects using the current config. Safe to call repeatedly, e.g.
// after a save from the /config editor -- it tears down any previous
// connection first.
function init(appConfig, appHandlers) {
  cfg = appConfig;
  handlers = appHandlers || handlers;
  disconnect();

  if (!cfg.mqtt || !cfg.mqtt.enabled) return;
  if (!cfg.mqtt.host) {
    console.error('[mqtt] enabled but no host configured, skipping');
    return;
  }

  discoveryPrefix = cfg.mqtt.discoveryPrefix || 'homeassistant';
  baseTopic = cfg.mqtt.baseTopic || 'zonepro';

  const url = `mqtt://${cfg.mqtt.host}:${cfg.mqtt.port || 1883}`;
  client = mqtt.connect(url, {
    username: cfg.mqtt.username || undefined,
    password: cfg.mqtt.password || undefined,
    will: { topic: `${baseTopic}/bridge/status`, payload: 'offline', retain: true },
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    console.log(`[mqtt] connected to ${cfg.mqtt.host}:${cfg.mqtt.port || 1883}`);
    publish(`${baseTopic}/bridge/status`, 'online');
    publishAllDiscovery();
    publishLink(handlers.isZoneProConnected());
    publishAllZoneStates();
    client.subscribe(`${baseTopic}/+/+/set`);
  });

  client.on('message', handleCommand);
  client.on('error', (err) => console.error('[mqtt] error:', err.message));
}

function refresh(appConfig) {
  init(appConfig);
}

module.exports = { init, refresh, publishZoneState, publishLink };
