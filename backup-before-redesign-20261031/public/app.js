// ===== State =====
let socket;
let isHost = false;
let roomCode = null;
let peerConnection = null;
let videoFile = null;
let videoObjectURL = null;
let theatreMode = false;

// Authentication state
let authToken = null;
let userId = null;
let iceServers = null;

// User info
let userInfo = {
    nickname: '',
    avatar: '🎬'
};
let participants = [];
let pendingAction = null; // 'create' or 'join'

// Sync state
let isSyncing = false;
const SYNC_THRESHOLD = 0.5;

// Chat state
let chatOpen = false;

// WebRTC stats
let statsInterval = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let pendingIceCandidates = [];
let pendingPlayback = null;
let activeUpload = null;

// ===== DOM Elements =====
const lobbyView = document.getElementById('lobby-view');
const screeningView = document.getElementById('screening-view');

const createRoomBtn = document.getElementById('create-room-btn');
const joinRoomBtn = document.getElementById('join-room-btn');
const roomCodeInput = document.getElementById('room-code-input');
const displayRoomCode = document.getElementById('display-room-code');
const copyCodeBtn = document.getElementById('copy-code-btn');
const copyLinkBtn = document.getElementById('copy-link-btn');

const connectionDot = document.getElementById('connection-dot');

const hostDropZone = document.getElementById('host-drop-zone');
const guestWaiting = document.getElementById('guest-waiting');
const fileInput = document.getElementById('file-input');

const videoPlayer = document.getElementById('video-player');
const videoOverlay = document.getElementById('video-overlay');
const playPauseBtn = document.getElementById('play-pause-btn');
const skipBackBtn = document.getElementById('skip-back-btn');
const skipForwardBtn = document.getElementById('skip-forward-btn');
const seekBar = document.getElementById('seek-bar');
const currentTimeDisplay = document.getElementById('current-time');
const durationDisplay = document.getElementById('duration');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const syncIndicator = document.getElementById('sync-indicator');
const theatreBtn = document.getElementById('theatre-btn');

// Chat elements
const userSetupModal = document.getElementById('user-setup-modal');
const nicknameInput = document.getElementById('nickname-input');
const avatarGrid = document.getElementById('avatar-grid');
const setupContinueBtn = document.getElementById('setup-continue-btn');
const chatSidebar = document.getElementById('chat-sidebar');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat-btn');
const toggleChatBtn = document.getElementById('toggle-chat-btn');
const closeChatBtn = document.getElementById('close-chat-btn');
const participantsBar = document.getElementById('participants-bar');
const reactionOverlay = document.getElementById('reaction-overlay');

// Audience
const audiencePanel = document.getElementById('audience-panel');
const audienceList = document.getElementById('audience-list');

// Screening container
const screeningContainer = document.getElementById('screening-container');
const roomHeader = document.getElementById('room-header');

// ===== JWT Authentication =====
async function authenticate() {
    const stored = localStorage.getItem('moviehub_auth');
    if (stored) {
        try {
            const data = JSON.parse(stored);
            const payload = JSON.parse(atob(data.token.split('.')[1]));
            const expiry = payload.exp * 1000;
            if (Date.now() < expiry - 60000) {
                authToken = data.token;
                userId = data.userId;
                return;
            }
            await refreshToken(data.token);
            return;
        } catch (e) {
            localStorage.removeItem('moviehub_auth');
        }
    }
    await fetchNewToken();
}

async function fetchNewToken(nickname) {
    try {
        const res = await fetch('/api/auth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname: nickname || userInfo.nickname || '' })
        });
        const data = await res.json();
        authToken = data.token;
        userId = data.userId;
        localStorage.setItem('moviehub_auth', JSON.stringify({ token: authToken, userId }));
    } catch (err) {
        console.error('[Auth] Failed to get token:', err);
    }
}

async function refreshToken(oldToken) {
    try {
        const res = await fetch('/api/auth/refresh', {
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
            localStorage.setItem('moviehub_auth', JSON.stringify({ token: authToken, userId }));
        } else {
            await fetchNewToken();
        }
    } catch (err) {
        await fetchNewToken();
    }
}

async function fetchTurnCredentials() {
    if (!authToken) return;
    try {
        const res = await fetch('/api/turn-credentials', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            const data = await res.json();
            iceServers = data.iceServers;
        } else if (res.status === 401) {
            await refreshToken(authToken);
            return fetchTurnCredentials();
        }
    } catch (err) {
        console.error('[Auth] Failed to fetch TURN:', err);
        iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ];
    }
}

