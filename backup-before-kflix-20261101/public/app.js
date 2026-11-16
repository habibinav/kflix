/* MovieHub client
 *
 * One person drops a film: it plays straight from their disk (object URL),
 * so it is on screen the instant the drop lands. That person is the "source".
 * The other person either
 *   - receives a live WebRTC stream captured from the source's <video>, or
 *   - drops their own copy of the same file and plays it locally, kept in
 *     sync with the source's clock (gentle rate nudges, hard seeks if far off).
 * Either person can play, pause and seek.
 */
(() => {
'use strict';

const $ = id => document.getElementById(id);
const el = {
  lobby: $('lobby'), lobbyForm: $('lobby-form'), nameInput: $('name-input'), codeInput: $('code-input'),
  joinBtn: $('join-btn'), primaryBtn: $('primary-btn'), codeJoin: $('code-join'), invite: $('join-invite'),
  inviteCode: $('invite-code'), lobbyError: $('lobby-error'),
  room: $('room'), stage: $('stage'), video: $('video'), subs: $('subs'),
  filmTitle: $('film-title'), filmStatus: $('film-status'), roomCode: $('room-code'),
  leaveBtn: $('leave-btn'), inviteBtn: $('invite-btn'),
  empty: $('empty'), emptyEyebrow: $('empty-eyebrow'), chooseLabel: $('choose-label'), emptyTitle: $('empty-title'), emptySub: $('empty-sub'), chooseBtn: $('choose-btn'),
  notice: $('notice'), noticeText: $('notice-text'), noticeBtn: $('notice-btn'), noticeSpin: $('notice-spin'),
  ownCopy: $('own-copy'),
  scrub: $('scrub'), scrubFill: $('scrub-fill'), scrubBuf: $('scrub-buf'), scrubKnob: $('scrub-knob'), scrubTip: $('scrub-tip'),
  playBtn: $('play-btn'), backBtn: $('back-btn'), fwdBtn: $('fwd-btn'), muteBtn: $('mute-btn'), vol: $('vol'),
  tCur: $('t-cur'), tDur: $('t-dur'), sync: $('sync'), syncText: $('sync-text'),
  ccBtn: $('cc-btn'), chatBtn: $('chat-btn'), unread: $('unread'), fullBtn: $('full-btn'),
  toasts: $('toasts'), side: $('side'), sideClose: $('side-close'), people: $('people'),
  messages: $('messages'), chatForm: $('chat-form'), chatInput: $('chat-input'),
  dropveil: $('dropveil'), dropveilText: $('dropveil-text'), fileInput: $('file-input'),
  ask: $('ask'), askTitle: $('ask-title'), askText: $('ask-text'), askYes: $('ask-yes'), askNo: $('ask-no')
};
const video = el.video;

// ---------------------------------------------------------------- state
const STREAM_DELAY = 0.25;   // rough glass-to-glass delay of the live stream, seconds
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  sset(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} }
};

let socket = null;
let me = { id: null, token: null, name: store.get('mh-name') || '' };
let room = null;              // latest snapshot from server
let iceServers = [];
let localFile = null;         // File currently loaded from this computer
let localUrl = null;
let playingFrom = null;       // 'file' | 'stream' | null
let lastTick = { time: 0, paused: true, at: performance.now() };
let ignoreTicksUntil = 0;
let cues = [];
let ccOn = true;
let subtitleName = '';
let chatOpen = false;
let pendingFileAfterCreate = null;

// WebRTC
let pc = null;                // { conn, id, role: 'send'|'recv', stream, remote, statsTimer, retryTimer }
let captured = null;          // MediaStream captured from <video>, per loaded file
const pendingIce = new Map();
let wantTimer = null;
let linkStats = '';

const canCapture = !!(HTMLMediaElement.prototype.captureStream || HTMLMediaElement.prototype.mozCaptureStream);

// ---------------------------------------------------------------- helpers
const fmt = s => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = name => (name || '?').trim().charAt(0).toUpperCase();
const isVideoFile = f => /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm|mkv|ogv)$/i.test(f.name);
const isSubFile = f => /\.(srt|vtt)$/i.test(f.name);

function prettyTitle(filename) {
  let base = String(filename || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = base.match(/^(.*?)[\s([]*((?:19|20)\d{2})(?:[\s)\]]|$)/);
  if (m && m[1].trim()) return `${m[1].trim()} (${m[2]})`;
  base = base.replace(/\b(2160p|1080p|720p|480p|4k|bluray|brrip|webrip|web dl|web|hdrip|x264|x265|h264|h265|hevc|aac|dts|hdr)\b.*$/i, '').trim();
  return base || filename;
}

const isSource = () => !!(room && me.id && room.sourceId === me.id);
const self = () => room?.members.find(m => m.id === me.id);
const peer = () => room?.members.find(m => m.id !== me.id);
const sourceMember = () => room?.members.find(m => m.id === room.sourceId);
const myMode = () => self()?.mode || 'none';
const duration = () => room?.movie?.duration || (Number.isFinite(video.duration) ? video.duration : 0);

function movieTime() {
  if (playingFrom === 'file') return video.currentTime;
  const t = lastTick.paused ? lastTick.time : lastTick.time + (performance.now() - lastTick.at) / 1000 - STREAM_DELAY;
  return Math.max(0, Math.min(t, duration() || Infinity));
}
const moviePaused = () => (playingFrom === 'file' ? video.paused : lastTick.paused);

function toast(html, ms = 2800) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = html;
  el.toasts.appendChild(t);
  while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, ms);
}

