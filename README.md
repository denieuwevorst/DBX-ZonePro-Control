# ZonePRO Zone Control

A small web control panel with 6 volume sliders, mute buttons, and input
source selectors for a dbx ZonePRO unit, controlled over its IP protocol
(port 3804). Built to match the "1-way control of ZonePRO products"
reference: sends `MultiSVSet` (0x0100) messages for the Router object's
Input Source, Master Fader (volume), and Master Mute state variables.
Verified byte-for-byte against your captured Zone 1 / Cafe hex strings
(mute, unmute, and the volume steps from -90dB to +20dB).

Because the ZonePRO gives no feedback, the server is the single source of
truth: every change is written to `state.json` and pushed to every open
browser tab over WebSocket, so all pages (on any computer on the network)
always show the same thing, and a fresh page load restores the last known
state instantly.

## Setup

```
npm install
npm start
```

The panel is served at **http://<this-computer's-ip>:3001** — open that from
any computer on your network, not just `localhost`.

## Installing on Debian with autostart on boot

This runs the panel as a systemd service, so it starts automatically at boot
and restarts itself if it ever crashes.

1. **Install Node.js** (Debian's own `nodejs` package is often quite old —
   this uses NodeSource's, any recent LTS works fine):

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. **Create a dedicated user and install location:**

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin zonepro
   sudo mkdir -p /opt/zonepro-control
   ```

3. **Copy the project there** (from wherever you unzipped it):

   ```bash
   sudo cp -r . /opt/zonepro-control
   cd /opt/zonepro-control
   sudo npm install --omit=dev
   ```

4. **Edit `config.json`** with your ZonePRO IP, zone object IDs, and inputs
   (see [Configuration](#configuration-configjson) below), then hand the
   whole directory to the service user:

   ```bash
   sudo nano /opt/zonepro-control/config.json
   sudo chown -R zonepro:zonepro /opt/zonepro-control
   ```

5. **Install and start the systemd service.** A unit file is included at
   `deploy/zonepro-control.service`:

   ```bash
   sudo cp /opt/zonepro-control/deploy/zonepro-control.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now zonepro-control
   ```

6. **Check it's running:**

   ```bash
   sudo systemctl status zonepro-control
   journalctl -u zonepro-control -f      # live logs
   ```

After any future `config.json` edit, restart it with
`sudo systemctl restart zonepro-control`.

If your Debian box has a firewall (`ufw`/`nftables`), make sure port 3001 is
allowed from your LAN, e.g. `sudo ufw allow 3001/tcp`.

## Configuration (`config.json`)

- `zonepro.ip` / `zonepro.port` — address of the ZonePRO unit (port is
  always 3804).
- `protocol.destDevice` — the ZonePRO's virtual device address, taken from
  your captured strings (`0x0023` for your Cafe zone).
- `protocol.muteSvId` / `volumeSvId` / `inputSvId` — fixed dbx router state
  variable IDs, you shouldn't need to change these.
- `inputs[]` — the list of sources shown in every zone's SRC dropdown, as
  `{ "value": N, "name": "..." }`. `value` is the raw byte the ZonePRO
  expects for that source on a router object. **The list in this repo is
  just the example from the dbx guide** (Lobby Mic, Phone Page, CD,
  Satellite, TV, Jukebox) — your actual sources and their numbers depend on
  your ZonePRO Designer configuration, so rename/reorder/add/remove entries
  to match. A zone can have its own `"inputs": [...]` override if its
  sources differ from the shared list (e.g. a zone with fewer inputs wired
  up).
- `zones[]` — one entry per zone. `object` is that zone's router Object ID
  (e.g. `"0x01050018"`). Zone 1 is already filled in from what you sent.
  **Zones with `object: null` are left out of the page entirely** — they
  won't appear on `/` and their `/zoneN` page will show "not configured"
  until you fill them in.

### Finding the other 5 object IDs (and your actual input numbers)

From the reference guide (Section 3): open ZonePRO Designer connected to the
unit, click each zone's router object, and press `Ctrl+Shift+O` to read its
Object ID. Alternatively open the Network Trace window (`Ctrl+Shift+T`),
move that zone's fader slightly, and read the object bytes out of the
captured frame — same as how the Zone 1 string was captured.

The same Network Trace window works for finding each source's real number:
select each input for a zone in ZonePRO Designer one at a time, and read the
`SV_Val` byte at the end of the captured `MultiSVSet` frame (the same byte
you sent for the router's example: 0=none, 1=Lobby Mic, 2=Phone Page, etc.
— but only if your project uses that same ordering).

Once you have them, edit `config.json`, e.g.:

```json
{ "id": 2, "name": "Zone 2 \u2013 Patio", "object": "0x01050019" }
```

Restart the server after editing the config — the zone will then appear
automatically.

## Pages

- `http://<host>:3001/` — every configured zone, side by side.
- `http://<host>:3001/zone1`, `/zone2`, ... `/zone6` — a single zone by
  itself, bigger fader, good for a phone or a wall tablet dedicated to one
  room. Each zone strip on the main page has a small &#8599; link to jump
  to its own page.

The layout is a responsive grid, not a fixed row, so it reflows into fewer
columns automatically on a phone instead of requiring horizontal scrolling,
and the fader thumb / mute button are sized for touch.

## How it works

- `server.js` — Express serves the UI, holds one persistent TCP connection
  to the ZonePRO (auto-reconnects every 5s if it drops), builds and sends
  the raw protocol packets, and runs a WebSocket server that broadcasts
  every state change to all connected browsers.
- `state.json` — last known volume/mute/input per zone, written after each
  command that was actually sent. Loaded on server start and sent to every
  browser as soon as it connects.
- `public/` — the static UI (plain HTML/CSS/JS, no build step).

### Volume mapping

The ZonePRO fader raw value runs 1–221 in 0.5dB steps from -90dB to +20dB
(0 = full attenuation / "-inf"). The UI works entirely in dB; the server
converts with `raw = round((db + 90) * 2) + 1`.

### Packet format

Per the guide's IP Connections appendix, IP packets are the RS-232 frame
without the Frame Start/Frame Count bytes and without the trailing
checksum — just `Version, Length, Src[Device:Object], Dest[Device:Object],
MsgID, Flags, Payload`. The Src object field mirrors the Dest object field
(confirmed against your captured strings), even though it looks redundant.

## Notes

- This is a 1-way (open-loop) controller, per the dbx guide — the server
  never reads anything back from the ZonePRO, so if a command is sent while
  the unit is unreachable, it's simply dropped (logged to the console) and
  `state.json` is left unchanged, since the unit's own state didn't change
  either.
- Slider drags are throttled (~80ms) before hitting the network so dragging
  doesn't flood the ZonePRO with commands; the final position is always
  sent.
