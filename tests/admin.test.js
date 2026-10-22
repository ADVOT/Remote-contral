import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('offline saved Tailscale address cannot accompany the visible WLAN selection', async () => {
  class Element {
    constructor(tag = '') { this.tagName = tag; this.children = []; this.listeners = {}; this.hidden = false; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(event, callback) { this.listeners[event] = callback; }
  }
  const html = fs.readFileSync(new URL('../ui/admin.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const intervals = new Map(), actions = [];
  let state = {
    running: false, enabled: true, hostname: 'fixture', tls: false,
    addresses: ['100.64.0.10'], interfaces: [{ address: '192.0.2.10', name: 'WLAN', kind: 'lan' }],
    urls: [], devices: [], accounts: [], pairing: null, error: '请选择当前可用的网络地址',
  };
  const context = {
    document: { hidden: false, getElementById: id => elements.get(id), createElement: tag => new Element(tag) },
    setInterval: (callback, delay) => intervals.set(delay, callback), setTimeout() {},
    fetch: async (_url, options) => {
      if (options?.method === 'POST') {
        const action = JSON.parse(options.body); actions.push(action);
        assert.deepEqual(action.addresses, ['192.0.2.10']);
        state = { ...state, running: true, addresses: action.addresses, urls: ['http://192.0.2.10:3940/'], error: '' };
      }
      return { ok: true, json: async () => structuredClone(state) };
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../ui/admin.js', import.meta.url), 'utf8'), context);
  await new Promise(setImmediate);
  assert.equal(elements.get('start').disabled, true);
  assert.equal(elements.get('network-notice').hidden, false);
  const check = elements.get('networks-list').children[0].children[0];
  assert.equal(check.value, '192.0.2.10');
  check.checked = true; check.listeners.change();
  assert.equal(elements.get('start').disabled, false);
  await elements.get('start').onclick();
  assert.equal(actions.length, 1);
  assert.equal(elements.get('status').textContent, '连接已开启');
  assert.equal(elements.get('error').hidden, true);
  assert.equal(elements.get('network-notice').hidden, true);
  // An interface disappearing during refresh must also remove its checked selection.
  state = { ...state, running: false, interfaces: [], urls: [] };
  await intervals.get(5000)();
  assert.equal(elements.get('start').disabled, true);
  // Bringing an address back does not silently select or expose it.
  state = { ...state, interfaces: [{ address: '100.64.0.10', name: 'Tailscale', kind: 'tailscale' }] };
  await intervals.get(5000)();
  assert.equal(elements.get('networks-list').children[0].children[0].checked, false);
  assert.equal(elements.get('start').disabled, true);
});