function ask({ title, text, yes, no = 'Cancel' }) {
  el.askTitle.textContent = title;
  el.askText.textContent = text;
  el.askYes.textContent = yes;
  el.askNo.textContent = no;
  el.ask.hidden = false;
  return new Promise(resolve => {
    const done = v => { el.ask.hidden = true; el.askYes.onclick = el.askNo.onclick = null; resolve(v); };
    el.askYes.onclick = () => done(true);
    el.askNo.onclick = () => done(false);
  });
}

function notice(text, { spin = false, button = null, onClick = null } = {}) {
  if (!text) { el.notice.hidden = true; return; }
  el.notice.hidden = false;
  el.noticeText.textContent = text;
  el.noticeSpin.hidden = !spin;
  el.noticeBtn.hidden = !button;
  if (button) { el.noticeBtn.textContent = button; el.noticeBtn.onclick = onClick; }
}

// ---------------------------------------------------------------- identity + socket
async function identity() {
  const res = await fetch('/api/identity', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: store.get('mh-token') })
  });
  const data = await res.json();
  me.id = data.userId; me.token = data.token;
  store.set('mh-token', data.token);
}

function connect() {
  socket = io({ auth: { token: me.token }, transports: ['websocket', 'polling'] });
  let first = true;
  socket.on('connect', () => {
    if (first) { first = false; return; }
    if (room) rejoin();             // network blip: take our seat back
  });
  socket.on('connect_error', async err => {
    if (err.message === 'AUTH') { store.set('mh-token', ''); await identity(); socket.auth = { token: me.token }; socket.connect(); }
  });
  socket.on('room', onRoom);
  socket.on('control', onControl);
  socket.on('tick', onTick);
  socket.on('signal', onSignal);
  socket.on('chat', addMessage);
  socket.on('subtitles', data => {
    if (data) { loadSubtitles(data.text, data.name); toast(`Subtitles added: ${esc(data.name)}`); }
    else { cues = []; subtitleName = ''; renderControls(); }
  });
}

const emit = (event, data) => new Promise(resolve => socket.emit(event, data, resolve));

// ---------------------------------------------------------------- lobby
function setupLobby() {
  el.nameInput.value = me.name;
  const params = new URLSearchParams(location.search);
  const code = (params.get('r') || '').toUpperCase();
  if (code) {
    el.invite.hidden = false;
    el.inviteCode.textContent = code;
    el.primaryBtn.textContent = 'Join room';
    el.codeJoin.hidden = true;
  }
  el.codeInput.addEventListener('input', () => { el.codeInput.value = el.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  el.lobbyForm.addEventListener('submit', e => { e.preventDefault(); code ? enterRoom('join', code) : enterRoom('create'); });
  el.joinBtn.addEventListener('click', () => {
    if (el.codeInput.value.length < 6) { el.lobbyError.textContent = 'Room codes are six characters.'; el.codeInput.focus(); return; }
    enterRoom('join', el.codeInput.value);
  });
  el.codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.joinBtn.click(); } });

  // A refresh inside a room drops you straight back in.
  const resume = store.sget('mh-room');
  if (resume && me.name && (!code || code === resume)) enterRoom('join', resume, { quiet: true });
}

async function enterRoom(kind, code, { quiet = false } = {}) {
  const name = el.nameInput.value.trim() || me.name;
  if (!name && !quiet) { el.lobbyError.textContent = 'Add your name so your friend knows who you are.'; el.nameInput.focus(); return; }
  me.name = name || 'Guest';
  store.set('mh-name', me.name);
  el.lobbyError.textContent = '';
  const res = kind === 'create' ? await emit('create', { name: me.name }) : await emit('join', { code, name: me.name });
  if (!res?.ok) {
    store.sset('mh-room', null);
    if (!quiet) el.lobbyError.textContent = res?.error || 'Could not reach the room.';
    return;
  }
  iceServers = res.iceServers || [];
  store.sset('mh-room', res.room.code);
  history.replaceState(null, '', '?r=' + res.room.code);
  el.lobby.hidden = true;
  el.room.hidden = false;
  el.messages.innerHTML = '';
  res.messages.forEach(m => addMessage(m, true));
  if (!res.messages.length) el.messages.innerHTML = '<p class="hint">Messages stay in this room.</p>';
  if (res.subtitles) loadSubtitles(res.subtitles.text, res.subtitles.name);
  lastTick = { ...res.room.playback, at: performance.now() };
  onRoom(res.room);
  if (window.innerWidth > 1100 && !res.room.movie) setChat(true);
  if (pendingFileAfterCreate) { const f = pendingFileAfterCreate; pendingFileAfterCreate = null; handleFiles([f]); }
}

async function rejoin() {
  const res = await emit('join', { code: room.code, name: me.name });
  if (!res?.ok) { toast(esc(res?.error || 'The room closed.')); leave(); return; }
  iceServers = res.iceServers || iceServers;
  onRoom(res.room);
}

function leave() {
  socket.emit('leave');
  closePc(true);
  clearSource();
  localFile = null; captured = null; room = null; cues = [];
  store.sset('mh-room', null);
  history.replaceState(null, '', location.pathname);
  el.room.hidden = true;
  el.lobby.hidden = false;
  el.invite.hidden = true; el.codeJoin.hidden = false; el.primaryBtn.textContent = 'Open a room';
  notice(null);
}

