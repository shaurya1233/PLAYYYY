/*
 * PLAYER SYNCHRONIZATION MODULE
 * Companion utility for the WORLD MULTIPLAYER CLIENT.
 *
 * Exposes: window.PlayerSynchronization
 *
 * IMPORTANT:
 * The current multiplayer-client.js already sends player movement and
 * interpolates remote players internally. This file is an optional reusable
 * synchronization utility for a future refactor; it does not connect to the
 * server by itself and should not be loaded as a second networking client.
 */
(() => {
  'use strict';

  if (window.PlayerSynchronization) return;

  const DEFAULTS = Object.freeze({
    sendIntervalMs: 50,
    maxCoordinate: 1000000,
    maxNameLength: 18,
    teleportDistance: 55,
    interpolationSpeed: 13
  });

  const finite = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const cleanText = (value, maxLength, fallback) => {
    const text = String(value ?? '')
      .replace(/[<>\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
    return text || fallback;
  };

  const validVehicle = (value) => {
    const v = String(value || 'foot').toLowerCase();
    return ['car', 'bike', 'truck', 'foot'].includes(v) ? v : 'foot';
  };

  const validMode = (value) => {
    const mode = String(value || 'outdoor').toLowerCase();
    return ['outdoor', 'interior', 'walk'].includes(mode) ? mode : 'outdoor';
  };

  function createSnapshot(player, options = {}) {
    if (!player || typeof player !== 'object') return null;
    const cfg = { ...DEFAULTS, ...options };
    const limit = cfg.maxCoordinate;
    return Object.freeze({
      x: clamp(finite(player.x), -limit, limit),
      y: clamp(finite(player.y), -limit, limit),
      z: clamp(finite(player.z), -limit, limit),
      h: finite(player.h),
      vehicle: validVehicle(player.vehicle),
      mode: validMode(player.mode),
      displayName: cleanText(player.displayName, cfg.maxNameLength, 'Player'),
      timestamp: Date.now()
    });
  }

  function readGameSnapshot(gameApi, displayName = 'Player') {
    if (!gameApi || !gameApi.P) return null;
    const p = gameApi.P;
    return createSnapshot({
      x: p.x,
      y: p.y,
      z: p.z,
      h: p.h,
      vehicle: gameApi.veh || gameApi.vehicle || 'foot',
      mode: gameApi.mode || 'outdoor',
      displayName
    });
  }

  function createSender(send, intervalMs = DEFAULTS.sendIntervalMs) {
    let lastSentAt = 0;
    let lastPacket = '';
    return {
      sendIfDue(snapshot, now = Date.now()) {
        if (typeof send !== 'function' || !snapshot) return false;
        if (now - lastSentAt < intervalMs) return false;
        const packet = JSON.stringify(snapshot);
        if (packet === lastPacket) return false;
        try {
          send(snapshot);
          lastSentAt = now;
          lastPacket = packet;
          return true;
        } catch (error) {
          return false;
        }
      },
      reset() { lastSentAt = 0; lastPacket = ''; }
    };
  }

  function shortestAngleDelta(from, to) {
    let delta = (to - from) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  function createInterpolator(initial = {}, options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    const current = {
      x: finite(initial.x), y: finite(initial.y), z: finite(initial.z),
      h: finite(initial.h)
    };
    const target = { ...current };

    return {
      get current() { return { ...current }; },
      get target() { return { ...target }; },
      setTarget(next) {
        if (!next || typeof next !== 'object') return;
        target.x = finite(next.x, target.x);
        target.y = finite(next.y, target.y);
        target.z = finite(next.z, target.z);
        target.h = finite(next.h, target.h);
      },
      snap(next) {
        this.setTarget(next);
        Object.assign(current, target);
      },
      update(deltaSeconds) {
        const dt = clamp(finite(deltaSeconds), 0, 0.1);
        const blend = 1 - Math.exp(-dt * cfg.interpolationSpeed);
        const distance = Math.hypot(target.x - current.x, target.z - current.z);
        if (distance > cfg.teleportDistance) {
          Object.assign(current, target);
        } else {
          current.x += (target.x - current.x) * blend;
          current.y += (target.y - current.y) * blend;
          current.z += (target.z - current.z) * blend;
          current.h += shortestAngleDelta(current.h, target.h) * blend;
        }
        return { ...current };
      }
    };
  }

  function createRemoteRegistry() {
    const players = new Map();
    return {
      add(sessionId, snapshot) {
        if (!sessionId) return null;
        const entry = {
          sessionId: String(sessionId),
          displayName: cleanText(snapshot && snapshot.displayName, DEFAULTS.maxNameLength, 'Player'),
          vehicle: validVehicle(snapshot && snapshot.vehicle),
          mode: validMode(snapshot && snapshot.mode),
          interpolation: createInterpolator(snapshot)
        };
        entry.interpolation.setTarget(snapshot || {});
        players.set(entry.sessionId, entry);
        return entry;
      },
      update(sessionId, snapshot) {
        const entry = players.get(String(sessionId));
        if (!entry || !snapshot) return false;
        entry.displayName = cleanText(snapshot.displayName, DEFAULTS.maxNameLength, entry.displayName);
        entry.vehicle = validVehicle(snapshot.vehicle);
        entry.mode = validMode(snapshot.mode);
        entry.interpolation.setTarget(snapshot);
        return true;
      },
      remove(sessionId) { return players.delete(String(sessionId)); },
      clear() { players.clear(); },
      get(sessionId) { return players.get(String(sessionId)) || null; },
      values() { return Array.from(players.values()); },
      get size() { return players.size; }
    };
  }

  window.PlayerSynchronization = Object.freeze({
    version: '1.0.0',
    createSnapshot,
    readGameSnapshot,
    createSender,
    createInterpolator,
    createRemoteRegistry,
    validVehicle,
    validMode
  });
})();
