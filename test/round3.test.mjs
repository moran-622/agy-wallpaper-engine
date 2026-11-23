import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { createMediaServer } from '../src/media-server.mjs';
import { startCdpDaemon } from '../src/cdp-daemon.mjs';

const [css, picker, background] = await Promise.all(['glass-theme.css', 'picker-ui.js', 'bg-runtime.js']
  .map(file => readFile(new URL('../src/' + file, import.meta.url), 'utf8')));
const items = [
  { id:'one', title:'海岸', type:'image', source:'default', mediaUrl:'/media/file/one/coast.png', previewUrl:'/media/preview/one' },
  { id:'two', title:'晚风', type:'video', source:'workshop', previewUrl:'/media/preview/two' },
];
const baseUrl = 'http://127.0.0.1:35200';
const tick = () => new Promise(setImmediate);
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];

test('runtime routes return exact theme and picker with their MIME types', async t => {
  const server = await createMediaServer({ port:0, scanRoots:[] });
  t.after(() => server.close());
  for (const [name, mime, body] of [['glass.css', 'text/css', css], ['picker.js','text/javascript',picker]]) {
    const response = await fetch(server.baseUrl + '/api/runtime/' + name);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type').split(';')[0], mime);
    assert.equal(await response.text(), body);
  }
});