// ===== Initialize =====
async function init() {
    await authenticate();
    connectSocket();
    setupUIListeners();
}

function connectSocket() {
    socket = io({
        auth: { token: authToken },
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
    });

    socket.on('connect', () => {
        console.log('[Socket] Connected:', socket.id);
        if (roomCode) socket.emit('resume-room', roomCode, response => {
            if (!response.success) { resetState(); showView('lobby-view'); alert(response.error); return; }
            if (response.media) loadSharedMedia(response);
        });
    });

    socket.on('connect_error', async (err) => {
        if (err.message === 'AUTH_INVALID_TOKEN') {
            await fetchNewToken();
            socket.auth = { token: authToken };
            socket.connect();
        } else {
            console.error('[Socket] Connection error:', err.message);
        }
    });

    setupSocketListeners();
}

// ===== View Management =====
function showView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
}

// ===== Socket Listeners =====
function setupSocketListeners() {
    // Guest joined — host should set up WebRTC
    socket.on('guest-joined', (data) => {
        console.log('[Socket] Guest joined:', data);
        if (data.participants) {
            participants = data.participants;
            updateAudiencePanel();
            updateParticipantsBar();
        }
        // Host initiates WebRTC connection to stream
        // Uploaded media is served to both browsers; no peer negotiation needed.
    });

    // Participant update
    socket.on('participants-update', (data) => {
        participants = data.participants || [];
        updateAudiencePanel();
        updateParticipantsBar();
    });

    // Audience connection state update
    socket.on('audience-update', (data) => {
        if (data.participants) {
            participants = data.participants;
            updateAudiencePanel();
        }
    });

    socket.on('media-ready', loadSharedMedia);
    socket.on('playback-state', state => { if (!isHost) applyPlayback(state); });
    socket.on('room-closed', () => { resetState(); showView('lobby-view'); alert('The host left the room.'); });

    socket.on('subtitle-sync', data => applySubtitles(data.content, data.filename));

    // Chat
    socket.on('chat-message', (message) => {
        addChatMessage(message);
    });

    socket.on('emoji-reaction', (data) => {
        showFloatingReaction(data.emoji);
    });

    socket.on('peer-disconnected', (data) => {
        console.log('[Socket] Peer disconnected');
        if (data.participants) {
            participants = data.participants;
            updateAudiencePanel();
            updateParticipantsBar();
        }
    });
}