// ---------------------------------------------------------------- video source
function setFileSource(file) {
  if (localUrl) URL.revokeObjectURL(localUrl);
  captured = null;
  video.srcObject = null;
  localUrl = URL.createObjectURL(file);
  video.src = localUrl;
  playingFrom = 'file';
  video.playbackRate = 1;
}

function setStreamSource(stream) {
  if (video.srcObject === stream) return;
  if (localUrl) { URL.revokeObjectURL(localUrl); localUrl = null; }
  video.removeAttribute('src');
  video.srcObject = stream;
  playingFrom = 'stream';
  video.playbackRate = 1;
  safePlay();
}

function clearSource() {
  video.pause();
  if (localUrl) { URL.revokeObjectURL(localUrl); localUrl = null; }
  video.srcObject = null;
  video.removeAttribute('src');
  video.load();
  playingFrom = null;
  captured = null;
}

function whenMetadata() {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1) return resolve();
    const ok = () => { off(); resolve(); };
    const bad = () => { off(); reject(video.error || new Error('unplayable')); };
    const off = () => { video.removeEventListener('loadedmetadata', ok); video.removeEventListener('error', bad); };
    video.addEventListener('loadedmetadata', ok);
    video.addEventListener('error', bad);
  });
}

async function safePlay() {
  try {
    await video.play();
    if (el.noticeBtn.textContent === 'Turn on sound') notice(null);
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      notice('Your browser wants a click before playing sound.', { button: 'Turn on sound', onClick: () => { notice(null); safePlay(); } });
    }
  }
}

// ---------------------------------------------------------------- dropping files
async function handleFiles(list) {
  const files = [...list];
  const sub = files.find(isSubFile);
  const film = files.find(isVideoFile);
  if (!sub && !film) { if (files.length) toast('That doesn’t look like a video or subtitle file.'); return; }

  if (!room) {
    // Dropped on the lobby: open a room and start right away.
    if (!film) return;
    pendingFileAfterCreate = film;
    const code = new URLSearchParams(location.search).get('r');
    code ? enterRoom('join', code.toUpperCase(), { quiet: false }) : enterRoom('create');
    if (sub) setTimeout(() => readSubtitleFile(sub), 0);
    return;
  }
  if (sub) readSubtitleFile(sub);
  if (!film) return;

  const movie = room.movie;
  if (movie && room.sourceId && !isSource()) {
    if (film.size === movie.size) return useOwnCopy(film);
    const yes = await ask({
      title: 'A different film',
      text: `“${film.name}” doesn’t match what’s playing (“${movie.name}”). Switch the room to your file?`,
      yes: 'Switch film'
    });
    if (yes) becomeSource(film);
    return;
  }
  becomeSource(film);
}

async function becomeSource(file) {
  closePc(true);
  localFile = file;
  setFileSource(file);
  setStage('ready');
  try { await whenMetadata(); }
  catch { return unplayable(file); }
  const res = await emit('movie', { name: prettyTitle(file.name), size: file.size, duration: video.duration });
  if (res?.room) {
    // Same film again (e.g. after a reload): pick up where the room was.
    const p = res.room.playback;
    if (p.time > 0.5) video.currentTime = p.time;
    if (!p.paused) safePlay();
    onRoom(res.room);
  }
  sendTick();
}

async function useOwnCopy(file) {
  closePc(false);
  localFile = file;
  setFileSource(file);
  try { await whenMetadata(); }
  catch { localFile = null; clearSource(); socket.emit('mode', 'stream'); return unplayable(file); }
  const t = movieTime();
  video.currentTime = lastTick.paused ? lastTick.time : t + 0.15;
  if (!lastTick.paused) safePlay();
  socket.emit('mode', 'local');
  toast('Playing your copy · kept in sync');
}

function unplayable(file) {
  setStage(playingFrom ? 'ready' : 'empty');
  localFile = null;
  clearSource();
  ask({
    title: 'Can’t play this file',
    text: `Your browser can’t decode “${file.name}”. MP4 with H.264 video and AAC audio works everywhere; MKV works in Chrome and Edge when the video inside is H.264. HEVC/x265 and DTS audio usually need converting.`,
    yes: 'OK', no: 'Close'
  });
  renderAll();
}

function readSubtitleFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result);
    if (!loadSubtitles(text, file.name)) return toast('Couldn’t read any subtitles from that file.');
    socket.emit('subtitles', { name: file.name, text });
    toast(`Subtitles on for both of you · ${esc(file.name)}`);
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------- subtitles
function loadSubtitles(text, name) {
  const toSec = t => { const p = t.trim().replace(',', '.').split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const out = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = toSec(a), end = toSec(b.trim().split(/\s+/)[0]);
    const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && body) out.push({ start, end, text: body });
  }
  if (!out.length) return false;
  cues = out.sort((x, y) => x.start - y.start);
  subtitleName = name;
  ccOn = true;
  renderControls();
  return true;
}

let lastCue = null;
function renderSubs(t) {
  let text = '';
  if (ccOn && cues.length) {
    // binary search for the last cue starting before t
    let lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    for (let i = idx; i >= 0 && i > idx - 4; i--) if (cues[i].end >= t) { text = cues[i].text; break; }
  }
  if (text !== lastCue) { el.subs.textContent = text; lastCue = text; }
}

