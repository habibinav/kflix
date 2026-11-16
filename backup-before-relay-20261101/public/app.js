/* Kflix client
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
  ccBtn: $('cc-btn'), subPanel: $('sub-panel'), spClose: $('sp-close'), spName: $('sp-name'), spMeta: $('sp-meta'),
  spLoad: $('sp-load'), spRemove: $('sp-remove'), spControls: $('sp-controls'), spShow: $('sp-show'), spOffset: $('sp-offset'),
  spOffsetNote: $('sp-offset-note'), spSize: $('sp-size'), spStyle: $('sp-style'), subInput: $('sub-input'), chatBtn: $('chat-btn'), unread: $('unread'), fullBtn: $('full-btn'),
  toasts: $('toasts'), side: $('side'), sideClose: $('side-close'), people: $('people'),
  messages: $('messages'), chatForm: $('chat-form'), chatInput: $('chat-input'),
  dropveil: $('dropveil'), dropveilText: $('dropveil-text'), fileInput: $('file-input'),
  wall: $('wall'), credit: $('tmdb-credit'), keyHint: $('tmdb-hint'), osd: $('osd'), counter: $('counter'), ambient: $('ambient'), filmCard: $('film-card'), filmPoster: $('film-poster'),
  filmCardYear: $('film-card-year'), filmCardTitle: $('film-card-title'), filmCardOverview: $('film-card-overview'),
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
let subOffset = 0;            // seconds; positive shows each line later
let subPrefs = { size: 'm', style: 'shadow' };
try { Object.assign(subPrefs, JSON.parse(store.get('mh-subs') || '{}')); } catch {}
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
const isSubFile = f => /\.(srt|vtt|ass|ssa)$/i.test(f.name);

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
    if (data) { loadSubtitles(data.text, data.name, data.offset); toast(`<b>${esc(data.by || 'Your friend')}</b> added subtitles · ${esc(data.name)}`); }
    else { clearSubtitles(); toast('Subtitles removed'); }
  });
  socket.on('subtitle-offset', ({ offset, by }) => {
    subOffset = offset; renderSubPanel();
    toast(`<b>${esc(by)}</b> set subtitle timing to ${fmtOffset(offset)}`);
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

}

// A refresh inside a room drops you straight back in.
function resumeRoom() {
  const code = (new URLSearchParams(location.search).get('r') || '').toUpperCase();
  const resume = store.sget('mh-room');
  if (resume && me.name && (!code || code === resume)) enterRoom('join', resume, { quiet: true });
}

// Resolves once we have an identity and a live socket; the lobby is usable before that.
let markReady;
const ready = new Promise(r => { markReady = r; });

let entering = false;
async function enterRoom(kind, code, { quiet = false } = {}) {
  const name = el.nameInput.value.trim() || me.name;
  if (!name && !quiet) { el.lobbyError.textContent = 'Add your name so your friend knows who you are.'; el.nameInput.focus(); return; }
  me.name = name || 'Guest';
  store.set('mh-name', me.name);
  if (entering) return;
  entering = true;
  el.primaryBtn.disabled = true;
  try { await ready; } finally { entering = false; el.primaryBtn.disabled = false; }
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
  if (res.subtitles) loadSubtitles(res.subtitles.text, res.subtitles.name, res.subtitles.offset);
  lastTick = { ...res.room.playback, at: performance.now() };
  onRoom(res.room);
  if (window.innerWidth > 1100 && !res.room.movie) setChat(true, false);
  if (pendingFileAfterCreate) { const f = pendingFileAfterCreate; pendingFileAfterCreate = null; handleFiles([f]); }
}

async function rejoin() {
  const res = await emit('join', { code: room.code, name: me.name });
  if (!res?.ok) { toast(esc(res?.error || 'The room closed.')); leave(); return; }
  iceServers = res.iceServers || iceServers;
  onRoom(res.room);
}

function leave() {
  loadArt(null);
  socket.emit('leave');
  closePc(true);
  clearSource();
  localFile = null; captured = null; room = null; clearSubtitles(); setSubPanel(false);
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

// Subtitle files are often not UTF-8 (older .srt files use Windows-1252), so
// decode carefully instead of trusting readAsText.
function decodeSubtitleBytes(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return new TextDecoder('windows-1252').decode(b); }
}

async function readSubtitleFile(file) {
  if (file.size > 2 * 1024 * 1024) return toast('That subtitle file is too large.');
  let text;
  try { text = decodeSubtitleBytes(await file.arrayBuffer()).replace(/^\uFEFF/, ''); }
  catch { return toast('Couldn’t read that file.'); }
  if (!loadSubtitles(text, file.name, 0)) return toast('Couldn’t find any subtitle lines in that file.');
  socket.emit('subtitles', { name: file.name, text });
  toast(`Subtitles on for both of you · ${esc(file.name)}`);
}

// ---------------------------------------------------------------- subtitles
function parseAss(text) {
  // [Events] Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
  const toSec = t => { const [h, m, s] = t.trim().split(':'); return +h * 3600 + +m * 60 + parseFloat(s); };
  const out = [];
  let fields = null;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^Format:/i.test(line) && !fields) fields = line.slice(7).split(',').map(f => f.trim().toLowerCase());
    if (!/^Dialogue:/i.test(line)) continue;
    const f = fields || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const parts = line.slice(9).split(',');
    const textAt = f.indexOf('text');
    const get = k => parts[f.indexOf(k)];
    const body = parts.slice(textAt).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').trim();
    const start = toSec(get('start')), end = toSec(get('end'));
    if (Number.isFinite(start) && Number.isFinite(end) && body) out.push({ start, end, text: body });
  }
  return out;
}

function clearSubtitles() {
  cues = []; subtitleName = ''; subOffset = 0; lastCue = null;
  el.subs.textContent = '';
  renderControls(); renderSubPanel();
}

function loadSubtitles(text, name, offset = 0) {
  if (/^\s*\[Script Info\]/i.test(text) || /^Dialogue:/m.test(text)) {
    const out = parseAss(text);
    if (!out.length) return false;
    return applyCues(out, name, offset);
  }
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
  return applyCues(out, name, offset);
}

function applyCues(out, name, offset) {
  cues = out.sort((x, y) => x.start - y.start);
  subtitleName = name;
  subOffset = Number(offset) || 0;
  ccOn = true;
  lastCue = null;
  renderControls();
  renderSubPanel();
  return true;
}

// ---------------------------------------------------------------- subtitle panel
const fmtOffset = o => (o === 0 ? '0.0 s' : `${o > 0 ? '+' : '−'}${Math.abs(o).toFixed(1)} s`);
let offsetEmitTimer = null;
function nudgeOffset(d) {
  if (!cues.length) return;
  subOffset = Math.round((subOffset + d) * 10) / 10;
  if (Math.abs(subOffset) < 0.05) subOffset = 0;
  renderSubPanel();
  osd(`SUB ${fmtOffset(subOffset)}`, 1500);
  clearTimeout(offsetEmitTimer);
  offsetEmitTimer = setTimeout(() => socket.emit('subtitle-offset', subOffset), 250);
}

function setSubPanel(open) {
  el.subPanel.hidden = !open;
  el.ccBtn.setAttribute('aria-expanded', String(open));
  if (open) { renderSubPanel(); wake(); }
}

function renderSubPanel() {
  const has = cues.length > 0;
  el.spName.textContent = has ? subtitleName : 'None loaded';
  el.spName.classList.toggle('none', !has);
  el.spMeta.textContent = has ? `${cues.length.toLocaleString()} ${cues.length === 1 ? 'line' : 'lines'} · ends ${fmt(cues[cues.length - 1].end)}` : '';
  el.spRemove.hidden = !has;
  el.spLoad.lastChild.textContent = has ? 'Replace' : 'Load file';
  el.spControls.classList.toggle('disabled', !has);
  el.spOffset.textContent = fmtOffset(subOffset);
  el.spOffset.classList.toggle('changed', subOffset !== 0);
  el.spOffsetNote.textContent = subOffset > 0 ? `Each line shows ${subOffset.toFixed(1)} s later. Click the value to reset.`
    : subOffset < 0 ? `Each line shows ${Math.abs(subOffset).toFixed(1)} s earlier. Click the value to reset.`
    : 'Words show up before people speak? Press +. Keys: G and H.';
  const mark = (group, v) => group.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  mark(el.spShow, ccOn ? 'on' : 'off');
  mark(el.spSize, subPrefs.size);
  mark(el.spStyle, subPrefs.style);
  el.subs.dataset.size = subPrefs.size;
  el.subs.dataset.style = subPrefs.style;
}

function setupSubPanel() {
  el.ccBtn.addEventListener('click', e => { e.stopPropagation(); setSubPanel(el.subPanel.hidden); });
  el.spClose.addEventListener('click', () => setSubPanel(false));
  el.spLoad.addEventListener('click', () => el.subInput.click());
  el.subInput.addEventListener('change', () => { const f = el.subInput.files[0]; if (f) readSubtitleFile(f); el.subInput.value = ''; });
  el.spRemove.addEventListener('click', () => { clearSubtitles(); socket.emit('subtitles', { name: '', text: '' }); });
  el.spShow.addEventListener('click', e => { const v = e.target.closest('button')?.dataset.v; if (!v) return; ccOn = v === 'on'; renderControls(); renderSubPanel(); });
  el.spSize.addEventListener('click', e => { const v = e.target.closest('button')?.dataset.v; if (!v) return; subPrefs.size = v; store.set('mh-subs', JSON.stringify(subPrefs)); renderSubPanel(); });
  el.spStyle.addEventListener('click', e => { const v = e.target.closest('button')?.dataset.v; if (!v) return; subPrefs.style = v; store.set('mh-subs', JSON.stringify(subPrefs)); renderSubPanel(); });
  el.subPanel.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => nudgeOffset(+b.dataset.d)));
  el.spOffset.addEventListener('click', () => { if (subOffset) nudgeOffset(-subOffset); });
  el.subPanel.addEventListener('pointerdown', e => e.stopPropagation());
  document.addEventListener('pointerdown', e => { if (!el.subPanel.hidden && !el.subPanel.contains(e.target) && e.target !== el.ccBtn) setSubPanel(false); });
  renderSubPanel();
}

let lastCue = null;
function renderSubs(t) {
  let text = '';
  if (ccOn && cues.length) {
    t -= subOffset;
    // binary search for the last cue starting before t
    let lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    for (let i = idx; i >= 0 && i > idx - 4; i--) if (cues[i].end >= t) { text = cues[i].text; break; }
  }
  if (text !== lastCue) { el.subs.innerHTML = text ? `<span>${esc(text)}</span>` : ''; lastCue = text; }
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
const skip = d => { if (!room?.movie) return; control('seek', movieTime() + d); osd(`${d > 0 ? '▶▶' : '◀◀'} ${fmt(movieTime())}`); };

function onControl({ action, time, paused, by }) {
  ignoreTicksUntil = 0;
  lastTick = { time, paused, at: performance.now() };
  if (playingFrom === 'file') {
    if (action === 'seek' || Math.abs(video.currentTime - time) > 0.3) video.currentTime = time;
    if (paused) video.pause(); else safePlay();
    video.playbackRate = 1;
  }
  if (action === 'seek') osd(`▶▶ ${fmt(time)}`);
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

  if (before?.movie?.name !== room.movie?.name) loadArt(room.movie?.name);
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


// ---------------------------------------------------------------- artwork
const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

const TYPE_WALL = [
  ['Casablanca', 1942], ['Vertigo', 1958], ['Seven Samurai', 1954], ['Tokyo Story', 1953], ['Chinatown', 1974],
  ['The Godfather', 1972], ['Taxi Driver', 1976], ['Alien', 1979], ['Apocalypse Now', 1979], ['Blade Runner', 1982],
  ['Paris, Texas', 1984], ['Heat', 1995], ['Fargo', 1996], ['In the Mood for Love', 2000], ['Spirited Away', 2001],
  ['City of God', 2002], ['Oldboy', 2003], ['Zodiac', 2007], ['There Will Be Blood', 2007], ['Drive', 2011],
  ['Her', 2013], ['Whiplash', 2014], ['Arrival', 2016], ['Moonlight', 2016], ['Parasite', 2019],
  ['Pather Panchali', 1955], ['Rashomon', 1950], ['Persona', 1966], ['Stalker', 1979], ['Amélie', 2001],
  ['Memories of Murder', 2003], ['Lost in Translation', 2003], ['No Country for Old Men', 2007], ['Past Lives', 2023],
  ['Anatomy of a Fall', 2023], ['Before Sunrise', 1995], ['Pulp Fiction', 1994], ['Goodfellas', 1990]
];

async function buildWall() {
  let items = [], real = false, reason = '';
  try {
    const res = await (await fetch('/api/posters')).json();
    if (res.enabled && res.posters.length >= 12) { items = res.posters; real = true; }
    reason = res.reason || '';
  } catch {}
  // Tell whoever runs the server why there are no posters (only on their own machine).
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  const hints = {
    'no-key': 'Posters are off: add a free TMDB key to .env and restart (see README).',
    'bad-key': 'Posters are off: TMDB rejected the key in .env.',
    'unreachable': 'Posters are off: the server couldn’t reach TMDB from this network.'
  };
  el.keyHint.hidden = !(local && hints[reason]);
  el.keyHint.textContent = hints[reason] || '';
  if (!real) items = TYPE_WALL.map(([title, year]) => ({ title, year }));
  el.credit.hidden = !real;
  shuffle(items);

  const colW = window.innerWidth < 860 ? 120 : 168;
  const cols = Math.max(3, Math.ceil((window.innerWidth * 0.8) / (colW + 14)));
  const perCol = Math.max(4, Math.ceil(window.innerHeight / (colW * 1.5 + 14)) + 1);
  el.wall.style.setProperty('--col-w', colW + 'px');
  el.wall.innerHTML = '';
  let k = 0;
  for (let c = 0; c < cols; c++) {
    const col = document.createElement('div');
    col.className = 'wall-col' + (c % 2 ? ' up' : '');
    col.style.setProperty('--dur', (150 + Math.random() * 90).toFixed(0) + 's');
    col.style.animationDelay = `-${(Math.random() * 120).toFixed(0)}s`;
    const tiles = [];
    for (let r = 0; r < perCol; r++) tiles.push(items[k++ % items.length]);
    // the column holds its tiles twice so the drift loops seamlessly
    for (const item of [...tiles, ...tiles]) {
      const tile = document.createElement('div');
      tile.className = 'wall-tile' + (real ? '' : ' type');
      if (real) {
        const img = new Image();
        img.decoding = 'async';
        img.loading = 'lazy';
        img.alt = '';
        img.onload = () => img.classList.add('in');
        img.src = item.poster;
        tile.appendChild(img);
      } else {
        tile.innerHTML = `<b>${esc(item.title)}</b><span>${item.year}</span>`;
      }
      col.appendChild(tile);
    }
    el.wall.appendChild(col);
  }
  requestAnimationFrame(() => el.wall.classList.add('ready'));
}

let artFor = null;
async function loadArt(name) {
  artFor = name || null;
  el.stage.classList.remove('has-art', 'has-card');
  el.filmCard.hidden = true;
  if (!name) return;
  const m = name.match(/^(.*?)\s*\((\d{4})\)$/);
  const q = m ? m[1] : name, year = m ? m[2] : '';
  let art;
  try { art = await (await fetch(`/api/art?q=${encodeURIComponent(q)}&year=${year}`)).json(); } catch { return; }
  if (artFor !== name || !art?.found) return;
  if (art.backdrop || art.poster) {
    const img = new Image();
    img.onload = () => {
      if (artFor !== name) return;
      el.ambient.style.backgroundImage = `url("${img.src}")`;
      el.stage.classList.add('has-art');
    };
    img.src = art.backdrop || art.poster;
  }
  if (art.poster) {
    el.filmPoster.src = art.poster;
    el.filmCardYear.textContent = art.year || '';
    el.filmCardTitle.textContent = art.title;
    el.filmCardOverview.textContent = art.overview;
    el.filmPoster.onload = () => { if (artFor === name) { el.filmCard.hidden = false; el.stage.classList.add('has-card'); } };
  }
}

// ---------------------------------------------------------------- VCR on-screen display
let osdTimer = null, osdTemp = false;
function osdBase() {
  if (!room?.movie || el.stage.dataset.state === 'empty') return '';
  if (!moviePaused()) return '';
  return movieTime() < 0.5 ? '■ STOP' : '❚❚ PAUSE';
}
function osd(text, ms = 2400) {
  clearTimeout(osdTimer);
  osdTemp = !!text;
  el.osd.textContent = text || osdBase();
  if (text) osdTimer = setTimeout(() => { osdTemp = false; el.osd.textContent = osdBase(); }, ms);
}
function osdRefresh() { if (!osdTemp) el.osd.textContent = osdBase(); }

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
    el.emptyEyebrow.textContent = 'Tape ejected · Resume';
    el.emptyTitle.textContent = `Drop “${movie.name}” again`;
    el.emptySub.textContent = 'The film plays from your computer, so after a reload it needs to be dropped back in. The room remembers the timestamp.';
    el.chooseLabel.textContent = 'Choose the file';
    notice(null);
  } else if (movie && src && myMode() === 'stream') {
    el.emptyEyebrow.textContent = 'Input 1 · Tracking';
    el.emptyTitle.textContent = movie.name;
    el.empty.classList.toggle('connecting', !!src.connected);
    el.emptySub.textContent = src.connected
      ? `Connecting to ${src.name}’s stream. If you have this film too, drop it here for full quality.`
      : `Waiting for ${src.name} to reconnect. If you have this film too, drop it here.`;
    el.chooseLabel.textContent = 'Use my copy';
    if (el.noticeBtn.textContent !== 'Retry') notice(null);
  } else {
    el.emptyEyebrow.textContent = 'Input 1 · No tape';
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
  el.ccBtn.classList.toggle('on', ccOn && cues.length > 0);
  el.ccBtn.title = cues.length ? `Subtitles: ${subtitleName} (S)` : 'Subtitles (S)';
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
      if (!paused) osd('▶ PLAY'); else osd(null);
      wake();
    }
  } else if (el.subs.textContent) renderSubs(0);
  osdRefresh();
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
function setChat(open, focus = true) {
  chatOpen = open;
  el.room.classList.toggle('chat-open', open);
  el.chatBtn.classList.toggle('on', open);
  if (open) { el.unread.hidden = true; if (focus) setTimeout(() => el.chatInput.focus({ preventScroll: true }), 350); }
}

// ---------------------------------------------------------------- idle / scrub / input
let idleTimer = null;
function wake() {
  el.stage.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (room?.movie && !moviePaused() && !$('controls').matches(':hover') && !scrubbing && el.subPanel.hidden) el.stage.classList.add('idle');
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
    const t = scrubRatio(e) * duration();
    osd(`${t >= movieTime() ? '▶▶' : '◀◀'} ${fmt(t)}`);
    control('seek', t);
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
      el.dropveilText.textContent = !room ? 'Release to open a room'
        : room.movie && !isSource() ? 'Release to play your copy'
        : 'Release to play';
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
  setupSubPanel();
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
    else if (k === 's') { e.preventDefault(); setSubPanel(el.subPanel.hidden); }
    else if (k === 'g') nudgeOffset(-0.1);
    else if (k === 'h') nudgeOffset(0.1);
    else if (k === 'escape' && !el.subPanel.hidden) setSubPanel(false);
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
  setupLobby();
  buildWall();
  const bootAt = performance.now();
  setInterval(() => { if (!el.lobby.hidden) el.counter.textContent = fmt((performance.now() - bootAt) / 1000).padStart(7, '0:0'); }, 1000);
  let resizeT; window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (!el.lobby.hidden) buildWall(); }, 400); });
  try { await identity(); }
  catch { el.lobbyError.textContent = 'Can’t reach the Kflix server.'; return; }
  connect();
  socket.once('connect', () => { markReady(); resumeRoom(); });
  window.addEventListener('beforeunload', () => { if (pc) closePc(true); });
}
boot();
})();
