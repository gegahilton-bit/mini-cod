const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

// ---------- Config ----------
const MAP = 50, PLAYER_RADIUS = 0.45, PLAYER_HEIGHT = 1.8, EYE = 1.6;
const HEADSHOT_MULT = 2, RESPAWN_MS = 3000, SCORE_LIMIT = 25, MAX_SPEED = 14;
const MAX_PLAYERS_PER_ROOM = 12;

const WEAPONS = {
  rifle:   { name: 'Rifle',   damage: 25, delay: 110,  mag: 30, reload: 1800, pellets: 1, spread: 0.01 },
  pistol:  { name: 'Pistol',  damage: 20, delay: 280,  mag: 12, reload: 1200, pellets: 1, spread: 0.005 },
  shotgun: { name: 'Shotgun', damage: 14, delay: 850,  mag: 6,  reload: 2400, pellets: 8, spread: 0.07 },
  sniper:  { name: 'Sniper',  damage: 90, delay: 1400, mag: 5,  reload: 2800, pellets: 1, spread: 0 },
};
const WEAPON_ORDER = ['rifle', 'pistol', 'shotgun', 'sniper'];

const STREAKS = { 3: 'speed', 5: 'shield', 7: 'double' };
const SHIELD_HP = 50;

const OBSTACLES = [
  [0, -10, 10, 3, 1], [-12, 5, 1, 3, 12], [12, 5, 1, 3, 12], [0, 12, 8, 3, 1],
  [-25, -25, 6, 4, 6], [25, 25, 6, 4, 6], [0, 0, 2, 2, 2],
  [0, -50, 100, 6, 1], [0, 50, 100, 6, 1], [-50, 0, 1, 6, 100], [50, 0, 1, 6, 100],
].map(([x, z, w, h, d]) => ({
  min: { x: x - w / 2, y: 0, z: z - d / 2 },
  max: { x: x + w / 2, y: h, z: z + d / 2 },
}));

const SPAWNS = {
  red:  [[-40, -40], [-30, -40], [-40, -30], [-35, -35]],
  blue: [[40, 40], [30, 40], [40, 30], [35, 35]],
};

// ---------- Rooms ----------
const rooms = {}; // code -> { code, players, teamScore, matchOver }

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join(''); }
  while (rooms[c]);
  return c;
}
function createRoom(code) {
  rooms[code] = { code, players: {}, teamScore: { red: 0, blue: 0 }, matchOver: false, timers: new Set() };
  return rooms[code];
}
function later(room, fn, ms) {
  const t = setTimeout(() => { room.timers.delete(t); fn(); }, ms);
  room.timers.add(t);
}

// ---------- Helpers ----------
function pickTeam(room) {
  const c = { red: 0, blue: 0 };
  Object.values(room.players).forEach(p => c[p.team]++);
  return c.red <= c.blue ? 'red' : 'blue';
}
function spawnPos(team) {
  const s = SPAWNS[team][Math.floor(Math.random() * SPAWNS[team].length)];
  return { x: s[0], y: EYE, z: s[1] };
}
function newLoadout() {
  const ammo = {};
  WEAPON_ORDER.forEach(w => ammo[w] = WEAPONS[w].mag);
  return ammo;
}
function rayBox(o, d, min, max) {
  let tmin = 0, tmax = Infinity;
  for (const a of ['x', 'y', 'z']) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < min[a] || o[a] > max[a]) return null; }
    else {
      let t1 = (min[a] - o[a]) / d[a], t2 = (max[a] - o[a]) / d[a];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}
function publicPlayer(p) {
  return { id: p.id, name: p.name, team: p.team, x: p.x, y: p.y, z: p.z, ry: p.ry, hp: p.hp,
           kills: p.kills, deaths: p.deaths, weapon: p.weapon };
}
function scoreboard(room) {
  return Object.values(room.players).map(p => ({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths }));
}
function resetPlayerState(p) {
  p.hp = 100; p.shield = 0; p.streak = 0; p.buffs = { speed: false, double: false };
  p.ammo = newLoadout(); p.reloading = false; p.weapon = 'rifle';
}
function sendStatus(p, sock) {
  sock.emit('status', { hp: p.hp, shield: p.shield, streak: p.streak, buffs: p.buffs, weapon: p.weapon,
                        ammo: p.ammo[p.weapon], mag: WEAPONS[p.weapon].mag, reloading: p.reloading });
}

function resetMatch(room) {
  room.matchOver = false;
  room.teamScore.red = 0; room.teamScore.blue = 0;
  Object.values(room.players).forEach(p => {
    p.kills = 0; p.deaths = 0; resetPlayerState(p);
    Object.assign(p, spawnPos(p.team), { lastMoveAt: Date.now() });
  });
  io.to(room.code).emit('matchReset', { players: Object.values(room.players).map(publicPlayer), teamScore: room.teamScore });
  Object.values(room.players).forEach(p => { const s = io.sockets.sockets.get(p.id); if (s) sendStatus(p, s); });
  io.to(room.code).emit('scoreboard', scoreboard(room));
}