// ---------------------------------------------------------------- playback control
function control(action, time) {
  if (!room?.movie) return;
  time = Math.max(0, Math.min(time, duration() || time));
  ignoreTicksUntil = performance.now() + 1500;
  if (playingFrom === 'file') {
    if (action === 'seek' || Math.abs(video.currentTime - time) > 0.3) video.currentTime = time;
    if (action === 'play') safePlay();
    if (action === 'pause') video.pause();
  }
  const paused = action === 'play' ? false : action === 'pause' ? true : moviePaused();
  lastTick = { time, paused, at: performance.now() };
  socket.emit('control', { action, time });
  if (isSource()) setTimeout(sendTick, 50);
  wake();
}

function togglePlay() {
  if (!room?.movie || (!playingFrom && !room.sourceId)) return;
  moviePaused() ? control('play', movieTime()) : control('pause', movieTime());
}
const skip = d => room?.movie && control('seek', movieTime() + d);

function onControl({ action, time, paused, by }) {
  ignoreTicksUntil = 0;
  lastTick = { time, paused, at: performance.now() };
  if (playingFrom === 'file') {
    if (action === 'seek' || Math.abs(video.currentTime - time) > 0.3) video.currentTime = time;
    if (paused) video.pause(); else safePlay();
    video.playbackRate = 1;
  }
  const verb = action === 'play' ? 'pressed play' : action === 'pause' ? `paused at ${fmt(time)}` : `jumped to ${fmt(time)}`;
  toast(`<b>${esc(by)}</b> ${verb}`);
  if (isSource()) setTimeout(sendTick, 50);
  wake();
}

// The source publishes its clock; a local-copy viewer follows it.
let tickTimer = null;
function sendTick() {
  if (!isSource() || playingFrom !== 'file' || !room?.movie) return;
  socket.emit('tick', { time: video.currentTime, paused: video.paused, buffering: video.readyState < 3 && !video.paused });
}

let driftMs = null;
function onTick(t) {
  if (performance.now() < ignoreTicksUntil) return;
  lastTick = { time: t.time, paused: t.paused, at: performance.now() };
  if (playingFrom !== 'file' || isSource()) return;
  const target = t.paused ? t.time : t.time + 0.04; // ~one-way network delay
  const diff = video.currentTime - target;
  driftMs = Math.round(diff * 1000);
  if (t.paused) {
    if (!video.paused) video.pause();
    if (Math.abs(diff) > 0.25) video.currentTime = t.time;
    video.playbackRate = 1;
    return;
  }
  if (video.paused) { video.currentTime = target + 0.1; safePlay(); return; }
  if (Math.abs(diff) > 1.2) { video.currentTime = target + 0.1; video.playbackRate = 1; }
  else if (Math.abs(diff) > 0.12) video.playbackRate = diff > 0 ? 0.94 : 1.06;
  else video.playbackRate = 1;
}

// ---------------------------------------------------------------- room state
function onRoom(snap) {
  const before = room;
  room = snap;

  // presence messages
  if (before) {
    const was = before.members.find(m => m.id !== me.id), now = peer();
    if (!was && now) sysMessage(`${now.name} joined`), toast(`<b>${esc(now.name)}</b> joined the room`);
    else if (was && !now) sysMessage(`${was.name} left`), toast(`<b>${esc(was.name)}</b> left`);
    else if (was && now && was.connected && !now.connected) toast(`<b>${esc(now.name)}</b> lost connection · holding their seat`);
    else if (was && now && !was.connected && now.connected) toast(`<b>${esc(now.name)}</b> is back`);
    if (was && now && was.mode !== 'local' && now.mode === 'local' && now.id !== room.sourceId) toast(`<b>${esc(now.name)}</b> switched to their own copy`);
    if (before.movie?.size !== room.movie?.size && room.movie && !isSource()) toast(`<b>${esc(sourceMember()?.name || 'Your friend')}</b> put on ${esc(room.movie.name)}`);
  }

  reconcile();
  renderAll();
}

function reconcile() {
  if (!room) return;
  const movie = room.movie;
  if (isSource()) {
    // after a reload we're still the source on paper, but the file is gone
  } else if (movie && room.sourceId) {
    if (myMode() === 'local' && (!localFile || localFile.size !== movie.size)) {
      localFile = null; clearSource(); socket.emit('mode', 'stream');
    } else if (myMode() === 'stream' && playingFrom === 'file') {
      // the room switched to a different film than the one we hold
      localFile = null; clearSource();
    }
  } else if (movie && !room.sourceId && localFile && localFile.size === movie.size) {
    // the source left for good; we have the film, so we carry on as source
    becomeSource(localFile);
  } else if (!room.sourceId && playingFrom === 'stream') {
    clearSource();
  }
  updatePeer();
}

