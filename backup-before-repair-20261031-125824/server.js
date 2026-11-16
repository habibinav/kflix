const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// ===== Configuration =====
const JWT_SECRET = process.env.JWT_SECRET || 'moviehub-dev-secret-' + crypto.randomBytes(8).toString('hex');
const JWT_EXPIRY = '24h';
const TURN_SECRET = process.env.TURN_SECRET || 'moviehub-turn-secret';
const TURN_TTL = 24 * 3600; // 24 hours

// Metered.ca free TURN (fallback) — replace with your own for production
const METERED_TURN_URL = process.env.TURN_URL || 'turn:a.]relay.metered.ca:443';
const METERED_TURN_USER = process.env.TURN_USER || '';
const METERED_TURN_PASS = process.env.TURN_PASS || '';

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
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

  // Generate time-limited TURN credentials using shared-secret auth (RFC 5766)
  const timestamp = Math.floor(Date.now() / 1000) + TURN_TTL;
  const turnUsername = `${timestamp}:${userId}`;
  const turnPassword = crypto
    .createHmac('sha1', TURN_SECRET)
    .update(turnUsername)
    .digest('base64');

  // Self-hosted coturn (if TURN_URL env is a real coturn)
  if (process.env.TURN_URL) {
    servers.push(
      { urls: process.env.TURN_URL, username: turnUsername, credential: turnPassword },
      { urls: process.env.TURN_URL.replace('turn:', 'turns:'), username: turnUsername, credential: turnPassword }
    );
  }

  // Metered.ca free tier (if configured)
  if (METERED_TURN_USER && METERED_TURN_PASS) {
    servers.push(
      { urls: 'stun:a.relay.metered.ca:80' },
      { urls: 'turn:a.relay.metered.ca:80', username: METERED_TURN_USER, credential: METERED_TURN_PASS },
      { urls: 'turn:a.relay.metered.ca:80?transport=tcp', username: METERED_TURN_USER, credential: METERED_TURN_PASS },
      { urls: 'turn:a.relay.metered.ca:443', username: METERED_TURN_USER, credential: METERED_TURN_PASS },
      { urls: 'turns:a.relay.metered.ca:443?transport=tcp', username: METERED_TURN_USER, credential: METERED_TURN_PASS }
    );
  }

  // Always include a free public TURN as ultimate fallback
  servers.push(
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  );

  return servers;
}

// ===== REST API Endpoints =====

// POST /api/auth/token — Generate a JWT for a new or returning user
app.post('/api/auth/token', (req, res) => {
  const userId = req.body.userId || crypto.randomUUID();
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
  socket.on('create-room', (options, callback) => {
    const roomCode = generateRoomCode();
    const nickname = options?.nickname || socket.tokenNickname || generateNickname();
    const avatar = options?.avatar || AVATARS[Math.floor(Math.random() * AVATARS.length)];

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
  socket.on('join-room', (data, callback) => {
    const code = (typeof data === 'string' ? data : data.roomCode).toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    if (room.guest) {
      callback({ success: false, error: 'Room is full' });
      return;
    }

    const nickname = data?.nickname || socket.tokenNickname || generateNickname();
    const avatar = data?.avatar || AVATARS[Math.floor(Math.random() * AVATARS.length)];

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

    if (data.nickname) userInfo.nickname = data.nickname;
    if (data.avatar) userInfo.avatar = data.avatar;
    room.participants.set(socket.userId, userInfo);

    socket.to(currentRoom).emit('user-updated', userInfo);
  });

  // Chat message
  socket.on('chat-message', (text) => {
    if (!currentRoom || !userInfo) return;
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
  socket.on('get-participants', (callback) => {
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
  socket.on('get-messages', (callback) => {
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
    if (!currentRoom) return;
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
  socket.on('get-ice-servers', (callback) => {
    const iceServers = getIceServers(socket.userId);
    callback({ iceServers });
  });

  // Stream starting notification
  socket.on('stream-starting', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('stream-starting');
  });

  // Playback sync events
  socket.on('play', (time) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('play', time);
    console.log(`[${currentRoom}] Play at ${time}`);
  });

  socket.on('pause', (time) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('pause', time);
    console.log(`[${currentRoom}] Pause at ${time}`);
  });

  socket.on('seek', (time) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('seek', time);
    console.log(`[${currentRoom}] Seek to ${time}`);
  });

  socket.on('time-sync', (time) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('time-sync', time);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id} (userId: ${socket.userId})`);

    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.participants.delete(socket.userId);

        const participants = Array.from(room.participants.values());
        socket.to(currentRoom).emit('peer-disconnected', {
          userId: socket.userId,
          userInfo,
          participants
        });

        if (room.host === socket.id) {
          rooms.delete(currentRoom);
          console.log(`Room ${currentRoom} deleted (host left)`);
        } else {
          room.guest = null;
          room.guestUserId = null;
          room.guestReady = false;
        }
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
      rooms.delete(code);
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
