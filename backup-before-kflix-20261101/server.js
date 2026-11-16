// MovieHub — a screening room for two.
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
 *   subtitles: { name, text } | null,
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
    room.subtitles = data.text ? { name: String(data.name || 'Subtitles').slice(0, 200), text: data.text } : null;
    socket.to(room.code).emit('subtitles', room.subtitles);
    broadcastRoom(room);
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
  server.listen(PORT, () => console.log(`MovieHub server running at http://localhost:${PORT}`));
}

module.exports = { server, rooms };
