const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('shared playback waits for metadata, catches autoplay denial, and prevents guest seeking', async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      classList: { add() {}, remove() {}, toggle() {} },
      style: {}, events: {}, readyState: 0, currentTime: 0, src: '', paused: true,
      addEventListener(event, fn) { this.events[event] = fn; },
      querySelector() { return { textContent: '', className: '' }; },
      load() { this.loads = (this.loads || 0) + 1; },
      pause() { this.paused = true; },
      play() { this.paused = false; return Promise.reject(new Error('User gesture required')); }
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [], createElement: () => ({}) },
    URL, URLSearchParams, location: { origin: 'http://moviehub.test' },
    window: { location: { search: '' } },
    setTimeout: fn => fn(), setInterval() {}, console, alert() {}
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/init\(\);\s*$/, '');
  vm.runInContext(source, context);
  vm.runInContext(`loadSharedMedia({media:{url:'/movie'},playback:{time:35,paused:true}})`, context);
  const player = element('video-player');
  assert.equal(player.src, 'http://moviehub.test/movie');
  assert.equal(player.currentTime, 0);
  player.readyState = 1;
  player.events.loadedmetadata();
  assert.equal(player.currentTime, 35);
  assert.equal(player.paused, true);
  vm.runInContext('applyPlayback({time:40,paused:false})', context);
  await Promise.resolve();
  assert.equal(player.currentTime, 40);
  vm.runInContext('setupUIListeners()', context);
  element('seek-bar').events.input({ target: { value: 80 } });
  assert.equal(player.currentTime, 40);
});
