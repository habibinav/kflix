const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { server } = require('../server');

let base;
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => new Promise(r => { io.managers?.clear?.(); server.close(r); server.closeAllConnections?.(); }));

async function user(name) {
  const { token, userId } = await (await fetch(base + '/api/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const socket = io(base, { auth: { token }, transports: ['websocket'], forceNew: true });
  await new Promise((res, rej) => { socket.once('connect', res); socket.once('connect_error', rej); });
  const call = (ev, data) => new Promise(res => socket.emit(ev, data, res));
  const next = ev => new Promise(res => socket.once(ev, res));
  return { socket, call, next, userId, token, name };
}

test('identity is stable when the token is presented again', async () => {
  const first = await (await fetch(base + '/api/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const again = await (await fetch(base + '/api/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: first.token }) })).json();
  assert.equal(again.userId, first.userId);
});

test('two people: film, stream mode, own copy, shared control, signaling, chat, capacity', async () => {
  const a = await user('Jake'), b = await user('Esh'), c = await user('Third');
  const created = await a.call('create', { name: 'Jake' });
  assert.ok(created.ok);
  const code = created.room.code;
  assert.match(code, /^[A-Z2-9]{6}$/);

  // A drops a film before B arrives
  const movie = await a.call('movie', { name: 'Test Film', size: 1000, duration: 90 });
  assert.equal(movie.room.sourceId, a.userId);

  // B joins late and is put on the stream
  const joined = await b.call('join', { code, name: 'Esh' });
  assert.ok(joined.ok);
  assert.equal(joined.room.movie.name, 'Test Film');
  assert.equal(joined.room.members.find(m => m.id === b.userId).mode, 'stream');

  // a third person is turned away
  const full = await c.call('join', { code, name: 'Third' });
  assert.equal(full.ok, false);

  // signaling is relayed only to the other member
  const sig = b.next('signal');
  a.socket.emit('signal', { id: 'x', sdp: { type: 'offer', sdp: 'v=0' } });
  assert.deepEqual(await sig, { id: 'x', sdp: { type: 'offer', sdp: 'v=0' } });

  // B (not the source) can pause and seek; A hears about it
  const ctl = a.next('control');
  b.socket.emit('control', { action: 'seek', time: 42 });
  const got = await ctl;
  assert.equal(got.time, 42); assert.equal(got.by, 'Esh');

  // ticks only count from the source
  b.socket.emit('tick', { time: 999, paused: false });
  const tick = b.next('tick');
  a.socket.emit('tick', { time: 43, paused: false });
  assert.equal((await tick).time, 43);

  // B switches to their own copy
  const roomUpdate = a.next('room');
  b.socket.emit('mode', 'local');
  assert.equal((await roomUpdate).members.find(m => m.id === b.userId).mode, 'local');

  // shared subtitle track and timing
  const subs = a.next('subtitles');
  b.socket.emit('subtitles', { name: 'film.srt', text: '1\n00:00:01,000 --> 00:00:02,000\nHi\n' });
  assert.equal((await subs).name, 'film.srt');
  const off = a.next('subtitle-offset');
  b.socket.emit('subtitle-offset', 0.6);
  assert.deepEqual(await off, { offset: 0.6, by: 'Esh' });

  // chat
  const msg = a.next('chat');
  b.socket.emit('chat', '  hello  ');
  assert.equal((await msg).text, 'hello');

  // a reconnecting member gets their seat back with the timeline intact
  b.socket.disconnect();
  const b2 = io(base, { auth: { token: b.token }, transports: ['websocket'], forceNew: true });
  await new Promise(r => b2.once('connect', r));
  const back = await new Promise(r => b2.emit('join', { code, name: 'Esh' }, r));
  assert.ok(back.ok);
  assert.ok(back.room.playback.time >= 43);
  assert.equal(back.room.members.length, 2);

  // the room survives the source leaving; the source seat clears
  const nextRoom = new Promise(r => b2.once('room', r));
  await a.call('leave');
  const snap = await nextRoom;
  assert.equal(snap.sourceId, null);
  assert.equal(snap.members.length, 1);

  for (const s of [a.socket, b2, c.socket]) s.disconnect();
});

test('artwork endpoints degrade cleanly without a TMDB key', async () => {
  delete process.env.TMDB_API_KEY; delete process.env.TMDB_READ_TOKEN;
  assert.deepEqual(await (await fetch(base + '/api/posters')).json(), { enabled: false, reason: 'no-key', posters: [] });
  assert.deepEqual(await (await fetch(base + '/api/art?q=Heat&year=1995')).json(), { found: false });
});

test('unauthenticated sockets are refused', async () => {
  const s = io(base, { auth: {}, transports: ['websocket'], forceNew: true, reconnection: false });
  const err = await new Promise(r => s.once('connect_error', r));
  assert.equal(err.message, 'AUTH');
  s.close();
});