// ---------------------------------------------------------------- WebRTC
function updatePeer() {
  const p = peer();
  const shouldSend = isSource() && localFile && playingFrom === 'file' && p?.connected && p.mode === 'stream' && canCapture;
  const shouldRecv = !isSource() && myMode() === 'stream' && room?.sourceId && sourceMember()?.connected;

  if (pc?.role === 'send' && !shouldSend) closePc(true);
  if (pc?.role === 'recv' && !shouldRecv) closePc(false);
  if (shouldSend && !pc) startSending();

  clearTimeout(wantTimer);
  if (shouldRecv && !pc) {
    // Nudge the source in case it missed us (e.g. we reloaded quickly).
    wantTimer = setTimeout(() => { if (!pc && myMode() === 'stream') socket.emit('signal', { type: 'want' }); }, 2500);
  }
  if (isSource() && p?.connected && p.mode === 'stream' && !canCapture && localFile && !updatePeer.warned) {
    updatePeer.warned = true;
    toast('This browser can’t stream video. Use Chrome, Edge or Firefox, or ask your friend to drop their own copy.', 7000);
  }
}

function captureVideo() {
  if (captured && captured.getTracks().some(t => t.readyState === 'live')) return captured;
  if (video.captureStream) captured = video.captureStream();
  else {
    captured = video.mozCaptureStream();
    // Firefox routes captured audio away from the speakers; route it back.
    try {
      const ctx = new AudioContext();
      ctx.createMediaStreamSource(captured).connect(ctx.destination);
    } catch {}
  }
  return captured;
}

function newConn() {
  return new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
}

function preferCodecs(conn) {
  try {
    const caps = RTCRtpReceiver.getCapabilities('video')?.codecs || [];
    const rank = c => /VP9/i.test(c.mimeType) ? 0 : /H264/i.test(c.mimeType) ? 1 : /AV1/i.test(c.mimeType) ? 2 : /VP8/i.test(c.mimeType) ? 3 : 4;
    const sorted = [...caps].sort((a, b) => rank(a) - rank(b));
    conn.getTransceivers().forEach(t => { if (t.sender.track?.kind === 'video') t.setCodecPreferences(sorted); });
  } catch {}
}

// Chrome's bandwidth estimator starts around 300 kb/s and climbs slowly, which
// makes the first minute look like a webcam. Start high and keep a floor.
function boostBitrate(sdp) {
  const lines = sdp.split('\r\n');
  const videoPts = new Set();
  let inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    const m = inVideo && l.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//i);
    if (m) videoPts.add(m[1]);
  }
  return lines.map(l => {
    const m = l.match(/^a=fmtp:(\d+) /);
    if (m && videoPts.has(m[1]) && !l.includes('x-google-start-bitrate')) return l + ';x-google-start-bitrate=5000;x-google-min-bitrate=1500;x-google-max-bitrate=8000';
    return l;
  }).join('\r\n');
}

async function tuneSenders(conn) {
  for (const sender of conn.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 8_000_000;
      params.degradationPreference = 'maintain-resolution';
      params.encodings[0].scaleResolutionDownBy = 1;
      await sender.setParameters(params);
    } catch {}
  }
}

function startSending() {
  const id = Math.random().toString(36).slice(2);
  const conn = newConn();
  const stream = captureVideo();
  pc = { conn, id, role: 'send', stream };

  const add = track => {
    if (conn.getSenders().some(s => s.track === track)) return;
    conn.addTrack(track, stream);
    preferCodecs(conn);
  };
  stream.getTracks().forEach(add);
  stream.onaddtrack = e => pc?.conn === conn && add(e.track);
  stream.onremovetrack = e => { const s = conn.getSenders().find(x => x.track === e.track); if (s) conn.removeTrack(s); };

  conn.onicecandidate = e => e.candidate && socket.emit('signal', { id, ice: e.candidate });
  conn.onnegotiationneeded = async () => {
    try {
      await conn.setLocalDescription();
      socket.emit('signal', { id, sdp: conn.localDescription });
    } catch (err) { console.warn('[rtc] offer', err); }
  };
  watchConn(conn, id);
}

function watchConn(conn, id) {
  conn.onconnectionstatechange = () => {
    if (pc?.conn !== conn) return;
    const s = conn.connectionState;
    if (s === 'connected') {
      if (pc.role === 'send') tuneSenders(conn);
      startStats();
      if (pc.role === 'recv') notice(null);
    }
    if (s === 'failed') {
      linkStats = '';
      if (pc.role === 'send') {
        closePc(true);
        clearTimeout(watchConn.retry);
        watchConn.retry = setTimeout(updatePeer, 1500);
      } else {
        notice('Couldn’t open a direct connection between you two. If you have the film too, drop it in to watch your own copy in sync.', { button: 'Retry', onClick: () => { closePc(false); socket.emit('signal', { type: 'want' }); notice('Connecting…', { spin: true }); } });
      }
    }
    renderAll();
  };
}

