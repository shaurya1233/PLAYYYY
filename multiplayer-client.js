/*
 * WORLD MULTIPLAYER CLIENT
 * Browser-side Colyseus client for the existing Three.js driving game.
 *
 * Required game bridge (add AFTER window.__p is created in multiplayer-game.html):
 *     window.__p.scene = scene;
 *
 * This file expects the game to expose:
 *     window.__p.P       -> local player state { x, y, z, h }
 *     window.__p.VEH     -> vehicle groups, each with .g (car, bike, truck, foot)
 *     window.__p.veh     -> current vehicle name
 *     window.__p.mode    -> current game mode ('walk' or vehicle mode)
 *     window.__p.scene   -> the Three.js scene (the bridge line above)
 *     window.__p.H       -> optional terrain-height function
 *
 * Server contract:
 *   room name: "world"
 *   join options: { displayName }
 *   room state: state.players map
 *   player fields: x, y, z, h, vehicle, mode, displayName
 *   client message: "move" with the same fields
 *
 * Load this file once, after the game has initialized window.__p.
 * Do not load it alongside a second copy of the inline multiplayer client.
 */
(() => {
  'use strict';

  if (window.WorldMultiplayerClient) return;

  const CONFIG = {
    roomName: 'world',
    sdkUrl: 'https://unpkg.com/@colyseus/sdk@0.18.8/dist/colyseus.js',
    sendIntervalMs: 50,
    interpolationSpeed: 13,
    maxNameLength: 18,
    maxRosterEntries: 24,
    reconnectDelayMs: 2500
  };

  const state = {
    client: null,
    room: null,
    sdkPromise: null,
    connected: false,
    connecting: false,
    lastSendAt: 0,
    lastRosterAt: 0,
    animationFrame: 0,
    reconnectTimer: 0,
    wantsReconnect: false,
    remotes: new Map(),
    callbacks: null,
    destroyed: false
  };

  const safeStorage = {
    get(key, fallback = '') {
      try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch (_) {}
    }
  };

  const game = () => window.__p || null;
  const gameReady = () => {
    const api = game();
    return !!(api && api.P && api.VEH && api.scene && window.THREE);
  };

  const cleanName = (value) => String(value || '')
    .replace(/[<>\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CONFIG.maxNameLength) || 'Player';

  const finite = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const validVehicle = (value) =>
    ['car', 'bike', 'truck', 'foot'].includes(String(value)) ? String(value) : 'car';

  const snapshot = () => {
    const api = game();
    if (!api || !api.P) return null;
    const p = api.P;
    const vehicle = validVehicle(api.veh || 'car');
    const mode = api.mode === 'walk' ? 'interior' : 'outdoor';
    let y = finite(p.y, 0);
    if (typeof api.H === 'function' && Number.isFinite(p.x) && Number.isFinite(p.z)) {
      try { y = finite(api.H(p.x, p.z), y); } catch (_) {}
    }
    return {
      x: finite(p.x), y, z: finite(p.z), h: finite(p.h),
      vehicle, mode,
      displayName: cleanName(nameInput ? nameInput.value : 'Player')
    };
  };

  function loadSdk() {
    if (window.Colyseus && window.Colyseus.Client && window.Colyseus.Callbacks) {
      return Promise.resolve(window.Colyseus);
    }
    if (state.sdkPromise) return state.sdkPromise;

    state.sdkPromise = new Promise((resolve, reject) => {
      let script = document.querySelector('script[data-world-mp-sdk="true"]');
      if (script && window.Colyseus && window.Colyseus.Client && window.Colyseus.Callbacks) {
        resolve(window.Colyseus);
        return;
      }
      if (!script) {
        script = document.createElement('script');
        script.src = CONFIG.sdkUrl;
        script.async = true;
        script.crossOrigin = 'anonymous';
        script.dataset.worldMpSdk = 'true';
        document.head.appendChild(script);
      }
      const onLoad = () => {
        if (window.Colyseus && window.Colyseus.Client && window.Colyseus.Callbacks) resolve(window.Colyseus);
        else reject(new Error('Colyseus SDK loaded, but its Client or Callbacks API was not found.'));
      };
      const onError = () => reject(new Error('Could not load the Colyseus SDK. Check your internet connection.'));
      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });
      if (script.dataset.loaded === 'true') onLoad();
      script.addEventListener('load', () => { script.dataset.loaded = 'true'; }, { once: true });
    }).catch((error) => {
      state.sdkPromise = null;
      throw error;
    });

    return state.sdkPromise;
  }

  const style = document.createElement('style');
  style.textContent = `
    #world-mp{position:fixed;z-index:99998;top:14px;right:14px;color:#f5f3ee;font:500 12px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;pointer-events:none}
    #world-mp *{box-sizing:border-box}
    #world-mp-toggle{pointer-events:auto;display:flex;align-items:center;gap:9px;min-height:42px;padding:0 14px;border:1px solid #ffffff25;border-radius:99px;background:#10151de8;color:#fff;box-shadow:0 10px 32px #0006;backdrop-filter:blur(14px);font:800 10px system-ui;letter-spacing:.13em;cursor:pointer}
    #world-mp-toggle .dot{width:8px;height:8px;border-radius:50%;background:#9299a4;box-shadow:0 0 0 4px #9299a41f}
    #world-mp-toggle[data-state=online] .dot{background:#42dc9b;box-shadow:0 0 0 4px #42dc9b22,0 0 14px #42dc9b99}
    #world-mp-toggle[data-state=connecting] .dot{background:#f6bd55;box-shadow:0 0 0 4px #f6bd5522}
    #world-mp-toggle b{min-width:22px;height:22px;padding:0 5px;display:grid;place-items:center;border-radius:99px;background:#ffffff1c;font-size:11px;letter-spacing:0}
    #world-mp-panel{pointer-events:auto;position:absolute;right:0;top:51px;width:min(360px,calc(100vw - 24px));padding:17px;border:1px solid #ffffff24;border-radius:18px;background:linear-gradient(145deg,#171e28f7,#080c12f7);box-shadow:0 24px 70px #0009;backdrop-filter:blur(20px)}
    #world-mp-panel[hidden]{display:none}
    #world-mp-panel .eyebrow{font-size:9px;font-weight:800;letter-spacing:.2em;color:#b8c0ca}
    #world-mp-panel h3{margin:5px 0 4px;font-size:20px;letter-spacing:-.04em;color:#fff}
    #world-mp-panel p{margin:0 0 13px;color:#adb7c4;font-size:11px}
    #world-mp-panel label{display:block;margin:11px 0 6px;color:#d8dee6;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
    #world-mp-panel input{width:100%;height:40px;border:1px solid #ffffff24;border-radius:10px;background:#ffffff0c;padding:0 11px;color:#fff;font:500 12px system-ui;outline:none}
    #world-mp-panel input:focus{border-color:#d9bd8a;box-shadow:0 0 0 3px #d9bd8a20}
    #world-mp-actions{display:flex;gap:8px;margin-top:14px}
    #world-mp-actions button{flex:1;min-height:40px;border:1px solid #ffffff20;border-radius:10px;font:800 10px system-ui;letter-spacing:.08em;cursor:pointer}
    #world-mp-join{background:linear-gradient(135deg,#e2c998,#a9824f);color:#17130e;border:0}
    #world-mp-leave{background:#ffffff0d;color:#fff}
    #world-mp-actions button:disabled{opacity:.45;cursor:not-allowed}
    #world-mp-status{margin-top:12px;padding:10px 11px;border-radius:10px;background:#ffffff0c;color:#c8d0da;font-size:11px}
    #world-mp-status[data-state=online]{color:#9ae8c2;background:#24b1731a}
    #world-mp-status[data-state=error]{color:#ffb7ad;background:#cc453b20}
    #world-mp-roster{list-style:none;margin:8px 0 0;padding:0;max-height:145px;overflow:auto}
    #world-mp-roster li{padding:6px 2px;border-top:1px solid #ffffff12;color:#e0e5eb;font-size:11px}
    #world-mp-roster li:before{content:'●';margin-right:8px;color:#42dc9b;font-size:8px}
    #world-mp-foot{margin:11px 0 0!important;color:#8994a2!important;font-size:9px!important;line-height:1.5}
    @media(max-width:540px){#world-mp{top:8px;right:8px}#world-mp-toggle{min-height:38px;padding:0 11px}#world-mp-panel{top:46px}}
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'world-mp';
  root.innerHTML = `
    <button id="world-mp-toggle" type="button" data-state="offline" aria-expanded="false">
      <span class="dot" aria-hidden="true"></span><span>WORLD ONLINE</span><b id="world-mp-count">0</b>
    </button>
    <section id="world-mp-panel" hidden aria-label="Online multiplayer">
      <div class="eyebrow">GLOBAL WORLD NETWORK</div>
      <h3>Play with others</h3>
      <p>Join the same live world as players in other cities and countries.</p>
      <label for="world-mp-name">Player name</label>
      <input id="world-mp-name" maxlength="18" autocomplete="nickname" placeholder="Enter a player name">
      <label for="world-mp-server">Multiplayer server URL</label>
      <input id="world-mp-server" inputmode="url" autocomplete="url" placeholder="https://your-server.example.com">
      <div id="world-mp-actions">
        <button id="world-mp-join" type="button">JOIN GLOBAL WORLD</button>
        <button id="world-mp-leave" type="button" disabled>LEAVE</button>
      </div>
      <div id="world-mp-status" data-state="offline" role="status" aria-live="polite">Offline · Single-player still works</div>
      <div style="margin-top:11px;color:#9da8b5;font-size:10px">Players in this room: <strong id="world-mp-room-count">0</strong></div>
      <ul id="world-mp-roster" aria-label="Players in this room"><li>Only you, for now</li></ul>
      <p id="world-mp-foot">A deployed Colyseus server is required. This client synchronizes the outdoor world; indoor areas remain local.</p>
    </section>`;
  document.body.appendChild(root);

  const toggle = root.querySelector('#world-mp-toggle');
  const panel = root.querySelector('#world-mp-panel');
  const nameInput = root.querySelector('#world-mp-name');
  const serverInput = root.querySelector('#world-mp-server');
  const joinButton = root.querySelector('#world-mp-join');
  const leaveButton = root.querySelector('#world-mp-leave');
  const statusBox = root.querySelector('#world-mp-status');
  const countBadge = root.querySelector('#world-mp-count');
  const roomCount = root.querySelector('#world-mp-room-count');
  const roster = root.querySelector('#world-mp-roster');

  nameInput.value = safeStorage.get('world-mp-name') || `Driver-${Math.floor(1000 + Math.random() * 9000)}`;
  serverInput.value = safeStorage.get('world-mp-server');

  function setStatus(kind, message) {
    statusBox.dataset.state = kind;
    statusBox.textContent = message;
    toggle.dataset.state = kind;
  }

  function makeNameTexture(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable for player name labels.');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(8,12,18,.88)';
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath(); ctx.roundRect(12, 10, 488, 108, 22); ctx.fill();
    } else {
      ctx.fillRect(12, 10, 488, 108);
    }
    ctx.strokeStyle = 'rgba(221,190,137,.9)';
    ctx.lineWidth = 3;
    ctx.strokeRect(13, 11, 486, 106);
    ctx.fillStyle = '#f7f2e9';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 43px Arial,sans-serif';
    let label = cleanName(name);
    while (ctx.measureText(label).width > 430 && label.length > 4) label = label.slice(0, -1);
    ctx.fillText(label, 256, 65, 430);
    return new window.THREE.CanvasTexture(canvas);
  }

  function createNameplate(name) {
    const THREE = window.THREE;
    const texture = makeNameTexture(name);
    const material = new THREE.SpriteMaterial({
      map: texture, transparent: true, depthTest: false, depthWrite: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(3.9, 0.98, 1);
    sprite.renderOrder = 999;
    game().scene.add(sprite);
    return sprite;
  }

  function clearVehicle(remote) {
    const scene = game() && game().scene;
    if (scene && remote.object) scene.remove(remote.object);
    if (remote.object) {
      remote.object.traverse((node) => {
        if (node.geometry && node.geometry.dispose && node.userData && node.userData.worldMpOwnedGeometry) {
          node.geometry.dispose();
        }
      });
    }
    remote.object = null;
  }

  function setRemoteVehicle(remote, kind) {
    const api = game();
    if (!api || !api.scene || !api.VEH) return;
    const type = validVehicle(kind);
    if (remote.vehicle === type && remote.object) return;
    clearVehicle(remote);
    const source = api.VEH[type] && api.VEH[type].g;
    if (!source) {
      console.warn('[World MP] Vehicle model not ready:', type);
      return;
    }
    const clone = source.clone(true);
    clone.visible = true;
    clone.position.set(remote.target.x, remote.target.y, remote.target.z);
    clone.rotation.set(0, remote.target.h, 0);
    clone.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = false;
        node.receiveShadow = false;
      }
    });
    api.scene.add(clone);
    remote.object = clone;
    remote.vehicle = type;
    remote.height = ({ car: 3.25, bike: 2.55, truck: 4.8, foot: 2.15 })[type] || 3;
  }

  function createRemote(sessionId, player) {
    const local = snapshot() || { x: 0, y: 0, z: 0, h: 0 };
    const remote = {
      id: sessionId,
      name: cleanName(player.displayName || 'Player'),
      vehicle: '',
      object: null,
      label: null,
      height: 3,
      target: {
        x: finite(player.x, local.x),
        y: finite(player.y, local.y),
        z: finite(player.z, local.z),
        h: finite(player.h, 0),
        mode: String(player.mode || 'outdoor')
      }
    };
    state.remotes.set(sessionId, remote);
    setRemoteVehicle(remote, player.vehicle);
    remote.label = createNameplate(remote.name);
    remote.label.position.set(remote.target.x, remote.target.y + remote.height, remote.target.z);
    return remote;
  }

  function updateRemote(remote, player) {
    if (!remote || !player) return;
    remote.target.x = finite(player.x, remote.target.x);
    remote.target.y = finite(player.y, remote.target.y);
    remote.target.z = finite(player.z, remote.target.z);
    remote.target.h = finite(player.h, remote.target.h);
    remote.target.mode = String(player.mode || 'outdoor');
    const type = validVehicle(player.vehicle);
    if (type !== remote.vehicle) setRemoteVehicle(remote, type);
    const nextName = cleanName(player.displayName || 'Player');
    if (nextName !== remote.name && remote.label) {
      remote.name = nextName;
      const oldTexture = remote.label.material.map;
      remote.label.material.map = makeNameTexture(nextName);
      remote.label.material.needsUpdate = true;
      if (oldTexture) oldTexture.dispose();
    }
  }

  function removeRemote(sessionId) {
    const remote = state.remotes.get(sessionId);
    if (!remote) return;
    clearVehicle(remote);
    const scene = game() && game().scene;
    if (scene && remote.label) scene.remove(remote.label);
    if (remote.label) {
      if (remote.label.material.map) remote.label.material.map.dispose();
      remote.label.material.dispose();
    }
    state.remotes.delete(sessionId);
  }

  function clearRemotes() {
    for (const id of Array.from(state.remotes.keys())) removeRemote(id);
  }

  function getPlayersMap() {
    return state.room && state.room.state && state.room.state.players
      ? state.room.state.players : null;
  }

  function refreshRoster() {
    const players = getPlayersMap();
    const names = [];
    if (players) {
      try {
        for (const [id, player] of players) {
          const isYou = state.room && id === state.room.sessionId;
          names.push(`${cleanName(player.displayName || 'Player')}${isYou ? ' (you)' : ''}`);
        }
      } catch (error) {
        console.debug('[World MP] Roster update failed:', error);
      }
    }
    const count = names.length;
    countBadge.textContent = String(count);
    roomCount.textContent = String(count);
    roster.replaceChildren();
    if (!names.length) names.push('Only you, for now');
    names.slice(0, CONFIG.maxRosterEntries).forEach((name) => {
      const li = document.createElement('li');
      li.textContent = name;
      roster.appendChild(li);
    });
  }

  function bindPlayer(callbacks, player, sessionId, remote) {
    const fields = ['x', 'y', 'z', 'h', 'vehicle', 'mode', 'displayName'];
    for (const field of fields) {
      try {
        callbacks.listen(player, field, (value) => {
          if (field === 'displayName') {
            updateRemote(remote, { displayName: value });
          } else {
            const patch = { [field]: value };
            updateRemote(remote, patch);
          }
        });
      } catch (error) {
        console.debug('[World MP] Could not observe player field:', field, error);
      }
    }
    updateRemote(remote, player);
  }

  function attachRoom(room, sdk) {
    const callbacks = sdk.Callbacks.get(room);
    state.callbacks = callbacks;

    callbacks.onAdd('players', (player, sessionId) => {
      if (sessionId !== room.sessionId && !state.remotes.has(sessionId)) {
        const remote = createRemote(sessionId, player);
        bindPlayer(callbacks, player, sessionId, remote);
      }
      refreshRoster();
    });

    callbacks.onRemove('players', (_player, sessionId) => {
      removeRemote(sessionId);
      refreshRoster();
    });

    room.onMessage('notice', (message) => {
      if (message && message.text) setStatus('online', String(message.text).slice(0, 140));
    });

    room.onError((code, message) => {
      setStatus('error', `Room error: ${String(message || code || 'unknown error').slice(0, 120)}`);
    });

    room.onLeave((code) => {
      if (state.room !== room) return;
      state.room = null;
      state.client = null;
      state.connected = false;
      state.connecting = false;
      state.callbacks = null;
      clearRemotes();
      joinButton.disabled = false;
      leaveButton.disabled = true;
      setStatus('offline', `Disconnected from the online world${code ? ` (${code})` : ''}`);
      refreshRoster();
      if (state.wantsReconnect && !state.destroyed) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(() => connect(), CONFIG.reconnectDelayMs);
      }
    });

    refreshRoster();
  }

  async function connect() {
    if (state.connected || state.connecting) return;
    if (!gameReady()) {
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      setStatus('error', 'Game bridge is missing. Add window.__p.scene = scene after window.__p is created, then load this file after the game script.');
      return;
    }

    const rawServer = serverInput.value.trim().replace(/\/+$/, '');
    const playerName = cleanName(nameInput.value);
    if (!rawServer) {
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      setStatus('error', 'Enter your deployed multiplayer server URL first.');
      serverInput.focus();
      return;
    }

    let parsed;
    try { parsed = new URL(rawServer); }
    catch (_) { setStatus('error', 'Enter a valid server URL.'); return; }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      setStatus('error', 'Use an https:// server URL (http:// is for local testing).');
      return;
    }
    if (location.protocol === 'https:' && parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      setStatus('error', 'A secure website needs an HTTPS multiplayer server.');
      return;
    }

    safeStorage.set('world-mp-name', playerName);
    safeStorage.set('world-mp-server', parsed.toString());
    nameInput.value = playerName;
    state.connecting = true;
    joinButton.disabled = true;
    setStatus('connecting', 'Loading the multiplayer connection…');

    try {
      const sdk = await loadSdk();
      setStatus('connecting', 'Connecting to the global world…');
      const client = new sdk.Client(parsed.toString());
      const room = await client.joinOrCreate(CONFIG.roomName, { displayName: playerName });
      if (state.destroyed) {
        await room.leave();
        return;
      }
      state.client = client;
      state.room = room;
      state.connected = true;
      state.connecting = false;
      state.wantsReconnect = true;
      attachRoom(room, sdk);
      setStatus('online', `Connected · room ${String(room.roomId || CONFIG.roomName)}`);
      joinButton.disabled = true;
      leaveButton.disabled = false;
      refreshRoster();
    } catch (error) {
      state.client = null;
      state.room = null;
      state.connected = false;
      state.connecting = false;
      clearRemotes();
      joinButton.disabled = false;
      leaveButton.disabled = true;
      setStatus('error', `Could not join: ${String(error && error.message || error || 'connection failed').slice(0, 140)}`);
    }
  }

  async function disconnect() {
    state.wantsReconnect = false;
    clearTimeout(state.reconnectTimer);
    const room = state.room;
    state.room = null;
    state.client = null;
    state.connected = false;
    state.connecting = false;
    clearRemotes();
    joinButton.disabled = false;
    leaveButton.disabled = true;
    setStatus('offline', 'You left the online world');
    refreshRoster();
    if (room) {
      try { await room.leave(); } catch (_) {}
    }
  }

  function animate(now) {
    if (state.destroyed) return;
    const api = game();
    if (state.room && state.connected && api && api.P && now - state.lastSendAt >= CONFIG.sendIntervalMs) {
      state.lastSendAt = now;
      const data = snapshot();
      if (data) {
        try { state.room.send('move', data); }
        catch (error) { console.debug('[World MP] Position send failed:', error); }
      }
    }

    if (state.remotes.size && api && api.scene) {
      const dt = Math.min(0.08, Math.max(0, (now - (state.previousFrame || now)) / 1000));
      const blend = 1 - Math.exp(-dt * CONFIG.interpolationSpeed);
      for (const remote of state.remotes.values()) {
        if (!remote.object || !remote.label) continue;
        const isInterior = remote.target.mode === 'interior';
        remote.object.visible = !isInterior;
        remote.label.visible = !isInterior;
        if (isInterior) continue;

        const target = remote.target;
        const dx = target.x - remote.object.position.x;
        const dz = target.z - remote.object.position.z;
        if (Math.hypot(dx, dz) > 55) {
          remote.object.position.set(target.x, target.y, target.z);
        } else {
          remote.object.position.x += dx * blend;
          remote.object.position.y += (target.y - remote.object.position.y) * blend;
          remote.object.position.z += dz * blend;
        }
        const angle = Math.atan2(
          Math.sin(target.h - remote.object.rotation.y),
          Math.cos(target.h - remote.object.rotation.y)
        );
        remote.object.rotation.y += angle * blend;
        remote.label.position.set(
          remote.object.position.x,
          remote.object.position.y + remote.height,
          remote.object.position.z
        );
      }
    }

    if (now - state.lastRosterAt > 1000) {
      state.lastRosterAt = now;
      if (state.room) refreshRoster();
    }
    state.previousFrame = now;
    state.animationFrame = requestAnimationFrame(animate);
  }

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  joinButton.addEventListener('click', connect);
  leaveButton.addEventListener('click', disconnect);
  nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') serverInput.focus(); });
  serverInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') connect(); });
  window.addEventListener('beforeunload', () => {
    state.destroyed = true;
    cancelAnimationFrame(state.animationFrame);
    clearTimeout(state.reconnectTimer);
    if (state.room) { try { state.room.leave(); } catch (_) {} }
  }, { once: true });

  state.animationFrame = requestAnimationFrame(animate);
  window.WorldMultiplayerClient = Object.freeze({
    connect,
    disconnect,
    get connected() { return state.connected; },
    get roomId() { return state.room ? state.room.roomId : null; },
    get remotePlayerCount() { return state.remotes.size; },
    version: '1.0.0'
  });
})();