// ---------- Sockets ----------
io.on('connection', (socket) => {
  let room = null, me = null;

  function joinRoom(code, name) {
    room = rooms[code];
    if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) { socket.emit('joinError', 'Room is full'); room = null; return; }
    socket.join(code);
    const team = pickTeam(room);
    me = room.players[socket.id] = {
      id: socket.id, team, name: (name || '').trim().slice(0, 14) || 'Player' + Math.floor(Math.random() * 999),
      ...spawnPos(team), ry: 0, kills: 0, deaths: 0, lastShot: 0, lastMoveAt: Date.now(),
    };
    resetPlayerState(me);
    socket.emit('init', {
      id: socket.id, code,
      players: Object.fromEntries(Object.entries(room.players).map(([k, v]) => [k, publicPlayer(v)])),
      teamScore: room.teamScore, scoreLimit: SCORE_LIMIT,
      weapons: WEAPONS, order: WEAPON_ORDER, shieldHp: SHIELD_HP,
    });
    socket.to(code).emit('playerJoined', publicPlayer(me));
    io.to(code).emit('scoreboard', scoreboard(room));
    sendStatus(me, socket);
  }

  socket.on('createRoom', (name) => {
    if (room) return;
    const code = makeCode(); createRoom(code); joinRoom(code, name);
  });
  socket.on('joinRoom', ({ code, name }) => {
    if (room) return;
    code = String(code || '').toUpperCase().trim();
    if (!rooms[code]) { socket.emit('joinError', 'Room not found'); return; }
    joinRoom(code, name);
  });

  socket.on('move', (d) => {
    if (!me || me.hp <= 0 || room.matchOver) return;
    if (![d.x, d.y, d.z, d.ry].every(Number.isFinite)) return;
    const now = Date.now();
    const dt = Math.max((now - me.lastMoveAt) / 1000, 0.01);
    me.lastMoveAt = now;
    const maxSpd = MAX_SPEED * (me.buffs.speed ? 1.5 : 1);
    if (Math.hypot(d.x - me.x, d.z - me.z) > maxSpd * dt + 1) {
      socket.emit('correct', { x: me.x, y: me.y, z: me.z }); return;
    }
    me.x = Math.max(-MAP + 1, Math.min(MAP - 1, d.x));
    me.y = EYE;
    me.z = Math.max(-MAP + 1, Math.min(MAP - 1, d.z));
    me.ry = d.ry;
    socket.to(room.code).emit('playerMoved', { id: me.id, x: me.x, y: me.y, z: me.z, ry: me.ry });
  });

  socket.on('switchWeapon', (w) => {
    if (!me || me.hp <= 0 || !WEAPONS[w] || me.weapon === w) return;
    me.weapon = w; me.reloading = false; me.reloadToken = (me.reloadToken || 0) + 1;
    me.lastShot = Date.now();
    sendStatus(me, socket);
    socket.to(room.code).emit('weaponChanged', { id: me.id, weapon: w });
  });

  socket.on('reload', () => { if (me) startReload(me, socket); });

  socket.on('shoot', (d) => {
    if (!me || me.hp <= 0 || room.matchOver || me.reloading) return;
    const W = WEAPONS[me.weapon], now = Date.now();
    if (now - me.lastShot < W.delay * 0.85) return;
    if (me.ammo[me.weapon] <= 0) { startReload(me, socket); return; }
    if (!d || ![d.dx, d.dy, d.dz].every(Number.isFinite)) return;

    me.lastShot = now;
    me.ammo[me.weapon]--;
    socket.emit('ammo', { ammo: me.ammo[me.weapon], mag: W.mag, reloading: false });

    const len = Math.hypot(d.dx, d.dy, d.dz) || 1;
    const base = { x: d.dx / len, y: d.dy / len, z: d.dz / len };
    const origin = { x: me.x, y: me.y, z: me.z };
    const dmgMult = me.buffs.double ? 2 : 1;
    const damageDealt = {}; // victimId -> { dmg, head }

    for (let i = 0; i < W.pellets; i++) {
      const dir = {
        x: base.x + (Math.random() - 0.5) * 2 * W.spread,
        y: base.y + (Math.random() - 0.5) * 2 * W.spread,
        z: base.z + (Math.random() - 0.5) * 2 * W.spread,
      };
      const l = Math.hypot(dir.x, dir.y, dir.z); dir.x /= l; dir.y /= l; dir.z /= l;

      let best = 150, hit = null, head = false;
      for (const o of OBSTACLES) { const t = rayBox(origin, dir, o.min, o.max); if (t !== null && t < best) best = t; }
      for (const p of Object.values(room.players)) {
        if (p.id === me.id || p.hp <= 0 || p.team === me.team) continue;
        const fy = p.y - EYE;
        const b = rayBox(origin, dir, { x: p.x - PLAYER_RADIUS, y: fy, z: p.z - PLAYER_RADIUS }, { x: p.x + PLAYER_RADIUS, y: fy + 1.4, z: p.z + PLAYER_RADIUS });
        const h = rayBox(origin, dir, { x: p.x - 0.25, y: fy + 1.4, z: p.z - 0.25 }, { x: p.x + 0.25, y: fy + PLAYER_HEIGHT, z: p.z + 0.25 });
        if (h !== null && h < best) { best = h; hit = p; head = true; }
        if (b !== null && b < best) { best = b; hit = p; head = false; }
      }
      const end = { x: origin.x + dir.x * best, y: origin.y + dir.y * best, z: origin.z + dir.z * best };
      io.to(room.code).emit('shotFired', { id: me.id, from: { x: origin.x, y: origin.y - 0.2, z: origin.z }, to: end });

      if (hit) {
        const dmg = W.damage * (head ? HEADSHOT_MULT : 1) * dmgMult;
        const rec = damageDealt[hit.id] || (damageDealt[hit.id] = { p: hit, dmg: 0, head: false });
        rec.dmg += dmg; rec.head = rec.head || head;
      }
    }

    for (const rec of Object.values(damageDealt)) {
      const v = rec.p; let dmg = rec.dmg;
      if (v.shield > 0) { const absorbed = Math.min(v.shield, dmg); v.shield -= absorbed; dmg -= absorbed; }
      v.hp -= dmg;
      socket.emit('hitConfirm', { headshot: rec.head });
      const vs = io.sockets.sockets.get(v.id);
      if (vs) sendStatus(v, vs);
      if (v.hp <= 0) handleKill(room, me, v, rec.head, W.name);
    }
    if (me.ammo[me.weapon] === 0) startReload(me, socket);
  });

  socket.on('disconnect', () => {
    if (!room) return;
    delete room.players[socket.id];
    io.to(room.code).emit('playerLeft', socket.id);
    io.to(room.code).emit('scoreboard', scoreboard(room));
    if (Object.keys(room.players).length === 0) {
      room.timers.forEach(clearTimeout); delete rooms[room.code];
    }
  });
});