async function onSignal(msg) {
  if (msg.type === 'want') { if (isSource()) { closePc(true); updatePeer(); } return; }
  if (msg.type === 'bye') { if (pc?.role === 'recv' && pc.id === msg.id) closePc(false); return; }

  // sender side: answers + candidates from the viewer
  if (pc?.role === 'send') {
    if (msg.id !== pc.id) return;
    try {
      if (msg.sdp) await pc.conn.setRemoteDescription({ type: msg.sdp.type, sdp: boostBitrate(msg.sdp.sdp) });
      else if (msg.ice) await pc.conn.addIceCandidate(msg.ice);
    } catch (err) { console.warn('[rtc] send-side signal', err); }
    return;
  }
  if (isSource()) return;

  // viewer side
  if (msg.sdp?.type === 'offer') {
    if (!pc || pc.id !== msg.id) {
      closePc(false);
      const conn = newConn();
      const remote = new MediaStream();
      pc = { conn, id: msg.id, role: 'recv', remote };
      conn.ontrack = e => {
        remote.addTrack(e.track);
        setStreamSource(remote);
        setStage('playing');
        renderAll();
      };
      conn.onicecandidate = e => e.candidate && socket.emit('signal', { id: msg.id, ice: e.candidate });
      watchConn(conn, msg.id);
    }
    const conn = pc.conn;
    try {
      await conn.setRemoteDescription(msg.sdp);
      await conn.setLocalDescription();
      socket.emit('signal', { id: msg.id, sdp: conn.localDescription });
      for (const c of pendingIce.get(msg.id) || []) await conn.addIceCandidate(c).catch(() => {});
      pendingIce.delete(msg.id);
    } catch (err) { console.warn('[rtc] answer', err); }
    return;
  }
  if (msg.ice) {
    if (pc?.id === msg.id && pc.conn.remoteDescription) pc.conn.addIceCandidate(msg.ice).catch(() => {});
    else { if (!pendingIce.has(msg.id)) pendingIce.set(msg.id, []); pendingIce.get(msg.id).push(msg.ice); }
  }
}

function closePc(tellPeer) {
  if (!pc) return;
  const { conn, id, role, statsTimer } = pc;
  clearInterval(statsTimer);
  if (pc.stream) { pc.stream.onaddtrack = pc.stream.onremovetrack = null; }
  pc = null;
  linkStats = '';
  try { conn.close(); } catch {}
  if (tellPeer && role === 'send') socket?.emit('signal', { type: 'bye', id });
  if (role === 'recv' && playingFrom === 'stream') clearSource();
}

function startStats() {
  if (!pc) return;
  clearInterval(pc.statsTimer);
  const conn = pc.conn;
  let prev = null;
  pc.statsTimer = setInterval(async () => {
    if (pc?.conn !== conn) return;
    const report = await conn.getStats();
    let bytes = 0, w = 0, h = 0, fps = 0, relay = false;
    const pairs = [];
    report.forEach(r => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') { bytes = r.bytesSent; w = r.frameWidth; h = r.frameHeight; fps = r.framesPerSecond; }
      if (r.type === 'inbound-rtp' && r.kind === 'video') { bytes = r.bytesReceived; w = r.frameWidth; h = r.frameHeight; fps = r.framesPerSecond; }
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pairs.push(r);
    });
    if (pairs[0]) { const local = report.get(pairs[0].localCandidateId); relay = local?.candidateType === 'relay'; }
    const now = performance.now();
    const mbps = prev ? ((bytes - prev.bytes) * 8 / ((now - prev.t) / 1000)) / 1e6 : 0;
    prev = { bytes, t: now };
    linkStats = [h ? `${h}p` : '', mbps ? `${mbps.toFixed(1)} Mb/s` : '', relay ? 'relayed' : ''].filter(Boolean).join(' · ');
    renderStatus();
  }, 2000);
}

// ---------------------------------------------------------------- rendering
function setStage(state) { el.stage.dataset.state = state; }

function renderAll() {
  if (!room) return;
  el.roomCode.textContent = room.code;
  el.filmTitle.textContent = room.movie?.name || '';
  renderStage();
  renderStatus();
  renderPeople();
  renderControls();
}

function renderStage() {
  const movie = room.movie, src = sourceMember(), p = peer();
  const hasPicture = playingFrom === 'file' || (playingFrom === 'stream' && video.srcObject?.getVideoTracks().length);
  setStage(hasPicture ? (moviePaused() ? 'ready' : 'playing') : 'empty');
  el.ownCopy.hidden = !(myMode() === 'stream' && movie && !isSource());

  if (hasPicture) {
    if (el.noticeBtn.textContent !== 'Turn on sound' && el.noticeBtn.textContent !== 'Retry') notice(null);
    return;
  }
  // nothing on screen: say why
  el.empty.classList.remove('connecting');
  if (isSource() && !localFile && movie) {
    el.emptyEyebrow.textContent = 'Picking up where you left off';
    el.emptyTitle.textContent = `Drop “${movie.name}” again`;
    el.emptySub.textContent = 'The film plays from your computer, so after a reload it needs to be dropped back in. The room remembers the timestamp.';
    el.chooseLabel.textContent = 'Choose the file';
    notice(null);
  } else if (movie && src && myMode() === 'stream') {
    el.emptyEyebrow.textContent = 'Now showing';
    el.emptyTitle.textContent = movie.name;
    el.empty.classList.toggle('connecting', !!src.connected);
    el.emptySub.textContent = src.connected
      ? `Connecting to ${src.name}’s stream. If you have this film too, drop it here for full quality.`
      : `Waiting for ${src.name} to reconnect. If you have this film too, drop it here.`;
    el.chooseLabel.textContent = 'Use my copy';
    if (el.noticeBtn.textContent !== 'Retry') notice(null);
  } else {
    el.emptyEyebrow.textContent = 'Reel one';
    el.emptyTitle.textContent = 'Drop a film anywhere';
    el.emptySub.textContent = p ? `It plays from your disk the moment you let go. Or wait for ${p.name} to pick something.` : 'It plays from your disk the moment you let go.';
    el.chooseLabel.textContent = 'Choose a file';
    notice(null);
  }
}

