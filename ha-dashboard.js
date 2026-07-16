'use strict';

// Builds a full Home Assistant Lovelace dashboard (as a YAML string) from
// the current config.json -- one view with a volume/mute/source tile-stack
// per zone, and a second view with a grid of "tap to select this source"
// buttons per zone. Regenerated fresh on every request, so it always
// matches whatever is currently in config.json / the /config editor.

const yaml = require('js-yaml');

function zoneInputs(zone, cfg) {
  return (zone && zone.inputs) || cfg.inputs || [];
}

function zoneCards(zone, cfg) {
  const cards = [
    {
      type: 'tile',
      entity: `number.zonepro_zone${zone.id}_volume`,
      name: zone.name,
      icon: 'mdi:volume-high',
      color: 'light-blue',
      features_position: 'inline',
      features: [{ type: 'numeric-input', style: 'slider' }],
    },
    {
      type: 'tile',
      entity: `switch.zonepro_zone${zone.id}_mute`,
      name: 'Dempen',
      icon: 'mdi:volume-mute',
      color: 'red',
      features_position: 'inline',
      features: [{ type: 'toggle' }],
    },
  ];

  const inputs = zoneInputs(zone, cfg);
  if (inputs.length) {
    cards.push({
      type: 'tile',
      entity: `select.zonepro_zone${zone.id}_input`,
      name: 'Bron',
      icon: 'mdi:import',
      features_position: 'inline',
      features: [{ type: 'select-options' }],
    });
  }

  return { type: 'vertical-stack', cards };
}

function iconForInput(name) {
  const n = name.toLowerCase();
  if (n.includes('mic')) return 'mdi:microphone';
  if (n.includes('phone') || n.includes('page')) return 'mdi:phone';
  if (n.includes('cd')) return 'mdi:disc';
  if (n.includes('sat')) return 'mdi:satellite-variant';
  if (n.includes('tv')) return 'mdi:television';
  if (n.includes('juke')) return 'mdi:jukebox';
  if (n.includes('dvd')) return 'mdi:disc-player';
  if (n === 'none' || n === 'off') return 'mdi:volume-off';
  return 'mdi:import';
}

function sourceButtonsCard(zone, cfg) {
  const inputs = zoneInputs(zone, cfg);
  const entityId = `select.zonepro_zone${zone.id}_input`;

  return {
    type: 'vertical-stack',
    cards: [
      { type: 'markdown', content: `**${zone.name}**` },
      {
        type: 'grid',
        columns: 3,
        square: false,
        cards: inputs.map((input) => ({
          type: 'button',
          name: input.name,
          icon: iconForInput(input.name),
          tap_action: {
            action: 'perform-action',
            perform_action: 'select.select_option',
            target: { entity_id: entityId },
            data: { option: input.name },
          },
        })),
      },
    ],
  };
}

function buildDashboard(cfg) {
  const zones = cfg.zones.filter((z) => !!z.object);
  const zonesWithInputs = zones.filter((z) => zoneInputs(z, cfg).length > 0);

  const views = [
    {
      title: 'Zones',
      path: 'zones',
      icon: 'mdi:speaker-multiple',
      cards: zones.map((z) => zoneCards(z, cfg)),
    },
  ];

  if (zonesWithInputs.length) {
    views.push({
      title: 'Bronnen',
      path: 'bronnen',
      icon: 'mdi:import',
      cards: zonesWithInputs.map((z) => sourceButtonsCard(z, cfg)),
    });
  }

  const dashboard = { views };

  const header = [
    '# Automatisch gegenereerd door de ZonePRO Control /ha-dashboard pagina.',
    '# Gebaseerd op de zones/inputs in config.json -- wijzig config.json (of',
    '# via /config) en genereer opnieuw i.p.v. dit bestand met de hand aan te',
    '# passen, anders raakt het uit sync.',
    '',
  ].join('\n');

  return header + yaml.dump(dashboard, { lineWidth: -1, noRefs: true });
}

module.exports = { buildDashboard };