function startReload(p, socket) {
  const W = WEAPONS[p.weapon];
  if (p.reloading || p.ammo[p.weapon] === W.mag || p.hp <= 0) return;
  p.reloading = true;
  const token = p.reloadToken = (p.reloadToken || 0) + 1;
  const w = p.weapon;
  socket.emit('ammo', { ammo: p.ammo[w], mag: W.mag, reloading: true });
  setTimeout(() => {
    if (p.reloadToken !== token || p.weapon !== w || p.hp <= 0) return;
    p.ammo[w] = W.mag; p.reloading = false;
    socket.emit('ammo', { ammo: p.ammo[w], mag: W.mag, reloading: false });
  }, W.reload);
}

function handleKill(room, killer, victim, headshot, weaponName) {
  killer.kills++; victim.deaths++; victim.streak = 0;
  victim.buffs = { speed: false, double: false }; victim.shield = 0;
  room.teamScore[killer.team]++;

  // Killstreak rewards
  killer.streak++;
  const reward = STREAKS[killer.streak];
  const ks = io.sockets.sockets.get(killer.id);
  if (reward) {
    if (reward === 'speed') killer.buffs.speed = true;
    if (reward === 'shield') killer.shield = SHIELD_HP;
    if (reward === 'double') killer.buffs.double = true;
    io.to(room.code).emit('streakAnnounce', { name: killer.name, team: killer.team, streak: killer.streak, reward });
  }
  if (ks) sendStatus(killer, ks);

  io.to(room.code).emit('killFeed', { killer: killer.name, kTeam: killer.team, victim: victim.name, vTeam: victim.team, headshot, weapon: weaponName });
  io.to(room.code).emit('teamScore', room.teamScore);
  io.to(room.code).emit('scoreboard', scoreboard(room));
  io.to(room.code).emit('playerDied', { id: victim.id });
  const vs = io.sockets.sockets.get(victim.id);
  if (vs) sendStatus(victim, vs);

  if (room.teamScore[killer.team] >= SCORE_LIMIT) {
    room.matchOver = true;
    io.to(room.code).emit('matchOver', { winner: killer.team });
    later(room, () => resetMatch(room), 8000);
    return;
  }
  later(room, () => {
    if (!room.players[victim.id] || room.matchOver) return;
    resetPlayerState(victim);
    Object.assign(victim, spawnPos(victim.team), { lastMoveAt: Date.now() });
    io.to(room.code).emit('respawn', { id: victim.id, x: victim.x, y: victim.y, z: victim.z });
    const s = io.sockets.sockets.get(victim.id); if (s) sendStatus(victim, s);
  }, RESPAWN_MS);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Running on port ' + PORT));
