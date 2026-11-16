// Kflix — a screening room for two.
// The server never sees the movie. It only hands out identities, keeps the
// shared timeline, relays chat, and relays WebRTC signaling between the two
// browsers. The film itself plays from the dropper's disk and streams
// peer-to-peer (or each person plays their own copy, kept in sync).

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const fs = require('fs');

// Tiny .env loader (KEY=value lines), so a TMDB key can live next to the code.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TURN_TTL = 24 * 3600;
const MEMBER_GRACE_MS = 60_000; // how long a dropped connection keeps its seat
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: MAX_SUBTITLE_BYTES + 64 * 1024 });

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- identity ----------
const sign = userId => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
const verify = token => { try { return jwt.verify(token, JWT_SECRET); } catch { return null; } };

app.post('/api/identity', (req, res) => {
  const existing = verify(String(req.body?.token || ''));
  const userId = existing?.userId || crypto.randomUUID();
  res.json({ token: sign(userId), userId });
});

// ---------- artwork (TMDB) ----------
// Posters and backdrops come from The Movie Database API. Without a key the
// app still works; the lobby falls back to a wall of titles in type.
const TMDB_API = process.env.TMDB_API_BASE || 'https://api.themoviedb.org/3';
const TMDB_IMG = process.env.TMDB_IMAGE_BASE || 'https://image.tmdb.org/t/p';
const tmdbEnabled = () => Boolean(process.env.TMDB_API_KEY || process.env.TMDB_READ_TOKEN);
const artCache = new Map(); // key -> { at, value }

async function tmdb(pathname, params = {}) {
  const url = new URL(TMDB_API + pathname);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  const headers = { accept: 'application/json' };
  if (process.env.TMDB_READ_TOKEN) headers.authorization = `Bearer ${process.env.TMDB_READ_TOKEN}`;
  else url.searchParams.set('api_key', process.env.TMDB_API_KEY);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

async function cached(key, ttlMs, fn) {
  const hit = artCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  artCache.set(key, { at: Date.now(), value });
  if (artCache.size > 500) artCache.delete(artCache.keys().next().value);
  return value;
}

app.get('/api/posters', async (req, res) => {
  if (!tmdbEnabled()) return res.json({ enabled: false, reason: 'no-key', posters: [] });
  try {
    const posters = await cached('wall', 12 * 3600e3, async () => {
      const lists = await Promise.allSettled([
        ...[1, 2, 3, 4].map(page => tmdb('/movie/top_rated', { page })),
        ...[1, 2].map(page => tmdb('/movie/popular', { page }))
      ]);
      const seen = new Set(), out = [];
      for (const l of lists) for (const m of l.value?.results || []) {
        if (!m.poster_path || seen.has(m.id)) continue;
        seen.add(m.id);
        out.push({ title: m.title, year: (m.release_date || '').slice(0, 4), poster: `/api/img/w342${m.poster_path}` });
      }
      if (!out.length) throw new Error('no posters');
      return out;
    });
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ enabled: true, posters });
  } catch (err) {
    console.warn('[tmdb] posters:', err.message);
    res.json({ enabled: false, reason: /401/.test(err.message) ? 'bad-key' : 'unreachable', posters: [] });
  }
});

// Images are fetched through this server, so a viewer whose network blocks
// image.tmdb.org (some ISPs do) still sees them.
app.get('/api/img/:size/:file', async (req, res) => {
  const { size, file } = req.params;
  if (!['w342', 'w500', 'w1280'].includes(size) || !/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|svg)$/.test(file)) return res.sendStatus(404);
  try {
    const upstream = await fetch(`${TMDB_IMG}/${size}/${file}`, { signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) return res.sendStatus(upstream.status === 404 ? 404 : 502);
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.sendStatus(502);
  }
});

app.get('/api/art', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  const year = /^\d{4}$/.test(req.query.year) ? req.query.year : '';
  if (!tmdbEnabled() || !q) return res.json({ found: false });
  try {
    const art = await cached(`art:${q.toLowerCase()}:${year}`, 24 * 3600e3, async () => {
      let r = await tmdb('/search/movie', { query: q, year, include_adult: 'false' });
      if (!r.results?.length && year) r = await tmdb('/search/movie', { query: q, include_adult: 'false' });
      const m = (r.results || []).find(x => x.backdrop_path || x.poster_path);
      if (!m) return { found: false };
      return {
        found: true,
        title: m.title,
        year: (m.release_date || '').slice(0, 4),
        overview: m.overview || '',
        poster: m.poster_path ? `/api/img/w500${m.poster_path}` : null,
        backdrop: m.backdrop_path ? `/api/img/w1280${m.backdrop_path}` : null
      };
    });
    res.json(art);
  } catch (err) {
    console.warn('[tmdb] art:', err.message);
    res.json({ found: false });
  }
});

