// MovieHub Sync - Background Service Worker
// Handles Socket.io connection with JWT authentication

importScripts('lib/socket.io.min.js');

const SERVER_URL = 'https://caf74847da69.ngrok-free.app';

let socket = null;
let currentRoom = null;
let isHost = false;
let authToken = null;
let userId = null;
let iceServers = null;

// ===== JWT Authentication =====
async function authenticate() {
    // Check for stored token
    const stored = await chrome.storage.local.get(['authToken', 'userId']);
    if (stored.authToken) {
        try {
            const payload = JSON.parse(atob(stored.authToken.split('.')[1]));
            const expiry = payload.exp * 1000;
            if (Date.now() < expiry - 60000) {
                authToken = stored.authToken;
                userId = stored.userId;
                console.log('[MovieHub BG] Using stored token for user:', userId);
                return;
            }
            // Token expiring — refresh
            console.log('[MovieHub BG] Token expiring, refreshing...');
            await refreshToken(stored.authToken);
            return;
        } catch (e) {
            console.log('[MovieHub BG] Stored token invalid, fetching new one');
        }
    }
    await fetchNewToken();
}

async function fetchNewToken() {
    try {
        const res = await fetch(`${SERVER_URL}/api/auth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await res.json();
        authToken = data.token;
        userId = data.userId;
        await chrome.storage.local.set({ authToken, userId });
        console.log('[MovieHub BG] New token obtained for user:', userId);
    } catch (err) {
        console.error('[MovieHub BG] Failed to get token:', err);
    }
}

async function refreshToken(oldToken) {
    try {
        const res = await fetch(`${SERVER_URL}/api/auth/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${oldToken}`
            }
        });
        if (res.ok) {
            const data = await res.json();
            authToken = data.token;
            userId = data.userId;
            await chrome.storage.local.set({ authToken, userId });
            console.log('[MovieHub BG] Token refreshed');
        } else {
            await fetchNewToken();
        }
    } catch (err) {
        console.error('[MovieHub BG] Refresh failed:', err);
        await fetchNewToken();
    }
}

async function fetchTurnCredentials() {
    if (!authToken) return;
    try {
        const res = await fetch(`${SERVER_URL}/api/turn-credentials`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            const data = await res.json();
            iceServers = data.iceServers;
            console.log('[MovieHub BG] Got', iceServers.length, 'ICE servers');
        } else if (res.status === 401) {
            await refreshToken(authToken);
            return fetchTurnCredentials();
        }
    } catch (err) {
        console.error('[MovieHub BG] Failed to fetch TURN credentials:', err);
        iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ];
    }
}

// ===== Socket Connection =====
async function connect() {
    if (socket && socket.connected) return;

    // Authenticate first
    await authenticate();

    console.log('[MovieHub BG] Connecting to', SERVER_URL);

    socket = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        auth: { token: authToken },
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
    });

    socket.on('connect', () => {
        console.log('[MovieHub BG] Connected (authenticated)');
        broadcastToTabs({ type: 'CONNECTED' });
    });

    socket.on('connect_error', async (err) => {
        if (err.message === 'AUTH_INVALID_TOKEN') {
            console.log('[MovieHub BG] Auth failed, refreshing token...');
            await fetchNewToken();
            socket.auth = { token: authToken };
            socket.connect();
        } else {
            console.error('[MovieHub BG] Error:', err.message);
            broadcastToTabs({ type: 'ERROR', message: 'Connection failed' });
        }
    });

    socket.on('guest-joined', () => {
        console.log('[MovieHub BG] Guest joined');
        broadcastToTabs({ type: 'GUEST_JOINED' });
    });

    socket.on('play', (time) => broadcastToTabs({ type: 'PLAY', time }));
    socket.on('pause', (time) => broadcastToTabs({ type: 'PAUSE', time }));
    socket.on('seek', (time) => broadcastToTabs({ type: 'SEEK', time }));
    socket.on('time-sync', (time) => broadcastToTabs({ type: 'TIME_SYNC', time }));
    socket.on('peer-disconnected', () => broadcastToTabs({ type: 'PEER_LEFT' }));

    // WebRTC signaling relay to content script
    socket.on('rtc-offer', (offer) => broadcastToTabs({ type: 'RTC_OFFER', offer }));
    socket.on('rtc-answer', (answer) => broadcastToTabs({ type: 'RTC_ANSWER', answer }));
    socket.on('rtc-ice-candidate', (candidate) => broadcastToTabs({ type: 'RTC_ICE_CANDIDATE', candidate }));
    socket.on('rtc-renegotiate', (data) => broadcastToTabs({ type: 'RTC_RENEGOTIATE', data }));
    socket.on('stream-starting', () => broadcastToTabs({ type: 'STREAM_STARTING' }));

    socket.on('disconnect', () => {
        console.log('[MovieHub BG] Disconnected');
    });
}

function broadcastToTabs(message) {
    chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
            if (tab.url && (
                tab.url.includes('youtube.com') ||
                tab.url.includes('netflix.com') ||
                tab.url.includes('primevideo.com') ||
                tab.url.includes('disneyplus.com') ||
                tab.url.includes('hotstar.com')
            )) {
                chrome.tabs.sendMessage(tab.id, message).catch(() => { });
            }
        }
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[MovieHub BG] Message:', message.type);

    if (message.type === 'CREATE_ROOM') {
        connect().then(async () => {
            // Fetch TURN credentials before room creation
            await fetchTurnCredentials();

            setTimeout(() => {
                if (socket && socket.connected) {
                    socket.emit('create-room', { mode: 'extension' }, (response) => {
                        console.log('[MovieHub BG] Create response:', response);
                        if (response && response.success) {
                            currentRoom = response.roomCode;
                            isHost = true;
                            // Store ICE servers from response
                            if (response.iceServers) {
                                iceServers = response.iceServers;
                            }
                            chrome.storage.local.set({
                                roomCode: currentRoom,
                                isHost: true
                            });
                        }
                        sendResponse({
                            ...response,
                            iceServers,
                            authenticated: !!authToken
                        });
                    });
                } else {
                    sendResponse({ success: false, error: 'Not connected' });
                }
            }, 1000);
        });
        return true;
    }

    if (message.type === 'JOIN_ROOM') {
        connect().then(async () => {
            await fetchTurnCredentials();

            setTimeout(() => {
                if (socket && socket.connected) {
                    socket.emit('join-room', message.roomCode, (response) => {
                        console.log('[MovieHub BG] Join response:', response);
                        if (response && response.success) {
                            currentRoom = message.roomCode;
                            isHost = false;
                            if (response.iceServers) {
                                iceServers = response.iceServers;
                            }
                            chrome.storage.local.set({
                                roomCode: currentRoom,
                                isHost: false
                            });
                        }
                        sendResponse({
                            ...response,
                            iceServers,
                            authenticated: !!authToken
                        });
                    });
                } else {
                    sendResponse({ success: false, error: 'Not connected' });
                }
            }, 1000);
        });
        return true;
    }

    if (message.type === 'LEAVE_ROOM') {
        if (socket) socket.disconnect();
        socket = null;
        currentRoom = null;
        chrome.storage.local.remove(['roomCode', 'isHost']);
        sendResponse({ success: true });
        return;
    }

    // WebRTC signaling from content script → server
    if (message.type === 'EMIT_RTC_OFFER' && socket) socket.emit('rtc-offer', message.offer);
    if (message.type === 'EMIT_RTC_ANSWER' && socket) socket.emit('rtc-answer', message.answer);
    if (message.type === 'EMIT_RTC_ICE_CANDIDATE' && socket) socket.emit('rtc-ice-candidate', message.candidate);
    if (message.type === 'EMIT_RTC_RENEGOTIATE' && socket) socket.emit('rtc-renegotiate', message.data);
    if (message.type === 'EMIT_STREAM_STARTING' && socket) socket.emit('stream-starting');

    // Playback sync
    if (message.type === 'EMIT_PLAY' && socket) socket.emit('play', message.time);
    if (message.type === 'EMIT_PAUSE' && socket) socket.emit('pause', message.time);
    if (message.type === 'EMIT_SEEK' && socket) socket.emit('seek', message.time);
    if (message.type === 'EMIT_TIME_SYNC' && socket) socket.emit('time-sync', message.time);

    if (message.type === 'GET_STATUS') {
        sendResponse({
            connected: socket && socket.connected,
            roomCode: currentRoom,
            isHost: isHost,
            authenticated: !!authToken,
            iceServers: iceServers
        });
        return true;
    }

    if (message.type === 'GET_ICE_SERVERS') {
        fetchTurnCredentials().then(() => {
            sendResponse({ iceServers });
        });
        return true;
    }
});

console.log('[MovieHub BG] Service worker ready (JWT + WebRTC)');
