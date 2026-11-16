// MovieHub Sync - Content Script (ISOLATED World)
// Communicates with background script for Socket.io + WebRTC

(function () {
    'use strict';

    let videoElement = null;
    let isSyncing = false;
    let roomCode = null;
    let isConnected = false;
    let iceServers = null;
    const SYNC_THRESHOLD = 0.5;

    console.log('[MovieHub] Content script loaded');

    // Find video
    function findVideo() {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
            if (video.offsetWidth > 200 && video.offsetHeight > 100) return video;
        }
        return videos[0] || null;
    }

    // Create status badge
    function createStatusBadge() {
        if (document.getElementById('mh-badge')) return;

        const badge = document.createElement('div');
        badge.id = 'mh-badge';
        badge.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 999999;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      background: rgba(0, 0, 0, 0.9);
      border-radius: 24px;
      border: 1px solid rgba(139, 92, 246, 0.5);
      font-family: -apple-system, sans-serif;
      color: white;
      font-size: 13px;
      box-shadow: 0 4px 20px rgba(139, 92, 246, 0.3);
    `;

        const dot = document.createElement('span');
        dot.id = 'mh-dot';
        dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#f59e0b;display:inline-block;';

        const label = document.createElement('span');
        label.style.fontWeight = '600';
        label.textContent = 'MovieHub';

        const status = document.createElement('span');
        status.id = 'mh-status';
        status.style.cssText = 'color:rgba(255,255,255,0.7);padding-left:10px;border-left:1px solid rgba(255,255,255,0.2);';
        status.textContent = 'Ready';

        // Auth indicator
        const authIndicator = document.createElement('span');
        authIndicator.id = 'mh-auth';
        authIndicator.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.4);padding-left:8px;';
        authIndicator.textContent = '';

        badge.appendChild(dot);
        badge.appendChild(label);
        badge.appendChild(status);
        badge.appendChild(authIndicator);
        document.body.appendChild(badge);
    }

    function updateStatus(state, msg) {
        const dot = document.getElementById('mh-dot');
        const status = document.getElementById('mh-status');
        if (status) status.textContent = msg;
        if (dot) {
            dot.style.background = state === 'synced' ? '#10b981' : state === 'waiting' ? '#f59e0b' : '#8b5cf6';
        }
    }

    function updateAuthStatus(authenticated) {
        const authEl = document.getElementById('mh-auth');
        if (authEl) {
            authEl.textContent = authenticated ? '🔒' : '';
            authEl.title = authenticated ? 'Authenticated (JWT)' : 'Not authenticated';
        }
    }

    // Create controls
    function createControls() {
        if (document.getElementById('mh-controls')) return;

        const controls = document.createElement('div');
        controls.id = 'mh-controls';
        controls.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-family: -apple-system, sans-serif;
    `;

        const createBtn = document.createElement('button');
        createBtn.id = 'mh-create';
        createBtn.textContent = '🎬 Create Room';
        createBtn.style.cssText = `
      padding: 12px 20px;
      background: linear-gradient(135deg, #8b5cf6, #6366f1);
      color: white;
      border: none;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(139, 92, 246, 0.4);
    `;

        const joinRow = document.createElement('div');
        joinRow.style.cssText = 'display:flex;gap:8px;';

        const codeInput = document.createElement('input');
        codeInput.id = 'mh-code';
        codeInput.type = 'text';
        codeInput.placeholder = 'Code';
        codeInput.maxLength = 6;
        codeInput.style.cssText = `
      flex: 1;
      padding: 12px;
      background: rgba(0,0,0,0.8);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 12px;
      color: white;
      font-size: 14px;
      text-transform: uppercase;
      text-align: center;
      width: 100px;
    `;

        const joinBtn = document.createElement('button');
        joinBtn.textContent = 'Join';
        joinBtn.style.cssText = `
      padding: 12px 16px;
      background: rgba(255,255,255,0.1);
      color: white;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 12px;
      font-size: 14px;
      cursor: pointer;
    `;

        const leaveBtn = document.createElement('button');
        leaveBtn.id = 'mh-leave';
        leaveBtn.textContent = 'Leave Room';
        leaveBtn.style.cssText = `
      padding: 10px;
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 12px;
      font-size: 13px;
      cursor: pointer;
      display: none;
    `;

        joinRow.appendChild(codeInput);
        joinRow.appendChild(joinBtn);
        controls.appendChild(createBtn);
        controls.appendChild(joinRow);
        controls.appendChild(leaveBtn);
        document.body.appendChild(controls);

        // Events
        createBtn.onclick = () => {
            chrome.runtime.sendMessage({ type: 'CREATE_ROOM' }, (resp) => {
                if (resp && resp.success) {
                    roomCode = resp.roomCode;
                    isConnected = true;
                    if (resp.iceServers) iceServers = resp.iceServers;
                    createStatusBadge();
                    updateStatus('waiting', 'Code: ' + roomCode);
                    updateAuthStatus(resp.authenticated);
                    createBtn.style.display = 'none';
                    joinRow.style.display = 'none';
                    leaveBtn.style.display = 'block';
                    attachVideoListeners();
                } else {
                    updateStatus('error', 'Failed');
                }
            });
        };

        joinBtn.onclick = () => {
            const code = codeInput.value.trim().toUpperCase();
            if (code.length !== 6) return;
            chrome.runtime.sendMessage({ type: 'JOIN_ROOM', roomCode: code }, (resp) => {
                if (resp && resp.success) {
                    roomCode = code;
                    isConnected = true;
                    if (resp.iceServers) iceServers = resp.iceServers;
                    createStatusBadge();
                    updateStatus('synced', 'Synced!');
                    updateAuthStatus(resp.authenticated);
                    createBtn.style.display = 'none';
                    joinRow.style.display = 'none';
                    leaveBtn.style.display = 'block';
                    attachVideoListeners();
                } else {
                    updateStatus('error', resp?.error || 'Failed');
                }
            });
        };

        leaveBtn.onclick = () => {
            chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' });
            isConnected = false;
            roomCode = null;
            iceServers = null;
            updateStatus('waiting', 'Left');
            updateAuthStatus(false);
            createBtn.style.display = 'block';
            joinRow.style.display = 'flex';
            leaveBtn.style.display = 'none';
        };
    }

    // Listen for messages from background
    chrome.runtime.onMessage.addListener((msg) => {
        if (!videoElement) videoElement = findVideo();

        switch (msg.type) {
            case 'PLAY':
                if (videoElement) {
                    isSyncing = true;
                    videoElement.currentTime = msg.time;
                    videoElement.play().catch(() => { });
                    setTimeout(() => isSyncing = false, 500);
                }
                break;
            case 'PAUSE':
                if (videoElement) {
                    isSyncing = true;
                    videoElement.currentTime = msg.time;
                    videoElement.pause();
                    setTimeout(() => isSyncing = false, 500);
                }
                break;
            case 'SEEK':
                if (videoElement) {
                    isSyncing = true;
                    videoElement.currentTime = msg.time;
                    setTimeout(() => isSyncing = false, 500);
                }
                break;
            case 'TIME_SYNC':
                if (videoElement && Math.abs(videoElement.currentTime - msg.time) > SYNC_THRESHOLD) {
                    isSyncing = true;
                    videoElement.currentTime = msg.time;
                    setTimeout(() => isSyncing = false, 300);
                }
                break;
            case 'GUEST_JOINED':
                updateStatus('synced', 'Friend joined!');
                break;
            case 'PEER_LEFT':
                updateStatus('waiting', 'Friend left');
                break;
            case 'CONNECTED':
                updateStatus('synced', 'Connected');
                break;
            case 'ERROR':
                updateStatus('error', msg.message);
                break;
            case 'STREAM_STARTING':
                updateStatus('synced', 'Stream starting...');
                break;
        }
    });

    function attachVideoListeners() {
        videoElement = findVideo();
        if (!videoElement) {
            const observer = new MutationObserver(() => {
                const v = findVideo();
                if (v) { videoElement = v; observer.disconnect(); setupVideoEvents(); }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            return;
        }
        setupVideoEvents();
    }

    function setupVideoEvents() {
        if (!videoElement) return;
        console.log('[MovieHub] Video events ready');

        videoElement.addEventListener('play', () => {
            if (!isSyncing && isConnected) {
                chrome.runtime.sendMessage({ type: 'EMIT_PLAY', time: videoElement.currentTime });
            }
        });

        videoElement.addEventListener('pause', () => {
            if (!isSyncing && isConnected) {
                chrome.runtime.sendMessage({ type: 'EMIT_PAUSE', time: videoElement.currentTime });
            }
        });

        videoElement.addEventListener('seeked', () => {
            if (!isSyncing && isConnected) {
                chrome.runtime.sendMessage({ type: 'EMIT_SEEK', time: videoElement.currentTime });
            }
        });

        setInterval(() => {
            if (isConnected && videoElement && !videoElement.paused) {
                chrome.runtime.sendMessage({ type: 'EMIT_TIME_SYNC', time: videoElement.currentTime });
            }
        }, 5000);
    }

    // Init
    setTimeout(() => {
        createStatusBadge();
        createControls();

        // Check if already in room
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
            if (resp && resp.roomCode) {
                roomCode = resp.roomCode;
                isConnected = resp.connected;
                if (resp.iceServers) iceServers = resp.iceServers;
                updateStatus(resp.connected ? 'synced' : 'waiting', 'Code: ' + resp.roomCode);
                updateAuthStatus(resp.authenticated);
                document.getElementById('mh-create').style.display = 'none';
                document.getElementById('mh-code').parentElement.style.display = 'none';
                document.getElementById('mh-leave').style.display = 'block';
                attachVideoListeners();
            }
        });
    }, 1500);

})();