// ===== UI Listeners =====
function setupUIListeners() {
    // User setup modal
    if (avatarGrid) {
        avatarGrid.addEventListener('click', (e) => {
            const btn = e.target.closest('.avatar-btn');
            if (btn) {
                avatarGrid.querySelectorAll('.avatar-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                userInfo.avatar = btn.dataset.avatar;
            }
        });
    }

    if (setupContinueBtn) {
        setupContinueBtn.addEventListener('click', () => {
            const nickname = nicknameInput.value.trim();
            if (!nickname) {
                nicknameInput.focus();
                nicknameInput.style.borderColor = '#ef4444';
                return;
            }
            userInfo.nickname = nickname;
            localStorage.setItem('moviehub_userinfo', JSON.stringify(userInfo));
            userSetupModal.classList.add('hidden');

            if (pendingAction === 'create') doCreateRoom();
            else if (pendingAction === 'join') doJoinRoom();
        });
    }

    // Room actions
    createRoomBtn.addEventListener('click', () => {
        pendingAction = 'create';
        showUserSetup();
    });

    joinRoomBtn.addEventListener('click', () => {
        const code = roomCodeInput.value.trim().toUpperCase();
        if (!code || code.length < 4) {
            roomCodeInput.style.borderColor = '#ef4444';
            return;
        }
        pendingAction = 'join';
        showUserSetup();
    });

    // Copy code
    copyCodeBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(roomCode).then(() => {
            copyCodeBtn.textContent = '✅';
            setTimeout(() => copyCodeBtn.textContent = '📋', 2000);
        });
    });

    // Copy link
    if (copyLinkBtn) {
        copyLinkBtn.addEventListener('click', () => {
            const link = `${window.location.origin}?room=${roomCode}`;
            navigator.clipboard.writeText(link).then(() => {
                copyLinkBtn.textContent = 'Copied!';
                setTimeout(() => copyLinkBtn.textContent = 'Copy Link', 2000);
            });
        });
    }

    // Leave room
    document.getElementById('leave-room-btn').addEventListener('click', () => {
        resetState();
        showView('lobby-view');
    });

    const leaveWatchBtn = document.getElementById('leave-watch-btn');
    if (leaveWatchBtn) {
        leaveWatchBtn.addEventListener('click', () => {
            resetState();
            showView('lobby-view');
        });
    }

    // File drop zone
    hostDropZone.addEventListener('click', () => fileInput.click());
    hostDropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        hostDropZone.classList.add('dragover');
    });
    hostDropZone.addEventListener('dragleave', () => hostDropZone.classList.remove('dragover'));
    hostDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        hostDropZone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('video/')) {
            handleFileSelected(file);
        }
    });
    fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) handleFileSelected(e.target.files[0]);
    });

    // Video controls — only host can control
    playPauseBtn.addEventListener('click', () => {
        if (!videoPlayer.src) return;
        if (!isHost) { videoPlayer.play().then(() => videoOverlay.classList.remove('visible')).catch(console.error); return; }
        togglePlayPause();
    });

    videoOverlay.addEventListener('click', () => {
        videoOverlay.classList.remove('visible');
        if (isHost) togglePlayPause();
        else videoPlayer.play().catch(console.error);
    });

    // Skip buttons
    skipBackBtn.addEventListener('click', () => {
        if (!isHost) return;
        videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - 5);
        socket.emit('seek', videoPlayer.currentTime);
    });

    skipForwardBtn.addEventListener('click', () => {
        if (!isHost) return;
        videoPlayer.currentTime = Math.min(videoPlayer.duration, videoPlayer.currentTime + 5);
        socket.emit('seek', videoPlayer.currentTime);
    });

    // Seek bar
    seekBar.addEventListener('input', (e) => {
        if (!isHost) return;
        const time = (e.target.value / 100) * videoPlayer.duration;
        videoPlayer.currentTime = time;
    });
    seekBar.addEventListener('change', (e) => {
        if (!isHost) return;
        const time = (e.target.value / 100) * videoPlayer.duration;
        socket.emit('seek', time);
    });

    // Video events
    videoPlayer.addEventListener('play', () => {
        playPauseBtn.textContent = '⏸️';
        if (isHost && !isSyncing) {
            socket.emit('play', videoPlayer.currentTime);
        }
    });

    videoPlayer.addEventListener('pause', () => {
        playPauseBtn.textContent = '▶️';
        if (isHost && !isSyncing) {
            socket.emit('pause', videoPlayer.currentTime);
        }
    });

    videoPlayer.addEventListener('seeked', () => {
        if (isHost && !isSyncing) {
            socket.emit('seek', videoPlayer.currentTime);
        }
    });

    videoPlayer.addEventListener('timeupdate', () => {
        if (videoPlayer.duration) {
            const percent = (videoPlayer.currentTime / videoPlayer.duration) * 100;
            seekBar.value = percent;
            currentTimeDisplay.textContent = formatTime(videoPlayer.currentTime);
            durationDisplay.textContent = formatTime(videoPlayer.duration);
        }
    });

    videoPlayer.addEventListener('loadedmetadata', () => {
        durationDisplay.textContent = formatTime(videoPlayer.duration);
    });

    // Host time-sync broadcast (every 5 seconds)
    setInterval(() => {
        if (isHost && roomCode && !videoPlayer.paused && videoPlayer.currentTime > 0) {
            socket.emit('time-sync', videoPlayer.currentTime);
        }
    }, 5000);

    // Fullscreen
    fullscreenBtn.addEventListener('click', () => {
        const container = document.getElementById('screening-container');
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            container.requestFullscreen().catch(console.error);
        }
    });

    // Theatre mode
    theatreBtn.addEventListener('click', toggleTheatreMode);

    // Subtitles
    const subtitleBtn = document.getElementById('subtitle-btn');
    const subtitleInput = document.getElementById('subtitle-input');
    if (subtitleBtn) {
        subtitleBtn.addEventListener('click', () => subtitleInput.click());
    }
    if (subtitleInput) {
        subtitleInput.addEventListener('change', (e) => {
            if (e.target.files[0]) loadSubtitles(e.target.files[0]);
        });
    }

    // Chat
    toggleChatBtn.addEventListener('click', toggleChat);
    closeChatBtn.addEventListener('click', toggleChat);
    sendChatBtn.addEventListener('click', sendChatMessage);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendChatMessage();
    });

    // Emoji reactions
    document.querySelectorAll('.reaction-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const emoji = btn.dataset.emoji;
            socket.emit('emoji-reaction', emoji);
            showFloatingReaction(emoji);
        });
    });

    // Check URL for room code
    const urlParams = new URLSearchParams(window.location.search);
    const urlRoom = urlParams.get('room');
    if (urlRoom) {
        roomCodeInput.value = urlRoom;
    }
}