function renderStatus() {
  if (!room) return;
  const p = peer(), src = sourceMember();
  let status = '', sync = '', tone = '';
  if (!p) status = 'Waiting for someone to join · share the code';
  else if (!p.connected) status = `${p.name} lost connection`;
  else if (!room.movie) status = `With ${p.name}`;
  else if (isSource()) {
    if (p.mode === 'local') { status = `${p.name} is playing their own copy`; sync = 'In sync'; tone = 'ok'; }
    else if (p.mode === 'stream') {
      status = `Streaming to ${p.name}`;
      const st = pc?.conn.connectionState;
      sync = st === 'connected' ? (linkStats || 'Live') : 'Connecting'; tone = st === 'connected' ? 'ok' : 'warn';
    }
  } else if (myMode() === 'local') {
    status = `Your copy, synced with ${src?.name || 'the room'}`;
    if (driftMs == null || Math.abs(driftMs) < 150) { sync = 'In sync'; tone = 'ok'; }
    else { sync = 'Catching up'; tone = 'warn'; }
  } else if (myMode() === 'stream') {
    status = `Live from ${src?.name || 'your friend'}`;
    const st = pc?.conn.connectionState;
    sync = st === 'connected' ? (linkStats || 'Live') : 'Connecting'; tone = st === 'connected' ? 'ok' : 'warn';
  }
  el.filmStatus.textContent = status;
  el.syncText.textContent = sync;
  el.sync.dataset.tone = tone;
}

function renderPeople() {
  const rows = [...room.members].sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : 0)).map(m => {
    const you = m.id === me.id;
    const role = !room.movie ? 'In the room'
      : m.id === room.sourceId ? 'Playing from their disk'
      : m.mode === 'local' ? 'Own copy, in sync'
      : m.mode === 'stream' ? 'Watching the stream' : 'Here';
    return `<li class="${m.connected ? '' : 'away'}"><span class="avatar">${esc(initial(m.name))}</span>
      <span class="who">${esc(m.name)}${you ? ' <small style="display:inline;color:var(--text-3)">(you)</small>' : ''}<small>${m.connected ? role : 'Reconnecting…'}</small></span></li>`;
  });
  if (room.members.length < 2) rows.push(`<li class="empty-seat"><span class="avatar">+</span><span class="who">Empty seat<small>Share the code ${esc(room.code)}</small></span></li>`);
  el.people.innerHTML = rows.join('');
}

function renderControls() {
  el.ccBtn.hidden = !cues.length;
  el.ccBtn.classList.toggle('on', ccOn && cues.length > 0);
  el.ccBtn.title = cues.length ? `Subtitles: ${subtitleName}` : 'Subtitles';
  const muted = video.volume === 0;
  el.muteBtn.innerHTML = `<svg><use href="#i-${muted ? 'mute' : 'vol'}"/></svg>`;
}

let lastPaused = null;
function frame() {
  if (room && room.movie) {
    const t = movieTime(), d = duration();
    const ratio = d ? Math.min(1, t / d) : 0;
    if (!scrubbing) {
      el.scrubFill.style.width = ratio * 100 + '%';
      el.scrubKnob.style.left = ratio * 100 + '%';
    }
    el.tCur.textContent = fmt(t);
    el.tDur.textContent = d ? fmt(d) : '—';
    if (playingFrom === 'file' && video.buffered.length && d) {
      let end = 0;
      for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= t + 1) end = Math.max(end, video.buffered.end(i));
      el.scrubBuf.style.width = Math.min(100, end / d * 100) + '%';
    } else el.scrubBuf.style.width = '0';
    renderSubs(t);
    const paused = moviePaused();
    if (paused !== lastPaused) {
      lastPaused = paused;
      el.playBtn.innerHTML = `<svg><use href="#i-${paused ? 'play' : 'pause'}"/></svg>`;
      el.playBtn.title = paused ? 'Play (Space)' : 'Pause (Space)';
      if (el.stage.dataset.state !== 'empty') setStage(paused ? 'ready' : 'playing');
      wake();
    }
  } else if (el.subs.textContent) renderSubs(0);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- chat
function addMessage(m, quiet = false) {
  el.messages.querySelector('.hint')?.remove();
  const div = document.createElement('div');
  const mine = m.from === me.id;
  div.className = 'msg' + (mine ? ' mine' : '');
  const time = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  div.innerHTML = `<div class="meta"><b>${esc(mine ? 'You' : m.name)}</b><span>${time}</span></div><p>${esc(m.text)}</p>`;
  el.messages.appendChild(div);
  el.messages.scrollTop = el.messages.scrollHeight;
  if (!mine && !quiet && (!chatOpen || document.fullscreenElement)) {
    el.unread.hidden = chatOpen;
    toast(`<b>${esc(m.name)}</b> ${esc(m.text)}`, 4500);
  }
}
function sysMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg sys';
  div.textContent = text;
  el.messages.querySelector('.hint')?.remove();
  el.messages.appendChild(div);
  el.messages.scrollTop = el.messages.scrollHeight;
}
function setChat(open) {
  chatOpen = open;
  el.room.classList.toggle('chat-open', open);
  el.chatBtn.classList.toggle('on', open);
  if (open) { el.unread.hidden = true; setTimeout(() => el.chatInput.focus({ preventScroll: true }), 350); }
}

// ---------------------------------------------------------------- idle / scrub / input
let idleTimer = null;
function wake() {
  el.stage.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (room?.movie && !moviePaused() && !$('controls').matches(':hover') && !scrubbing) el.stage.classList.add('idle');
  }, 2600);
}

