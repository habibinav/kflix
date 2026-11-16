const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

test('two users: upload, range streaming, sync, late join, recovery and authorization', async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), MAX_UPLOAD_BYTES: '1024' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.on('data', data => { if (data.toString().includes('server running')) resolve(); }); child.once('exit', code => reject(new Error(`Server exited: ${code}`))); setTimeout(() => reject(new Error('Startup timeout')), 5000).unref(); });
    async function user() {
      const auth = await (await fetch(base + '/api/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      return auth;
    }
    async function connect(auth) {
      const handshake = await (await fetch(base + '/socket.io/?EIO=4&transport=polling')).text();
      const sid = JSON.parse(handshake.slice(1)).sid;
      const url = base + '/socket.io/?EIO=4&transport=polling&sid=' + sid;
      const send = packet => fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: packet });
      const poll = async () => (await (await fetch(url, { signal: AbortSignal.timeout(4000) })).text()).split('\x1e');
      await send('40' + JSON.stringify({ token: auth.token }));
      await poll();
      let id = 0;
      return {
        send, poll,
        async emit(event, value) { await send('42' + JSON.stringify([event, value])); },
        async call(event, value) {
          const n = ++id;
          await send('42' + n + JSON.stringify([event, value]));
          for (;;) for (const packet of await poll()) if (packet.startsWith('43' + n + '[')) return JSON.parse(packet.slice(('43' + n).length))[0];
        }
      };
    }
    const hostAuth = await user(), guestAuth = await user();
    const host = await connect(hostAuth), guest = await connect(guestAuth);
    const room = await host.call('create-room', { nickname: 'Host' });
    assert.equal(room.success, true);
    assert.equal((await guest.call('join-room', {})).success, false);
    const upload = (token, body) => fetch(`${base}/api/rooms/${room.roomCode}/video`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4' }, body });
    assert.equal((await upload(guestAuth.token, 'movie')).status, 403);
    assert.equal((await upload(hostAuth.token, Buffer.alloc(1025))).status, 413);
    const result = await upload(hostAuth.token, Buffer.from('0123456789'));
    assert.equal(result.status, 200);
    const { media } = await result.json();
    assert.equal((await fetch(base + media.url.replace(/key=.*/, 'key=wrong'))).status, 404);
    const range = await fetch(base + media.url, { headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await range.text(), '2345');
    assert.equal((await fetch(base + media.url, { headers: { Range: 'bytes=100-' } })).status, 416);
    await host.emit('play', 12);
    const joined = await guest.call('join-room', room.roomCode);
    assert.equal(joined.media.url, media.url);
    assert.equal(joined.playback.paused, false);
    assert.ok(joined.playback.time >= 12);
    await host.emit('pause', 20);
    const messages = (await guest.poll()).filter(packet => packet.startsWith('42')).map(packet => JSON.parse(packet.slice(2)));
    assert.ok(messages.some(([event, state]) => event === 'playback-state' && state.time === 20 && state.paused));
    await guest.emit('seek', 90);
    await guest.send('41');
    const resumed = await connect(guestAuth);
    const recovery = await resumed.call('resume-room', room.roomCode);
    assert.equal(recovery.success, true);
    assert.equal(recovery.playback.time, 20);
    assert.equal(recovery.playback.paused, true);
    const third = await connect(await user());
    assert.equal((await third.call('join-room', room.roomCode)).success, false);
    await host.emit('join-room', null); // Missing callback must not crash process.
    assert.equal((await fetch(base)).status, 200);
  } finally { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
});