// ===== User Setup =====
function showUserSetup() {
    const saved = localStorage.getItem('moviehub_userinfo');
    if (saved) {
        try { userInfo = JSON.parse(saved); } catch { localStorage.removeItem('moviehub_userinfo'); nicknameInput.value = ''; userSetupModal.classList.remove('hidden'); return; }
        if (pendingAction === 'create') doCreateRoom();
        else if (pendingAction === 'join') doJoinRoom();
        return;
    }
    nicknameInput.value = '';
    userSetupModal.classList.remove('hidden');
}

function generateNickname() {
    const adj = ['Cool', 'Epic', 'Chill', 'Super', 'Mega'];
    const nouns = ['Viewer', 'Watcher', 'Critic', 'Fan', 'Star'];
    return adj[Math.floor(Math.random() * adj.length)] + nouns[Math.floor(Math.random() * nouns.length)] + Math.floor(Math.random() * 100);
}

// ===== Room Actions =====
function doCreateRoom() {
    socket.emit('create-room', {
        nickname: userInfo.nickname,
        avatar: userInfo.avatar
    }, async (response) => {
        if (response.success) {
            roomCode = response.roomCode;
            isHost = true;
            displayRoomCode.textContent = roomCode;
            if (response.iceServers) iceServers = response.iceServers;
            if (response.participants) {
                participants = response.participants;
                updateAudiencePanel();
            }

            // Show screening view as host
            showView('screening-view');
            hostDropZone.classList.remove('hidden');
            guestWaiting.classList.add('hidden');

            console.log('[Room] Created:', roomCode);
        } else {
            alert('Failed to create room: ' + (response.error || 'Unknown error'));
        }
    });
}

function doJoinRoom() {
    const code = roomCodeInput.value.trim().toUpperCase();
    socket.emit('join-room', {
        roomCode: code,
        nickname: userInfo.nickname,
        avatar: userInfo.avatar
    }, async (response) => {
        if (response.success) {
            roomCode = code;
            isHost = false;
            displayRoomCode.textContent = roomCode;
            if (response.iceServers) iceServers = response.iceServers;
            if (response.participants) {
                participants = response.participants;
                updateAudiencePanel();
                updateParticipantsBar();
            }

            // Show screening view as guest
            showView('screening-view');
            hostDropZone.classList.add('hidden');
            guestWaiting.classList.remove('hidden');

            if (response.media) loadSharedMedia(response);
            console.log('[Room] Joined:', roomCode);
        } else {
            alert('Failed to join room: ' + (response.error || 'Room not found'));
        }
    });
}

// ===== Theatre Mode =====
function toggleTheatreMode() {
    theatreMode = !theatreMode;
    screeningContainer.classList.toggle('theatre-mode', theatreMode);
    theatreBtn.textContent = theatreMode ? '🖼️' : '🎬';
}

// ===== Audience Panel =====
function updateAudiencePanel() {
    if (!audienceList) return;

    if (participants.length === 0) {
        audienceList.innerHTML = '<div class="audience-empty">Waiting for connections…</div>';
        return;
    }

    audienceList.innerHTML = participants
        .filter(p => p.id !== userId) // Don't show self
        .map(p => {
            const connectionClass = p.connectionState === 'connected' ? 'connected' :
                p.connectionState === 'connecting' ? 'connecting' : 'waiting';
            const statusText = p.connectionState === 'connected' ? 'Connected' :
                p.connectionState === 'connecting' ? 'Connecting…' : '⏳ Waiting…';
            return `
                <div class="audience-member">
                    <span class="audience-avatar">${escapeHtml(p.avatar || '🎬')}</span>
                    <span class="audience-name">${escapeHtml(p.nickname || 'Guest')}</span>
                    <span class="audience-status ${connectionClass}">
                        <span class="audience-dot"></span>
                        ${statusText}
                    </span>
                </div>
            `;
        }).join('');

    // If no other participants to show
    if (audienceList.innerHTML.trim() === '') {
        audienceList.innerHTML = '<div class="audience-empty">Waiting for connections…</div>';
    }
}

