const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { pipeline } = require('stream/promises');
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moviehub-'));
process.on('exit', () => fs.rmSync(uploadDir, { recursive: true, force: true }));
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 20 * 1024 ** 3;

const app = express();
const server = http.createServer(app);

// ===== Configuration =====
const JWT_SECRET = process.env.JWT_SECRET || 'moviehub-dev-secret-' + crypto.randomBytes(8).toString('hex');
const JWT_EXPIRY = '24h';
const TURN_TTL = 24 * 3600; // 24 hours

// Configure Socket.io with CORS for extension support
const io = new Server(server, {
  maxHttpBufferSize: 1e8,
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false
  }
});

// ===== Middleware =====
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-File-Name');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ===== JWT Helpers =====
function generateToken(userId, nickname) {
  return jwt.sign(
    { userId, nickname, iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// ===== ICE Server Config =====
function getIceServers(userId) {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ];

  // Static credentials and coturn shared-secret credentials are separate modes.
  if (process.env.TURN_URL) {
    const urls = process.env.TURN_URL.split(',').map(url => url.trim());
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

// ===== REST API Endpoints =====

// POST /api/auth/token — Generate a JWT for a new or returning user
app.post('/api/auth/token', (req, res) => {
  const userId = crypto.randomUUID();
  const nickname = req.body.nickname || '';
  const token = generateToken(userId, nickname);
  console.log(`[Auth] Token issued for user ${userId}`);
  res.json({ token, userId });
});

// POST /api/auth/refresh — Refresh an expiring token
app.post('/api/auth/refresh', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const oldToken = authHeader.split(' ')[1];
  // Allow expired tokens to be refreshed (within reason)
  try {
    const decoded = jwt.verify(oldToken, JWT_SECRET, { ignoreExpiration: true });
    const newToken = generateToken(decoded.userId, decoded.nickname);
    console.log(`[Auth] Token refreshed for user ${decoded.userId}`);
    res.json({ token: newToken, userId: decoded.userId });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// GET /api/turn-credentials — Get time-limited TURN credentials (requires auth)
app.get('/api/turn-credentials', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const iceServers = getIceServers(decoded.userId);
  res.json({ iceServers, ttl: TURN_TTL });
});

// ===== Room Storage =====
const rooms = new Map();
function mediaInfo(code, room) {
  return room.media ? { url: `/api/rooms/${code}/video?key=${room.media.key}`, name: room.media.name } : null;
}
function playbackInfo(room) {
  const state = room.playback || { time: 0, paused: true, updatedAt: Date.now() };
  return { ...state, time: state.time + (state.paused ? 0 : (Date.now() - state.updatedAt) / 1000) };
}
function deleteRoom(code) {
  const room = rooms.get(code);
  if (room?.media) fs.rm(room.media.path, { force: true }, () => {});
  rooms.delete(code);
}
app.post('/api/rooms/:code/video', async (req, res) => {
  const room = rooms.get(req.params.code);
  const identity = verifyToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!identity || !room || room.hostUserId !== identity.userId) return res.status(403).json({ error: 'Only the host can upload' });
  if (room.uploading) return res.status(409).json({ error: 'An upload is already in progress' });
  const size = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'Invalid file size or upload limit exceeded' });
  room.uploading = true;
  const destination = path.join(uploadDir, crypto.randomUUID());
  let received = 0;
  req.on('data', chunk => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) req.destroy();
  });
  try {
    await pipeline(req, fs.createWriteStream(destination, { flags: 'wx' }));
    if (rooms.get(req.params.code) !== room || received !== size) throw new Error('Room closed or incomplete upload');
    if (room.media) fs.rm(room.media.path, { force: true }, () => {});
    room.media = { path: destination, key: crypto.randomBytes(24).toString('hex'), name: String(req.headers['x-file-name'] || 'Movie').slice(0, 500), type: /^video\/[a-z0-9.+-]+$/i.test(req.headers['content-type'] || '') ? req.headers['content-type'] : 'video/mp4' };
    room.playback = { time: 0, paused: true, updatedAt: Date.now() };
    const result = { media: mediaInfo(req.params.code, room), playback: playbackInfo(room) };
    io.to(req.params.code).emit('media-ready', result);
    res.json(result);
  } catch (error) {
    fs.rm(destination, { force: true }, () => {});
    if (!res.destroyed) res.status(400).json({ error: 'Upload failed. Please retry.' });
  } finally { room.uploading = false; }
});
app.get('/api/rooms/:code/video', (req, res) => {
  const media = rooms.get(req.params.code)?.media;
  if (!media || req.query.key !== media.key) return res.sendStatus(404);
  res.set('Content-Type', media.type);
  res.set('Cache-Control', 'private, no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.sendFile(media.path); // Express supports byte ranges, HEAD and 416 responses.
});

// Available avatars
const AVATARS = ['🎬', '🍿', '🎥', '📺', '🎞️', '🎭', '🌟', '🚀', '🔥', '💎', '🎮', '🎧'];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function generateNickname() {
  const adjectives = ['Happy', 'Cool', 'Swift', 'Chill', 'Epic', 'Awesome'];
  const nouns = ['Viewer', 'Watcher', 'Fan', 'Guest', 'Buddy', 'Friend'];
  return adjectives[Math.floor(Math.random() * adjectives.length)] +
    nouns[Math.floor(Math.random() * nouns.length)];
}

// ===== Socket.io Auth Middleware =====
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;

  if (!token) {
    // Allow unauthenticated connections for backward compat, but mark them
    socket.userId = socket.id;
    socket.authenticated = false;
    console.log(`[Auth] Unauthenticated connection: ${socket.id}`);
    return next();
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    console.log(`[Auth] Invalid token rejected: ${socket.id}`);
    return next(new Error('AUTH_INVALID_TOKEN'));
  }

  socket.userId = decoded.userId;
  socket.tokenNickname = decoded.nickname;
  socket.authenticated = true;
  console.log(`[Auth] Authenticated connection: ${decoded.userId} (${socket.id})`);
  next();
});

