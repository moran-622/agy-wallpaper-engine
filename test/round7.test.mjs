import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const [css, background, picker, daemon] = await Promise.all(
  ['glass-theme.css', 'bg-runtime.js', 'picker-ui.js', 'cdp-daemon.mjs']
    .map(name => readFile(new URL('../src/' + name, import.meta.url), 'utf8')));

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

function page({ observers = true, raf = true } = {}) {
  const window = new EventTarget(), document = new EventTarget();
  const timers = new Map(), frames = new Map(), mutations = [], resizes = [];
  let holes = [];
  document.body = new Element('body'); document.head = new Element('head');
  document.createElement = tag => new Element(tag);
  document.querySelectorAll = () => holes;
  window.innerWidth = 1700; window.innerHeight = 1000;
  window.getComputedStyle = node => node.computed ?? {};
  const observer = list => class {
    targets = new Set();
    constructor(callback) { this.callback = callback; list.push(this); }
    observe(node) { this.targets.add(node); }
    disconnect() { this.targets.clear(); }
  };
  if (observers) {
    window.MutationObserver = observer(mutations);
    window.ResizeObserver = observer(resizes);
  }
  if (raf) {
    window.requestAnimationFrame = fn => { const id = Symbol(); frames.set(id, fn); return id; };
    window.cancelAnimationFrame = id => frames.delete(id);
  }
  const schedule = fn => { const id = Symbol(); timers.set(id, fn); return id; };
  const cancel = id => timers.delete(id);
  const context = createContext({window, document, URL, URLSearchParams, AbortController,
    setTimeout:schedule, setInterval:schedule, clearTimeout:cancel, clearInterval:cancel,
    fetch:async () => ({ok:true, json:async () => ({items:[]})})});
  const payload = {baseUrl:'http://127.0.0.1:35200',
    settings:{enabled:true, activeId:'one', glass:{enabled:true, preset:'liquid-auto'}},
    wallpaper:{id:'one',type:'image',mediaUrl:'/media/one.png'}};
  return {window, document, context, frames, timers, mutations, resizes, payload,
    setHoles(next) { holes = next; },
    mutate() { for (const ob of mutations) if (ob.targets.size) ob.callback([{target:document.body}]); },
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    assertClean() {
      assert.equal(frames.size, 0); assert.equal(timers.size, 0);
      for (const ob of [...mutations, ...resizes]) assert.equal(ob.targets.size, 0);
      for (const name of ['resize','scroll','keydown','message'])
        assert.equal(getEventListeners(window, name).length, 0, name);
      assert.equal(getEventListeners(document, 'visibilitychange').length, 0);
    }};
}
function hole(left = 721, top = 115, right = 1699, bottom = 904) {
  return {getBoundingClientRect() { return {left, top, right, bottom, width:right-left, height:bottom-top}; }};
}