test('every glass selector is gated and coexisting UI is excluded from backdrop filters', () => {
  assert.ok(rules.length);
  assert.doesNotMatch(css, /#ag-(?:font-faces|custom-fonts)/);
  for (const [, selectors, declarations] of rules) {
    let depth = 0, start = 0;
    for (let i = 0; i <= selectors.length; i++) {
      if (selectors[i] === '(') depth++;
      if (selectors[i] === ')') depth--;
      if (!depth && (selectors[i] === ',' || i === selectors.length)) {
        const selector = selectors.slice(start, i).trim();
        assert.ok(selector.startsWith('body[data-agy-we-glass="on"]'));
        if (/backdrop-filter:\s*blur\(/.test(declarations)) {
          for (const excluded of ['data-has-browser-hole', 'data-has-drawer-browser-hole',
            'data-has-three-layer-browser-hole', '#ag-ui-widgets', '#agy-capsule-native-layout']) {
            assert.ok(selector.includes(excluded), selector + ' must exclude ' + excluded);
          }
        }
        start = i + 1;
      }
    }
  }
});

test('title bar clears the toolbar stacking level and floating menus stay above it', () => {
  assert.doesNotMatch(css, /\.agy-inset-shell\s*>\s*div/);
  const declarationsFor = (target, property) => rules
    .find(([, selectors, declarations]) => selectors.includes(target) && declarations.includes(property))?.[2];
  const title = declarationsFor('.agy-shell > div:first-child', 'z-index');
  assert.match(title, /position:\s*relative\s*!important/);
  assert.match(title, /z-index:\s*90\s*!important/);
  const popper = declarationsFor('[data-radix-popper-content-wrapper]', 'z-index');
  assert.ok(Number(/z-index:\s*(\d+)\s*!important/.exec(popper)?.[1]) > 90);
  assert.match(declarationsFor('[class*="bg-[var(--shell-canvas)]"]', 'background-color'),
    /background-color:\s*transparent\s*!important/);
});

test('reading glass keeps main canvas clear, floats single-layer cards, and removes composer fade strip', () => {
  const blurred = rules.filter(([, , declarations]) => /backdrop-filter:\s*blur\(/.test(declarations));
  for (const target of ['[data-testid="agent-response"]', '.surface-composer-card', '[data-side-panel-body]', '[role="dialog"]']) {
    assert.ok(blurred.some(([, selectors]) => selectors.includes(target)), `Expected blur on ${target}`);
  }
  for (const target of ['[data-main-content-body]', '.surface-composer', '[data-testid="project-header"]']) {
    const exact = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
    assert.ok(!blurred.some(([, selectors]) => exact.test(selectors)), `Expected no blur on ${target}`);
    assert.ok(rules.some(([, selectors, declarations]) => exact.test(selectors)
      && /backdrop-filter:\s*none\s*!important/.test(declarations)));
  }
  const [, , strip = ''] = rules.find(([, selectors]) =>
    selectors.includes('.agy-sheet :is(.pointer-events-none[class*="bottom-0"]')) ?? [];
  assert.match(strip, /background-image:\s*none\s*!important/);
  assert.match(strip, /background-color:\s*transparent\s*!important/);
});

class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.style = { setProperty(k,v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
    this.classList = new Set();
    this.classList.remove = this.classList.delete;
    this.value = '';
  }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  prepend(n) { n.parent = this; this.children.unshift(n); }
  remove() { this.parent.children = this.parent.children.filter(n => n !== this); }
  attachShadow() { return this.shadowRoot = new Element('shadow'); }
  replaceChildren() { this.children = []; }
  setAttribute(k,v) { this.attributes.set(k,String(v)); }
  removeAttribute(k) { this.attributes.delete(k); }
  toggleAttribute(k,on) { if (on) this.setAttribute(k,''); else this.removeAttribute(k); }
  focus() {}
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const match = child.find(predicate);
      if (match) return match;
    }
  }
}

function page() {
  const window = new EventTarget(), document = new EventTarget(), timers = new Map(), patches = [];
  const settings = {enabled:true, activeId:'one', glass:{enabled:true,preset:'liquid-auto'}};
  const payload = {baseUrl, settings, wallpaper:items[0]};
  document.body = new Element('body');
  document.head = new Element('head');
  document.createElement = tag => new Element(tag);
  function schedule(fn,ms) {
    const id = Symbol();
    timers.set(id,{fn,ms});
    return id;
  }
  const cancel = id => timers.delete(id);
  const context = createContext({ window, document, AbortController, URL, URLSearchParams,
    setTimeout:schedule, setInterval:schedule, clearTimeout:cancel, clearInterval:cancel,
    fetch:async (url, opts = {}) => {
      if (opts.method !== 'PATCH') return {ok:true,json:async () => ({items})};
      const patch = JSON.parse(opts.body);
      patches.push(patch);
      for (const [k,v] of Object.entries(patch)) {
        settings[k] = typeof v === 'object' ? {...settings[k],...v} : v;
      }
      return {ok:true,json:async () => structuredClone(settings)};
    },
  });
  return {window,document,context,timers,patches,payload};
}

test('shadow picker filters items, previews tweaks, persists presets and releases listeners', async () => {
  const {context, window, document, payload, patches, timers} = page();
  runInContext(background,context);
  runInContext(picker,context);
  window.__agyWeBg.setTheme(css);
  const api = window.__agyWePicker;
  api.mount(payload);
  api.update(payload);
  const host = document.body.find(n => n.id === 'agy-we-picker-host');
  assert.ok(host.shadowRoot);
  api.open();
  await tick();
  const find = fn => host.shadowRoot.find(fn);
  const click = text => find(n => n.tag === 'button' && n.textContent === text).onclick();
  const grid = find(n => n.className === 'grid');
  assert.equal(grid.children.length,2);
  click('内置');
  assert.deepEqual(grid.children.map(n => n.title),['海岸']);
  click('全部');
  const search = find(n => n.type === 'search');
  search.value = '晚';
  search.oninput();
  grid.children[0].onclick();
  await tick();
  assert.deepEqual(patches.at(-1),{activeId:'two',enabled:true});
  click('液态玻璃与调节');
  click('暗夜影院');
  await tick();
  const range = find(n => n.tag === 'label' && n.textContent === '玻璃磨砂度').children.at(-1);
  const before = patches.length;
  range.value = '30'; range.oninput();
  range.value = '31'; range.oninput();
  assert.equal(document.body.style['--agy-glass-blur'],'31px');
  assert.equal(document.body.attributes.get('data-agy-we-preset'),'cinema-dark');
  assert.equal(patches.length,before);
  await range.onchange();
  assert.deepEqual(patches.at(-1),{glass:{blur:31}});
  click('恢复默认参数');
  await tick();
  assert.equal(patches.at(-1).glass.preset,'liquid-auto');
  assert.equal(payload.settings.activeId,'two');
  api.setPeek(true);
  assert.equal(document.body.attributes.get('data-agy-we-peek'), 'on');
  api.setPeek(false);
  assert.equal(document.body.attributes.get('data-agy-we-peek'), undefined);
  api.close();
  api.destroy(); window.__agyWeBg.destroy();
  assert.equal(timers.size,0);
  assert.equal(document.body.children.length,0);
  assert.equal(getEventListeners(window,'keydown').length,0);
});

test('each picker preset immediately previews and persists its glass values and recommended dim together', async () => {
  const {context, window, document, payload, patches, timers} = page();
  runInContext(background,context);
  runInContext(picker,context);
  window.__agyWeBg.setTheme(css);
  const api = window.__agyWePicker;
  api.mount(payload);
  const host = document.body.find(n => n.id === 'agy-we-picker-host');
  const dimLayer = document.body.find(n => n.id === 'agy-we-bg-root').children[1];
  try {
    for (const [label, preset, dim, blur, surfaceOpacity, sidebarOpacity, cardOpacity, borderGlow] of [
      ['极致赏图', 'crystal', .04, 8, 0, .30, .48, .40],
      ['长文专注', 'frosted', .16, 16, .12, .56, .82, .28],
      ['液态灵动', 'liquid-auto', .10, 14, 0, .44, .68, .34],
      ['暗夜影院', 'cinema-dark', .26, 16, .06, .50, .68, .24],
    ]) {
      const button = host.shadowRoot.find(n => n.tag === 'button' && n.textContent === label);
      button.onclick();
      assert.equal(dimLayer.style.backgroundColor, `rgba(0, 0, 0, ${dim})`);
      assert.equal(document.body.style['--agy-glass-blur'], blur + 'px');
      await tick();
      assert.deepEqual(patches.at(-1), {
        bg: { dim }, glass: { enabled: true, preset, blur, surfaceOpacity, sidebarOpacity, cardOpacity, borderGlow },
      });
      assert.equal(button.attributes.get('aria-pressed'), 'true');
    }
  } finally {
    api.destroy();
    window.__agyWeBg.destroy();
  }
  assert.equal(timers.size, 0);
});

test('rotation runs with picker closed, only on leader, and disables cleanly', async () => {
  const {window,context,document,timers,patches,payload} = page();
  runInContext(background,context);
  const bg = window.__agyWeBg;
  bg.setTheme(css);
  payload.settings.slideshow = {enabled:true,intervalSec:60};
  bg.update({...payload,slideshowLeader:false});
  assert.equal(timers.size,0);
  bg.update(payload);
  const [[id,{fn,ms}]] = timers;
  assert.equal(ms,60000);
  timers.delete(id); await fn();
  assert.deepEqual(patches,[{activeId:'two'}]);
  bg.update({...payload,settings:{...payload.settings,enabled:false}});
  assert.equal(document.body.attributes.has('data-agy-we-glass'),false);
  assert.equal(document.head.children.length,0);
  assert.equal(timers.size,0);
});

test('daemon injects all assets into a mock page and stop restores its DOM', async t => {
  const mock = page();
  const port = 30021;
  const folder = await mkdtemp(join(tmpdir(),'agy-round3-'));
  const portFile = join(folder,'mock-port');
  t.after(() => rm(folder,{recursive:true,force:true}));
  await writeFile(portFile,String(port));
  t.mock.method(globalThis,'fetch', async url => {
    const endpoints = {
      ['/json/list']:[{type:'page',id:'one',url:'https://localhost/c/mock',webSocketDebuggerUrl:'ws://localhost:'+port+'/devtools/page/one'}],
      ['/api/settings']:mock.payload.settings, ['/api/wallpapers']:{items},
    };
    const value = endpoints[new URL(url).pathname];
    assert.ok(value);
    return {ok:true,json:async () => value};
  });
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(message) {
      const {id,method,params} = JSON.parse(message);
      const value = method === 'Runtime.evaluate' && runInContext(params.expression,mock.context);
      this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id,result:{result:{value}}})}));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = original; });
  const daemon = await startCdpDaemon({baseUrl,portFile,once:true});
  try {
    await daemon.ready;
    assert.ok(mock.document.body.find(n => n.id === 'agy-we-picker-host')?.shadowRoot);
    assert.equal(mock.document.head.find(n => n.id === 'agy-we-glass-style').textContent,css);
    assert.equal(mock.window.__agyWeBg.getState().activeId,'one');
  } finally { await daemon.stop(); }
  assert.deepEqual(mock.document.body.children,[]);
  assert.deepEqual(mock.document.head.children,[]);
  assert.equal(getEventListeners(mock.window,'keydown').length,0);
});