// ===== Socket.io Connection Handler =====
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id} (userId: ${socket.userId}, auth: ${socket.authenticated})`);

  let currentRoom = null;
  let isHost = false;
  let userInfo = null;

  // Create a new room
  socket.on('create-room', (options, callback = () => {}) => {
    if (currentRoom) return callback({ success: false, error: 'Leave the current room first' });
    let roomCode;
    do { roomCode = generateRoomCode(); } while (rooms.has(roomCode));
    const nickname = options?.nickname || socket.tokenNickname || generateNickname();
    const avatar = AVATARS.includes(options?.avatar) ? options.avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];

    userInfo = {
      id: socket.userId,
      socketId: socket.id,
      nickname,
      avatar,
      isHost: true,
      authenticated: socket.authenticated,
      connectionState: 'connected',
      joinedAt: Date.now()
    };

    rooms.set(roomCode, {
      host: socket.id,
      hostUserId: socket.userId,
      guest: null,
      guestUserId: null,
      participants: new Map([[socket.userId, userInfo]]),
      messages: [],
      mode: options?.mode || 'upload',
      createdAt: Date.now()
    });

    socket.join(roomCode);
    currentRoom = roomCode;
    isHost = true;

    const iceServers = getIceServers(socket.userId);

    console.log(`Room created: ${roomCode} by ${nickname} (${socket.userId})`);
    callback({
      success: true,
      roomCode,
      isHost: true,
      userInfo,
      participants: Array.from(rooms.get(roomCode).participants.values()),
      avatars: AVATARS,
      iceServers,
      authenticated: socket.authenticated
    });
  });

  // Join an existing room
  socket.on('join-room', (data, callback = () => {}) => {
    if (currentRoom) return callback({ success: false, error: 'Leave the current room first' });
    const code = String(typeof data === 'string' ? data : data?.roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    if (room.hostUserId === socket.userId || room.guest) {
      callback({ success: false, error: 'Room is full' });
      return;
    }

    const nickname = data?.nickname || socket.tokenNickname || generateNickname();
    const avatar = AVATARS.includes(data?.avatar) ? data.avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];

    userInfo = {
      id: socket.userId,
      socketId: socket.id,
      nickname,
      avatar,
      isHost: false,
      authenticated: socket.authenticated,
      connectionState: 'waiting',
      joinedAt: Date.now()
    };

    room.guest = socket.id;
    room.guestUserId = socket.userId;
    room.participants.set(socket.userId, userInfo);
    socket.join(code);
    currentRoom = code;
    isHost = false;

    const participants = Array.from(room.participants.values());
    const iceServers = getIceServers(socket.userId);

    console.log(`User ${nickname} (${socket.userId}) joined room ${code}`);
    callback({
      success: true,
      roomCode: code,
      isHost: false,
      mode: room.mode,
      media: mediaInfo(code, room),
      playback: playbackInfo(room),
      userInfo,
      participants,
      iceServers,
      authenticated: socket.authenticated
    });

    // Notify host that guest joined with guest info
    io.to(room.host).emit('guest-joined', { userInfo, participants });
  });

  // Update user info (nickname/avatar)
  socket.on('update-user-info', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !userInfo) return;

    if (typeof data?.nickname === 'string') userInfo.nickname = data.nickname.slice(0, 60);
    if (AVATARS.includes(data?.avatar)) userInfo.avatar = data.avatar;
    room.participants.set(socket.userId, userInfo);

    socket.to(currentRoom).emit('user-updated', userInfo);
  });

  // Chat message
  socket.on('chat-message', (text) => {
    if (!currentRoom || !userInfo || typeof text !== 'string' || text.length > 4000) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const message = {
      id: Date.now() + '-' + socket.userId,
      userId: socket.userId,
      nickname: userInfo.nickname,
      avatar: userInfo.avatar,
      text: text,
      timestamp: Date.now()
    };

    room.messages.push(message);
    if (room.messages.length > 100) room.messages.shift();

    io.to(currentRoom).emit('chat-message', message);
    console.log(`[${currentRoom}] ${userInfo.nickname}: ${text}`);
  });

  // Emoji reaction
  socket.on('emoji-reaction', (emoji) => {
    if (!currentRoom || !userInfo) return;

    const reaction = {
      id: Date.now() + '-' + socket.userId,
      userId: socket.userId,
      nickname: userInfo.nickname,
      emoji: emoji,
      timestamp: Date.now()
    };

    io.to(currentRoom).emit('emoji-reaction', reaction);
    console.log(`[${currentRoom}] ${userInfo.nickname} reacted: ${emoji}`);
  });

  // Get participants list
  socket.on('get-participants', (callback = () => {}) => {
    if (!currentRoom) {
      callback({ success: false, participants: [] });
      return;
    }
    const room = rooms.get(currentRoom);
    if (!room) {
      callback({ success: false, participants: [] });
      return;
    }
    callback({ success: true, participants: Array.from(room.participants.values()) });
  });

  // Get chat history
  socket.on('get-messages', (callback = () => {}) => {
    if (!currentRoom) {
      callback({ success: false, messages: [] });
      return;
    }
    const room = rooms.get(currentRoom);
    if (!room) {
      callback({ success: false, messages: [] });
      return;
    }
    callback({ success: true, messages: room.messages });
  });

  // Subtitle sync
  socket.on('subtitle-sync', (subtitleData) => {
    if (!currentRoom || !isHost || typeof subtitleData?.content !== 'string' || subtitleData.content.length > 1024 * 1024 || typeof subtitleData.filename !== 'string') return;
    socket.to(currentRoom).emit('subtitle-sync', subtitleData);
  });

  // ===== WebRTC Signaling =====
  socket.on('rtc-offer', (offer) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('rtc-offer', offer);
  });

  socket.on('rtc-answer', (answer) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('rtc-answer', answer);
  });

  socket.on('rtc-ice-candidate', (candidate) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('rtc-ice-candidate', candidate);
  });

  // ICE restart / renegotiation request
  socket.on('rtc-renegotiate', (data) => {
    if (!currentRoom) return;
    console.log(`[${currentRoom}] Renegotiation requested by ${socket.userId}`);
    socket.to(currentRoom).emit('rtc-renegotiate', data);
  });

  // Connection state sync — update participant state and broadcast audience
  socket.on('rtc-connection-state', (state) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room && userInfo) {
      userInfo.connectionState = state;
      room.participants.set(socket.userId, userInfo);
      // Broadcast updated audience to all in room
      const participants = Array.from(room.participants.values());
      io.to(currentRoom).emit('audience-update', { participants });
    }
    socket.to(currentRoom).emit('rtc-connection-state', {
      userId: socket.userId,
      state
    });
  });

  // Request fresh ICE servers mid-session
  socket.on('get-ice-servers', (callback = () => {}) => {
    const iceServers = getIceServers(socket.userId);
    callback({ iceServers });
  });

  // Stream starting notification
  socket.on('stream-starting', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('stream-starting');
  });

  // Only the host can publish the authoritative movie timeline.
  for (const event of ['play', 'pause', 'seek', 'time-sync']) {
    socket.on(event, time => {
      const room = rooms.get(currentRoom);
      if (!room || room.host !== socket.id || typeof time !== 'number' || !Number.isFinite(time) || time < 0) return;
      const previous = playbackInfo(room);
      room.playback = { time, paused: event === 'pause' ? true : event === 'play' ? false : previous.paused, updatedAt: Date.now() };
      socket.to(currentRoom).emit(event, time);
      socket.to(currentRoom).emit('playback-state', playbackInfo(room));
    });
  }

  socket.on('resume-room', (code, callback = () => {}) => {
    const room = rooms.get(code);
    if (!room || currentRoom) return callback({ success: false, error: 'Room no longer available' });
    isHost = room.hostUserId === socket.userId;
    if (!isHost && room.guestUserId !== socket.userId) return callback({ success: false, error: 'Not a room member' });
    const previousSocket = isHost ? room.host : room.guest;
    if (previousSocket && io.sockets.sockets.has(previousSocket)) return callback({ success: false, error: 'Already connected' });
    currentRoom = code;
    userInfo = room.participants.get(socket.userId);
    if (!userInfo) return callback({ success: false, error: 'Session expired' });
    userInfo.socketId = socket.id;
    userInfo.connectionState = 'connected';
    if (isHost) room.host = socket.id;
    else room.guest = socket.id;
    socket.join(code);
    callback({ success: true, media: mediaInfo(code, room), playback: playbackInfo(room) });
    io.to(code).emit('audience-update', { participants: Array.from(room.participants.values()) });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id} (userId: ${socket.userId})`);

    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        userInfo.connectionState = 'disconnected';
        socket.to(currentRoom).emit('peer-disconnected', { userId: socket.userId, userInfo, participants: Array.from(room.participants.values()) });
        const disconnectedRoom = currentRoom;
        const disconnectedSocket = socket.id;
        setTimeout(() => {
          if (rooms.get(disconnectedRoom) !== room) return;
          if (isHost && room.host === disconnectedSocket) {
            io.to(disconnectedRoom).emit('room-closed');
            deleteRoom(disconnectedRoom);
          } else if (!isHost && room.guest === disconnectedSocket) {
            room.participants.delete(socket.userId);
            room.guest = null;
            room.guestUserId = null;
          }
        }, 30000).unref();
      }
    }
  });
});

// ===== Cleanup stale rooms every 30 minutes =====
setInterval(() => {
  const now = Date.now();
  const STALE_THRESHOLD = 4 * 3600 * 1000; // 4 hours
  for (const [code, room] of rooms) {
    if (now - room.createdAt > STALE_THRESHOLD && room.participants.size === 0) {
      deleteRoom(code);
      console.log(`[Cleanup] Stale room ${code} removed`);
    }
  }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎬 MovieHub server running at http://localhost:${PORT}`);
  console.log(`🔐 JWT authentication enabled`);
  console.log(`🧊 ICE servers configured (STUN + TURN)`);
});
