/*
 * REMOTE PLAYERS RENDERER — Three.js companion module
 * Version: 1.0.0
 *
 * Purpose:
 *   Creates and manages the visible 3D representations of OTHER players.
 *   It does not open network connections. Use your Colyseus client/server
 *   to call add(), update(), remove(), and tick().
 *
 * Required game bridge:
 *   window.__p.scene = scene;
 *   window.__p.VEH   = VEH; // vehicle groups with .g for car/bike/truck/foot
 *
 * Usage:
 *   const remotePlayers = new RemotePlayers(window.__p);
 *   remotePlayers.add(sessionId, playerState);
 *   remotePlayers.update(sessionId, playerState);
 *   remotePlayers.tick(deltaSeconds);
 *   remotePlayers.remove(sessionId);
 *   remotePlayers.dispose();
 *
 * Player state fields: { x, y, z, h, vehicle, mode, displayName }
 * This is an optional renderer module; it is not a second network client.
 */
(() => {
  'use strict';

  if (window.RemotePlayers) return;

  const DEFAULTS = Object.freeze({
    interpolationSpeed: 12,
    teleportDistance: 55,
    maxNameLength: 18,
    nameplateWidth: 3.9,
    nameplateHeight: 0.98,
    nameplateOffset: { car: 3.25, bike: 2.55, truck: 4.8, foot: 2.15 },
    showNameplates: true,
    hideInteriorPlayers: true
  });

  const finite = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const cleanName = (value) => String(value || 'Player')
    .replace(/[<>\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, DEFAULTS.maxNameLength) || 'Player';
  const validVehicle = (value) => ['car', 'bike', 'truck', 'foot'].includes(String(value)) ? String(value) : 'car';
  const validMode = (value) => ['interior', 'walk', 'outdoor'].includes(String(value)) ? String(value) : 'outdoor';
  const angleDelta = (from, to) => {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };

  class RemotePlayers {
    constructor(gameApi = window.__p, options = {}) {
      this.game = gameApi;
      this.options = { ...DEFAULTS, ...options };
      this.players = new Map();
      this.disposed = false;
      this._validateGame();
    }

    _validateGame() {
      if (!window.THREE) throw new Error('RemotePlayers requires Three.js on window.THREE.');
      if (!this.game || !this.game.scene || !this.game.VEH) {
        throw new Error('RemotePlayers requires window.__p.scene and window.__p.VEH.');
      }
    }

    _snapshot(data = {}) {
      return {
        x: clamp(finite(data.x), -1000000, 1000000),
        y: clamp(finite(data.y), -1000000, 1000000),
        z: clamp(finite(data.z), -1000000, 1000000),
        h: finite(data.h),
        vehicle: validVehicle(data.vehicle),
        mode: validMode(data.mode),
        displayName: cleanName(data.displayName)
      };
    }

    _makeNameTexture(name) {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.clearRect(0, 0, 512, 128);
      ctx.fillStyle = 'rgba(8,12,18,.88)';
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath(); ctx.roundRect(12, 10, 488, 108, 22); ctx.fill();
      } else ctx.fillRect(12, 10, 488, 108);
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

    _makeNameplate(name) {
      if (!this.options.showNameplates) return null;
      const THREE = window.THREE;
      const texture = this._makeNameTexture(name);
      if (!texture) return null;
      const material = new THREE.SpriteMaterial({
        map: texture, transparent: true, depthTest: false, depthWrite: false
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(this.options.nameplateWidth, this.options.nameplateHeight, 1);
      sprite.renderOrder = 999;
      this.game.scene.add(sprite);
      return sprite;
    }

    _removeObject(object) {
      if (!object) return;
      this.game.scene.remove(object);
      // Vehicle meshes are clones of the game's shared models. Do not dispose
      // their shared geometries/materials; doing so can break the local player.
    }

    _setVehicle(entry, vehicle) {
      const type = validVehicle(vehicle);
      if (entry.vehicle === type && entry.object) return;
      this._removeObject(entry.object);
      entry.object = null;
      const source = this.game.VEH[type] && this.game.VEH[type].g;
      if (!source || typeof source.clone !== 'function') {
        console.warn('[RemotePlayers] Model not available for:', type);
        entry.vehicle = type;
        return;
      }
      const clone = source.clone(true);
      clone.visible = true;
      clone.position.set(entry.target.x, entry.target.y, entry.target.z);
      clone.rotation.set(0, entry.target.h, 0);
      clone.traverse((node) => {
        if (node.isMesh) {
          node.castShadow = false;
          node.receiveShadow = false;
        }
      });
      this.game.scene.add(clone);
      entry.object = clone;
      entry.vehicle = type;
      entry.height = finite(this.options.nameplateOffset[type], 3);
    }

    add(sessionId, playerState) {
      if (this.disposed) throw new Error('RemotePlayers has been disposed.');
      if (!sessionId) return null;
      const id = String(sessionId);
      const data = this._snapshot(playerState);
      if (this.players.has(id)) return this.update(id, data);
      const entry = {
        id,
        name: data.displayName,
        vehicle: '',
        object: null,
        label: null,
        height: 3,
        target: { x: data.x, y: data.y, z: data.z, h: data.h, mode: data.mode }
      };
      this.players.set(id, entry);
      this._setVehicle(entry, data.vehicle);
      entry.label = this._makeNameplate(entry.name);
      if (entry.label) entry.label.position.set(data.x, data.y + entry.height, data.z);
      this._applyVisibility(entry);
      return entry;
    }

    update(sessionId, playerState) {
      const entry = this.players.get(String(sessionId));
      if (!entry || !playerState) return false;
      const data = this._snapshot({ ...entry.target, ...playerState, displayName: playerState.displayName ?? entry.name, vehicle: playerState.vehicle ?? entry.vehicle });
      entry.target.x = data.x;
      entry.target.y = data.y;
      entry.target.z = data.z;
      entry.target.h = data.h;
      entry.target.mode = data.mode;
      if (data.vehicle !== entry.vehicle) this._setVehicle(entry, data.vehicle);
      if (data.displayName !== entry.name) {
        entry.name = data.displayName;
        if (entry.label) {
          const nextTexture = this._makeNameTexture(entry.name);
          const oldTexture = entry.label.material.map;
          entry.label.material.map = nextTexture;
          entry.label.material.needsUpdate = true;
          if (oldTexture) oldTexture.dispose();
        }
      }
      this._applyVisibility(entry);
      return true;
    }

    _applyVisibility(entry) {
      const hidden = this.options.hideInteriorPlayers && entry.target.mode === 'interior';
      if (entry.object) entry.object.visible = !hidden;
      if (entry.label) entry.label.visible = !hidden;
    }

    remove(sessionId) {
      const id = String(sessionId);
      const entry = this.players.get(id);
      if (!entry) return false;
      this._removeObject(entry.object);
      if (entry.label) {
        this.game.scene.remove(entry.label);
        if (entry.label.material.map) entry.label.material.map.dispose();
        entry.label.material.dispose();
      }
      this.players.delete(id);
      return true;
    }

    tick(deltaSeconds) {
      if (this.disposed) return;
      const dt = clamp(finite(deltaSeconds), 0, 0.1);
      const blend = 1 - Math.exp(-dt * this.options.interpolationSpeed);
      for (const entry of this.players.values()) {
        this._applyVisibility(entry);
        if (!entry.object || (this.options.hideInteriorPlayers && entry.target.mode === 'interior')) continue;
        const target = entry.target;
        const object = entry.object;
        const distance = Math.hypot(target.x - object.position.x, target.z - object.position.z);
        if (distance > this.options.teleportDistance) {
          object.position.set(target.x, target.y, target.z);
        } else {
          object.position.x += (target.x - object.position.x) * blend;
          object.position.y += (target.y - object.position.y) * blend;
          object.position.z += (target.z - object.position.z) * blend;
        }
        object.rotation.y += angleDelta(object.rotation.y, target.h) * blend;
        if (entry.label) {
          entry.label.position.set(object.position.x, object.position.y + entry.height, object.position.z);
        }
      }
    }

    clear() {
      for (const id of Array.from(this.players.keys())) this.remove(id);
    }

    get count() { return this.players.size; }
    get(sessionId) { return this.players.get(String(sessionId)) || null; }
    values() { return Array.from(this.players.values()); }

    dispose() {
      if (this.disposed) return;
      this.clear();
      this.disposed = true;
    }
  }

  window.RemotePlayers = RemotePlayers;
})();