// ---------- ICE ----------
function iceServers(userId) {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    const urls = process.env.TURN_URL.split(',').map(s => s.trim()).filter(Boolean);
    if (process.env.TURN_USER && process.env.TURN_PASS) {
      servers.push({ urls, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
    } else if (process.env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${userId}`;
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
      servers.push({ urls, username, credential });
    }
  }
  return servers;
}

// ---------- rooms ----------
/**
 * room = {
 *   code, createdAt,
 *   members: Map<userId, { id, name, socketId, connected, mode, leaveTimer }>,
 *   sourceId, movie: { name, size, duration } | null,
 *   playback: { time, paused, at },
 *   subtitles: { name, text, offset, by } | null,
 *   messages: []
 * }
 * mode: 'none' (no film yet) | 'stream' (receiving the source's stream) | 'local' (playing own copy)
 */
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  } while (rooms.has(code));
  return code;
}

const cleanName = name => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Guest';

function currentPlayback(room) {
  const p = room.playback;
  const time = p.paused ? p.time : p.time + (Date.now() - p.at) / 1000;
  const capped = room.movie?.duration ? Math.min(time, room.movie.duration) : time;
  return { time: capped, paused: p.paused, at: Date.now() };
}

function snapshot(room) {
  return {
    code: room.code,
    sourceId: room.sourceId,
    movie: room.movie,
    playback: currentPlayback(room),
    hasSubtitles: Boolean(room.subtitles),
    members: [...room.members.values()].map(m => ({ id: m.id, name: m.name, connected: m.connected, mode: m.mode }))
  };
}

const broadcastRoom = room => io.to(room.code).emit('room', snapshot(room));

function removeMember(room, userId) {
  const member = room.members.get(userId);
  if (!member) return;
  clearTimeout(member.leaveTimer);
  room.members.delete(userId);
  if (room.members.size === 0) { rooms.delete(room.code); return; }
  if (room.sourceId === userId) {
    // The film lived on the leaver's disk. Keep the timeline, drop the source.
    room.sourceId = null;
    for (const m of room.members.values()) if (m.mode === 'stream') m.mode = 'none';
  }
  broadcastRoom(room);
}

// ---------- sockets ----------
io.use((socket, next) => {
  const identity = verify(socket.handshake.auth?.token);
  if (!identity) return next(new Error('AUTH'));
  socket.data.userId = identity.userId;
  next();
});

io.on('connection', socket => {
  const userId = socket.data.userId;
  let room = null;

  const me = () => room?.members.get(userId);
  const other = () => room && [...room.members.values()].find(m => m.id !== userId);
  const ack = fn => (typeof fn === 'function' ? fn : () => {});

  function enter(target, name, cb) {
    let member = target.members.get(userId);
    if (!member) {
      if (target.members.size >= 2) return cb({ ok: false, error: 'This room already has two people in it.' });
      member = { id: userId, name: cleanName(name), mode: 'none' };
      target.members.set(userId, member);
      if (target.movie && target.sourceId) member.mode = 'stream';
    } else if (name) {
      member.name = cleanName(name);
    }
    if (member.socketId && member.socketId !== socket.id) io.sockets.sockets.get(member.socketId)?.disconnect(true);
    clearTimeout(member.leaveTimer);
    member.socketId = socket.id;
    member.connected = true;
    room = target;
    socket.join(target.code);
    cb({
      ok: true,
      you: userId,
      iceServers: iceServers(userId),
      room: snapshot(target),
      subtitles: target.subtitles,
      messages: target.messages.slice(-50)
    });
    socket.to(target.code).emit('room', snapshot(target));
  }

  socket.on('create', (data, cb) => {
    cb = ack(cb);
    if (room) return cb({ ok: false, error: 'Already in a room.' });
    const code = newCode();
    const created = { code, createdAt: Date.now(), members: new Map(), sourceId: null, movie: null, playback: { time: 0, paused: true, at: Date.now() }, subtitles: null, messages: [] };
    rooms.set(code, created);
    enter(created, data?.name, cb);
  });

  socket.on('join', (data, cb) => {
    cb = ack(cb);
    if (room) return cb({ ok: false, error: 'Already in a room.' });
    const target = rooms.get(String(data?.code || '').trim().toUpperCase());
    if (!target) return cb({ ok: false, error: 'No room with that code. It may have closed.' });
    enter(target, data?.name, cb);
  });

  socket.on('leave', (...args) => {
    if (room) { socket.leave(room.code); removeMember(room, userId); room = null; }
    ack(args.find(a => typeof a === 'function'))({ ok: true });
  });

  // The dropper announces their film. They become the source.
  socket.on('movie', (data, cb) => {
    cb = ack(cb);
    const m = me();
    const size = Number(data?.size);
    if (!m || !Number.isSafeInteger(size) || size <= 0) return cb({ ok: false });
    const duration = Number(data?.duration);
    const sameFilm = room.movie && room.movie.size === size;
    room.movie = { name: String(data?.name || 'Untitled').slice(0, 300), size, duration: Number.isFinite(duration) && duration > 0 ? duration : null };
    room.sourceId = userId;
    m.mode = 'local';
    if (!sameFilm) room.playback = { time: 0, paused: true, at: Date.now() };
    for (const peer of room.members.values()) {
      if (peer.id !== userId && !(sameFilm && peer.mode === 'local')) peer.mode = 'stream';
    }
    broadcastRoom(room);
    cb({ ok: true, room: snapshot(room) });
  });

  socket.on('mode', mode => {
    const m = me();
    if (!m || !['stream', 'local', 'none'].includes(mode)) return;
    m.mode = mode;
    broadcastRoom(room);
  });

  // Anyone can play, pause or seek. Everyone else follows.
  socket.on('control', data => {
    const m = me();
    const time = Number(data?.time);
    if (!m || !room.movie || !['play', 'pause', 'seek'].includes(data?.action) || !Number.isFinite(time) || time < 0) return;
    const paused = data.action === 'play' ? false : data.action === 'pause' ? true : currentPlayback(room).paused;
    room.playback = { time, paused, at: Date.now() };
    socket.to(room.code).emit('control', { action: data.action, time, paused, by: m.name, at: Date.now() });
  });

  // The source reports its clock about once a second; it's the reference.
  socket.on('tick', data => {
    const time = Number(data?.time);
    if (!room || room.sourceId !== userId || !Number.isFinite(time) || time < 0) return;
    room.playback = { time, paused: Boolean(data.paused), at: Date.now() };
    socket.to(room.code).emit('tick', { time, paused: Boolean(data.paused), buffering: Boolean(data.buffering) });
  });

  socket.on('signal', data => {
    const peer = other();
    if (peer?.connected) io.to(peer.socketId).emit('signal', data);
  });

  socket.on('subtitles', data => {
    if (!me() || typeof data?.text !== 'string' || data.text.length > MAX_SUBTITLE_BYTES) return;
    room.subtitles = data.text ? { name: String(data.name || 'Subtitles').slice(0, 200), text: data.text, offset: 0, by: me().name } : null;
    socket.to(room.code).emit('subtitles', room.subtitles);
    broadcastRoom(room);
  });

  // Timing correction for the shared track, in seconds (positive = later).
  socket.on('subtitle-offset', value => {
    const offset = Math.round(Number(value) * 100) / 100;
    if (!me() || !room.subtitles || !Number.isFinite(offset) || Math.abs(offset) > 600) return;
    room.subtitles.offset = offset;
    socket.to(room.code).emit('subtitle-offset', { offset, by: me().name });
  });

  socket.on('chat', text => {
    const m = me();
    if (!m || typeof text !== 'string') return;
    text = text.trim().slice(0, 1000);
    if (!text) return;
    const message = { id: crypto.randomUUID(), from: userId, name: m.name, text, at: Date.now() };
    room.messages.push(message);
    if (room.messages.length > 200) room.messages.shift();
    io.to(room.code).emit('chat', message);
  });

  socket.on('disconnect', () => {
    const m = me();
    if (!m || m.socketId !== socket.id) return;
    m.connected = false;
    const left = room;
    m.leaveTimer = setTimeout(() => removeMember(left, userId), MEMBER_GRACE_MS);
    m.leaveTimer.unref?.();
    broadcastRoom(left);
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Kflix server running at http://localhost:${PORT}${tmdbEnabled() ? '' : '  (no TMDB key: posters off, see README)'}`));
}

module.exports = { server, rooms };