test('Round 7 CSS restores split glass without ancestor-wide exclusion or canvas blur', () => {
  assert.doesNotMatch(css, /:is\(\[data-has-browser-hole="true"\][^)]*\)\s*\*/);
  assert.doesNotMatch(css, /\.agy-sheet:not\(\[data-has-browser-hole/);
  assert.doesNotMatch(css, /\.agy-inset-shell\s*>\s*div/);
  assert.match(css, /body(?:\[data-agy-we-glass="on"\]){5}/);
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [,selectors, declarations] of rules) {
    assert.ok(selectors.trim().startsWith('body[data-agy-we-glass="on"]'));
    if (selectors.includes('[data-main-content-body]')) assert.doesNotMatch(declarations, /backdrop-filter:\s*blur\(/);
  }
  for (const target of ['.browser-hole-opaque', '[data-tiling-pane]', '[data-pane-id]', '[data-split-sash]', '[data-splitter-band]'])
    assert.ok(rules.some(([,s,d]) => s.includes(target) && /background-image:\s*none/.test(d) && /background-color:\s*transparent/.test(d)), target);
  for (const target of ['[data-main-content-body]', '[data-side-panel-body][data-has-browser-hole="true"]', '[data-side-panel-strip]'])
    assert.ok(rules.some(([,s,d]) => s.includes(target) && /box-shadow:\s*none/.test(d)), target);
  assert.ok(rules.some(([,s,d]) => s.includes('.agy-inset-shell') && /--shell-canvas:\s*transparent !important/.test(d)));
  assert.ok(rules.some(([,s,d]) => s.includes('[data-browser-hole="true"]') && /backdrop-filter:\s*none !important/.test(d)));
});

test('Round 7 background clips visible holes, resizes, clamps, removes and cleans pending work', () => {
  const p = page(); p.setHoles([hole()]);
  runInContext(background, p.context); const api = p.window.__agyWeBg;
  api.update(p.payload);
  const root = p.document.body.find(n => n.id === 'agy-we-bg-root');
  assert.equal(root.style.clipPath, 'path(evenodd, "M0 0 H1700 V1000 H0 Z M721 115 H1699 V904 H721 Z")');
  p.setHoles([hole(800, 0, 1800, 1200)]);
  p.resizes[0].callback(); p.mutate(); assert.equal(p.frames.size, 1); p.flush();
  assert.equal(root.style.clipPath, 'path(evenodd, "M0 0 H1700 V1000 H0 Z M800 0 H1700 V1000 H800 Z")');
  const hidden = hole(); hidden.computed = {visibility:'hidden'};
  p.setHoles([hidden, hole(-100, 0, -1, 50), hole(0, 0, 0, 50)]); p.mutate(); p.flush();
  assert.equal(root.style.clipPath, '');
  p.setHoles([]); p.mutate(); p.flush(); assert.equal(root.style.clipPath, '');
  p.mutate(); api.destroy(); p.assertClean();
  api.update(p.payload); api.update({settings:{enabled:false}}); p.assertClean();
});

test('Round 7 overlapping holes stay transparent under evenodd', () => {
  const p = page(); p.setHoles([hole(100,100,300,300), hole(200,200,400,400)]);
  runInContext(background, p.context); p.window.__agyWeBg.update(p.payload);
  const root = p.document.body.find(n => n.id === 'agy-we-bg-root');
  assert.match(root.style.clipPath, /M200 100 H300 V400 H200 Z/);
  p.window.__agyWeBg.destroy(); p.assertClean();
});

test('Round 7 picker moves all controls out of right browser and restores drag preference', () => {
  const p = page(); p.setHoles([hole()]);
  runInContext(picker, p.context); const api = p.window.__agyWePicker; api.mount(p.payload);
  const host = p.document.body.find(n => n.id === 'agy-we-picker-host');
  const dock = host.shadowRoot.find(n => n.className === 'dock');
  dock.style.top = '123px';
  assert.ok(host.classList.has('avoid-right'));
  assert.equal(host.style['--agy-hole-left'], '721px');
  const style = host.shadowRoot.find(n => n.tag === 'style').textContent;
  for (const name of ['dock','drawer','peek-exit']) assert.ok(style.includes(':host(.avoid-right) .' + name));
  assert.match(style, /width:min\(380px,calc\(var\(--agy-hole-left\) - 24px\)\)/);
  p.setHoles([hole(900,0,1700,900)]); p.window.dispatchEvent(new Event('resize')); p.flush();
  assert.equal(host.style['--agy-hole-left'], '900px');
  p.setHoles([hole(0,0,300,900)]); p.mutate(); p.flush();
  assert.ok(!host.classList.has('avoid-right')); assert.equal(host.style['--agy-hole-left'], undefined);
  assert.equal(dock.style.top, '123px');
  p.mutate(); api.destroy(); p.assertClean();
});

test('Round 7 geometry works without observers or animation frame and tolerates missing DOM queries', () => {
  for (const queries of [true, false]) {
    const p = page({observers:false, raf:false}); p.setHoles([hole()]);
    if (!queries) delete p.document.querySelectorAll;
    runInContext(background, p.context); runInContext(picker, p.context);
    p.window.__agyWePicker.mount(p.payload);
    p.window.__agyWeBg.update(p.payload);
    p.window.dispatchEvent(new Event('resize'));
    p.window.__agyWePicker.destroy(); p.window.__agyWeBg.destroy(); p.assertClean();
  }
});

test('Round 7 daemon attaches only HTTPS loopback shells with valid debugger sockets', () => {
  const source = daemon.slice(daemon.indexOf('const loopbackNames'), daemon.indexOf('function connect'));
  const getSocket = runInContext(source + '\ngetPageSocket', createContext({URL}));
  const target = url => ({type:'page', id:'shell', url,
    webSocketDebuggerUrl:'ws://localhost:25001/devtools/page/shell'});
  const media = 'http://127.0.0.1:35200';
  for (const url of ['http://127.0.0.1:8787/#lesson/test', 'http://localhost:3000/', media, 'https://example.com/'])
    assert.equal(getSocket(target(url), 25001, media), null, url);
  for (const url of ['https://127.0.0.1:25000/c/chat', 'https://localhost:25000/settings'])
    assert.equal(getSocket(target(url), 25001, media), 'ws://127.0.0.1:25001/devtools/page/shell');
  assert.equal(getSocket(target('https://localhost:25000/'), 25002, media), null);
});

test('Glass cards contain bleeding markdown tables without killing horizontal scroll', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.ok(rules.some(([, s, d]) =>
    s.includes('[data-testid="agent-response"]') &&
    s.includes('.md-table-host') &&
    /max-width:\s*100%\s*!important/.test(d) &&
    /margin-inline:\s*0\s*!important/.test(d) &&
    /transform:\s*none\s*!important/.test(d)
  ), 'missing .md-table-host containment rule');
  assert.ok(rules.some(([, s, d]) =>
    s.includes('.md-table-scroll') &&
    /max-width:\s*100%\s*!important/.test(d) &&
    /overflow-x:\s*auto\s*!important/.test(d)
  ), 'missing .md-table-scroll horizontal scroll rule');
  assert.ok(rules.some(([, s, d]) =>
    s.includes('.md-table-frame') &&
    /max-width:\s*none\s*!important/.test(d)
  ), 'missing .md-table-frame max-width:none so inner table can overflow .md-table-scroll');
  assert.ok(!rules.some(([, s, d]) =>
    s.includes('.md-table-frame') &&
    /max-width:\s*100%/.test(d)
  ), '.md-table-frame must not clamp to 100% or horizontal scrolling breaks');
});