// ===== Chat Functions =====
function toggleChat() {
    chatOpen = !chatOpen;
    chatSidebar.classList.toggle('hidden', !chatOpen);
    screeningContainer.classList.toggle('chat-open', chatOpen);
}

function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chat-message', text);
    chatInput.value = '';
}

function addChatMessage(message) {
    const div = document.createElement('div');
    div.className = `chat-message ${message.userId === userId ? 'own' : ''}`;
    div.innerHTML = `
        <div class="chat-msg-header">
            <span class="chat-avatar">${escapeHtml(message.avatar || '🎬')}</span>
            <span class="chat-nickname">${escapeHtml(message.nickname)}</span>
            <span class="chat-time">${formatMessageTime(message.timestamp)}</span>
        </div>
        <div class="chat-msg-body">${escapeHtml(message.text)}</div>
    `;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateParticipantsBar() {
    if (!participantsBar) return;
    participantsBar.innerHTML = participants.map(p =>
        `<span class="participant-avatar" title="${escapeHtml(p.nickname || 'Guest')}">${escapeHtml(p.avatar || '🎬')}</span>`
    ).join('');
}

function showFloatingReaction(emoji) {
    const el = document.createElement('div');
    el.className = 'floating-emoji';
    el.textContent = emoji;
    el.style.left = Math.random() * 80 + 10 + '%';
    reactionOverlay.appendChild(el);
    setTimeout(() => el.remove(), 2000);
}

function formatMessageTime(timestamp) {
    const d = new Date(timestamp);
    return `${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ===== Subtitle Loading =====
function loadSubtitles(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        let content = e.target.result;
        const filename = file.name.toLowerCase();
        if (filename.endsWith('.srt')) {
            content = convertSrtToVtt(content);
        }
        applySubtitles(content, filename);
        if (isHost && roomCode) socket.emit('subtitle-sync', { content, filename });
    };
    reader.readAsText(file);
}

function applySubtitles(content, filename) {
    // Remove existing tracks
    while (videoPlayer.firstChild) {
        if (videoPlayer.firstChild.tagName === 'TRACK') {
            videoPlayer.removeChild(videoPlayer.firstChild);
        } else break;
    }

    const blob = new Blob([content], { type: 'text/vtt' });
    const url = URL.createObjectURL(blob);
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = filename.replace(/\.(srt|vtt)$/i, '');
    track.srclang = 'en';
    track.src = url;
    track.default = true;
    videoPlayer.appendChild(track);

    // Activate the track
    setTimeout(() => {
        if (videoPlayer.textTracks.length > 0) {
            videoPlayer.textTracks[0].mode = 'showing';
        }
    }, 100);
}

function convertSrtToVtt(srt) {
    let vtt = 'WEBVTT\n\n';
    vtt += srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return vtt;
}

// ===== Connection Quality UI =====
function updateConnectionQuality(state) {
    const qualityEl = document.getElementById('webrtc-quality');
    if (!qualityEl) return;

    qualityEl.style.display = 'flex';
    const labelEl = qualityEl.querySelector('.quality-label');

    switch (state) {
        case 'connected':
        case 'streaming':
            qualityEl.className = 'webrtc-quality good';
            if (labelEl) labelEl.textContent = 'Connected';
            break;
        case 'reconnecting':
            qualityEl.className = 'webrtc-quality fair';
            if (labelEl) labelEl.textContent = 'Reconnecting…';
            break;
        case 'failed':
            qualityEl.className = 'webrtc-quality poor';
            if (labelEl) labelEl.textContent = 'Connection failed';
            break;
        case 'disconnected':
            qualityEl.className = 'webrtc-quality poor';
            if (labelEl) labelEl.textContent = 'Disconnected';
            break;
    }
}

function updateSyncIndicator(inSync) {
    if (!syncIndicator) return;
    const dot = syncIndicator.querySelector('.sync-dot');
    const text = syncIndicator.querySelector('span');
    if (dot) dot.className = `sync-dot ${inSync ? 'synced' : 'desynced'}`;
    if (text) text.textContent = inSync ? 'In Sync' : 'Out of Sync';
}

// ===== File Handling (Host) =====
function loadSharedMedia(data) {
    if (!data.media) return;
    pendingPlayback = data.playback;
    const url = new URL(data.media.url, location.origin).href;
    if (videoPlayer.src !== url) {
        videoPlayer.srcObject = null;
        videoPlayer.src = url;
        videoPlayer.load();
    } else if (pendingPlayback) applyPlayback(pendingPlayback);
    hostDropZone.classList.add('hidden');
    guestWaiting.classList.add('hidden');
    videoOverlay.classList.add('visible');
    updateConnectionQuality('connected');
}

function applyPlayback(state) {
    pendingPlayback = state;
    if (!state || videoPlayer.readyState < 1) return;
    isSyncing = true;
    if (Math.abs(videoPlayer.currentTime - state.time) > SYNC_THRESHOLD) videoPlayer.currentTime = state.time;
    if (state.paused) videoPlayer.pause();
    else videoPlayer.play().then(() => videoOverlay.classList.remove('visible')).catch(() => videoOverlay.classList.add('visible'));
    setTimeout(() => { isSyncing = false; }, 0);
    updateSyncIndicator(true);
}
videoPlayer.addEventListener('loadedmetadata', () => applyPlayback(pendingPlayback));
videoPlayer.addEventListener('error', () => {
    if (videoPlayer.error && videoPlayer.src) alert('This movie could not be played. Use a browser-compatible MP4 (H.264/AAC) or WebM file.');
});

function handleFileSelected(file) {
    if (!isHost || !roomCode || activeUpload) return;
    if (!file.size) { alert('Choose a non-empty video file.'); return; }
    videoFile = file;
    const hint = hostDropZone.querySelector('.drop-hint');
    const xhr = new XMLHttpRequest();
    activeUpload = xhr;
    xhr.open('POST', `/api/rooms/${roomCode}/video`);
    xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.onprogress = event => {
        if (event.lengthComputable) hint.textContent = `Uploading ${Math.round(event.loaded / event.total * 100)}% — keep this page open`;
    };
    xhr.onload = () => {
        activeUpload = null;
        hint.textContent = 'or click to browse';
        if (xhr.status >= 200 && xhr.status < 300) loadSharedMedia(JSON.parse(xhr.responseText));
        else { hostDropZone.classList.remove('hidden'); alert('Upload failed. Check server upload limits and retry.'); }
    };
    xhr.onerror = () => { activeUpload = null; hint.textContent = 'Upload failed — click to retry'; };
    xhr.onabort = () => { activeUpload = null; hint.textContent = 'or click to browse'; };
    xhr.send(file);
}

// ===== Video Controls =====
function togglePlayPause() {
    if (videoPlayer.paused) {
        videoPlayer.play().catch(console.error);
    } else {
        videoPlayer.pause();
    }
}

// ===== State Reset =====
function resetState() {
    if (activeUpload) activeUpload.abort();
    pendingPlayback = null;
    videoPlayer.pause();

    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    roomCode = null;
    isHost = false;
    videoFile = null;
    reconnectAttempts = 0;
    theatreMode = false;

    if (videoObjectURL) {
        URL.revokeObjectURL(videoObjectURL);
        videoObjectURL = null;
    }
    videoPlayer.removeAttribute('src');
    videoPlayer.load();
    videoPlayer.srcObject = null;
    participants = [];

    hostDropZone.classList.add('hidden');
    guestWaiting.classList.add('hidden');
    screeningContainer.classList.remove('theatre-mode', 'chat-open');

    const qualityEl = document.getElementById('webrtc-quality');
    if (qualityEl) qualityEl.style.display = 'none';

    chatMessages.innerHTML = '';
    participantsBar.innerHTML = '';
    audienceList.innerHTML = '<div class="audience-empty">Waiting for connections…</div>';

    socket.disconnect();
    socket.connect();
}

// ===== Utilities =====
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatTime(seconds) {
    if (!seconds || !Number.isFinite(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ===== Start =====
init();