let scrubbing = false;
function scrubRatio(e) {
  const r = el.scrub.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}
function setupScrub() {
  el.scrub.addEventListener('pointermove', e => {
    const d = duration(); if (!d) return;
    const ratio = scrubRatio(e);
    el.scrubTip.textContent = fmt(ratio * d);
    el.scrubTip.style.left = ratio * 100 + '%';
    if (scrubbing) { el.scrubFill.style.width = ratio * 100 + '%'; el.scrubKnob.style.left = ratio * 100 + '%'; }
  });
  el.scrub.addEventListener('pointerdown', e => {
    if (!duration()) return;
    scrubbing = true; el.scrub.classList.add('dragging');
    el.scrub.setPointerCapture(e.pointerId);
    el.scrub.dispatchEvent(new PointerEvent('pointermove', e));
  });
  const end = e => {
    if (!scrubbing) return;
    scrubbing = false; el.scrub.classList.remove('dragging');
    control('seek', scrubRatio(e) * duration());
  };
  el.scrub.addEventListener('pointerup', end);
  el.scrub.addEventListener('pointercancel', () => { scrubbing = false; el.scrub.classList.remove('dragging'); });
}

function setupDrop() {
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (++depth === 1) {
      el.dropveilText.textContent = !room ? 'to open a room and start the film'
        : room.movie && !isSource() ? 'to play your own copy, in sync'
        : 'to start the film';
      el.dropveil.hidden = false;
    }
  });
  window.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; el.dropveil.hidden = true; } });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; el.dropveil.hidden = true;
    handleFiles(e.dataTransfer.files);
  });
  el.chooseBtn.addEventListener('click', () => el.fileInput.click());
  el.ownCopy.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => { handleFiles(el.fileInput.files); el.fileInput.value = ''; });
}

function setupControls() {
  el.playBtn.addEventListener('click', togglePlay);
  el.backBtn.addEventListener('click', () => skip(-10));
  el.fwdBtn.addEventListener('click', () => skip(10));
  // Volume rather than `muted`: muting the element would also silence the stream we send.
  let lastVol = 1;
  el.vol.addEventListener('input', () => { video.volume = +el.vol.value; store.set('mh-vol', el.vol.value); renderControls(); });
  el.muteBtn.addEventListener('click', () => {
    if (video.volume > 0) { lastVol = video.volume; video.volume = 0; } else video.volume = lastVol || 1;
    el.vol.value = video.volume; renderControls();
  });
  const savedVol = parseFloat(store.get('mh-vol'));
  if (Number.isFinite(savedVol)) { video.volume = savedVol; el.vol.value = savedVol; }
  el.ccBtn.addEventListener('click', () => { ccOn = !ccOn; renderControls(); });
  el.chatBtn.addEventListener('click', () => setChat(!chatOpen));
  el.sideClose.addEventListener('click', () => setChat(false));
  el.fullBtn.addEventListener('click', toggleFull);
  el.leaveBtn.addEventListener('click', async () => {
    if (room?.movie && peer() && !(await ask({ title: 'Leave the room?', text: 'If you’re the one playing the film, the stream stops for your friend.', yes: 'Leave' }))) return;
    leave();
  });
  el.inviteBtn.addEventListener('click', async () => {
    const link = `${location.origin}/?r=${room.code}`;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
    catch { toast(`Share this link: ${esc(link)}`, 6000); }
  });
  el.chatForm.addEventListener('submit', e => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (text) socket.emit('chat', text);
    el.chatInput.value = '';
  });

  // click the picture to play/pause; double-click for fullscreen
  let clickTimer = null;
  video.addEventListener('click', () => { clearTimeout(clickTimer); clickTimer = setTimeout(togglePlay, 220); });
  video.addEventListener('dblclick', () => { clearTimeout(clickTimer); toggleFull(); });
  el.stage.addEventListener('pointermove', wake);

  // the source's own events feed the shared clock
  ['play', 'pause', 'seeked', 'waiting', 'playing'].forEach(ev => video.addEventListener(ev, () => { if (isSource()) sendTick(); renderStage(); renderStatus(); }));
  video.addEventListener('ended', () => { if (isSource()) control('pause', video.duration); });
  tickTimer = setInterval(sendTick, 1000);

  document.addEventListener('keydown', e => {
    if (el.room.hidden || e.target.matches?.('input, textarea') || e.metaKey || e.ctrlKey || !el.ask.hidden) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (k === 'arrowleft') { e.preventDefault(); skip(-10); }
    else if (k === 'arrowright') { e.preventDefault(); skip(10); }
    else if (k === 'f') toggleFull();
    else if (k === 'm') el.muteBtn.click();
    else if (k === 'c') { e.preventDefault(); setChat(!chatOpen); }
    else return;
    wake();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && chatOpen && document.activeElement === el.chatInput) { el.chatInput.blur(); } });
}

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.stage.requestFullscreen?.().catch(() => {});
}

// ---------------------------------------------------------------- boot
async function boot() {
  setupDrop();
  setupControls();
  setupScrub();
  requestAnimationFrame(frame);
  try { await identity(); }
  catch { el.lobbyError.textContent = 'Can’t reach the MovieHub server.'; return; }
  connect();
  socket.once('connect', setupLobby);
  window.addEventListener('beforeunload', () => { if (pc) closePc(true); });
}
boot();
})();
