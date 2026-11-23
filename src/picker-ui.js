(() => {
  const PICKER_VERSION = '2026.11.r11b';
  const previous = window.__agyWePicker;
  if (previous?.version === PICKER_VERSION) return;
  try { previous?.destroy?.(); } catch {}
  delete window.__agyWePicker;

  const presets = {
    'liquid-auto': ['液态灵动', .10, 14, 0, .44, .68, .34],
    crystal: ['极致赏图', .04, 8, 0, .30, .48, .40],
    frosted: ['长文专注', .16, 16, .12, .56, .82, .28],
    'cinema-dark': ['暗夜影院', .26, 16, .06, .50, .68, .24],
  };
  function presetSettings(preset) {
    const [, dim, blur, surfaceOpacity, sidebarOpacity, cardOpacity, borderGlow] = presets[preset];
    return { bg: { dim }, glass: { enabled: true, preset, blur, surfaceOpacity, sidebarOpacity, cardOpacity, borderGlow } };
  }
  const balanced = presetSettings('liquid-auto');
  const defaults = {
    bg: { ...balanced.bg, opacity: 1, blur: 0, fit: 'cover', muted: true, volume: 0, fpsLimit: 30, pauseOnHidden: true },
    glass: { ...balanced.glass, toneMode: 'auto' }, slideshow: { enabled: false, intervalSec: 300 },
  };
  const tones = { auto: '跟随宿主', light: '浅色玻璃', dark: '深色玻璃' };
  const sliders = [
    ['bg.dim', '壁纸压暗', 0, .75], ['bg.blur', '壁纸模糊', 0, 24, 'px'],
    ['glass.surfaceOpacity', '画布薄纱（0% 全清透）', 0, .75],
    ['glass.cardOpacity', '消息与输入框底板', .25, .94],
    ['glass.sidebarOpacity', '侧栏与顶栏透明底', .12, .88],
    ['glass.blur', '玻璃磨砂度', 0, 32, 'px'],
    ['glass.borderGlow', '液态高光边框', 0, .6],
  ];
  const styles = `
    :host { all:initial; font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif; color-scheme:light dark;
      --paper:light-dark(#f6f7f9,#212632); --ink:light-dark(#202731,#f8f7f3); --sub:light-dark(#515d69,#bbc4cd);
      --accent:light-dark(#126466,#87ddcf); --wash:color-mix(in srgb,var(--ink) 7%,transparent);
      --line:color-mix(in srgb,var(--ink) 16%,transparent); color:var(--ink); }
    :host-context(.theme-light){color-scheme:light} :host-context(.dark),:host-context(.theme-dark){color-scheme:dark}
    :host-context(body[data-agy-we-glass="on"][data-agy-we-tone="light"]){color-scheme:light}
    :host-context(body[data-agy-we-glass="on"][data-agy-we-tone="dark"]),
    :host-context(body[data-agy-we-glass="on"][data-agy-we-tone="auto"][data-agy-we-preset="cinema-dark"]){color-scheme:dark}
    *,*::before,*::after{box-sizing:border-box} [hidden]{display:none!important}
    button,input,select{font:inherit;color:inherit;accent-color:var(--accent)} button,select{cursor:pointer}
    button{border:0;background:var(--wash);border-radius:9px;padding:6px 10px}
    button:hover{background:color-mix(in srgb,var(--accent) 15%,var(--paper))}
    button:disabled{cursor:default;opacity:.55}
    :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .dock,.drawer{position:fixed;pointer-events:auto;background:color-mix(in srgb,var(--paper) 76%,transparent);
      backdrop-filter:blur(22px) saturate(175%);box-shadow:inset 0 1px 0 #ffffff90,0 14px 42px -12px #12203558}
    .peek-exit{position:fixed;right:18px;bottom:18px;pointer-events:auto;padding:8px 14px;border-radius:99px;
      border:1px solid #ffffff55;background:#10162288;color:#fff;backdrop-filter:blur(12px);font-size:13px}
    .dock{right:6px;top:72%;width:44px;height:44px;border:1px solid var(--line);border-radius:17px;touch-action:none;color:var(--accent)}
    .dock svg{width:22px;height:22px;display:block}
    .drawer{right:12px;top:46px;bottom:18px;width:min(380px,calc(100vw - 24px));display:flex;flex-direction:column;
      border:1px solid var(--line);border-radius:20px;overflow:hidden;visibility:hidden;
      transform:translateX(calc(100% + 20px));transition:transform .22s cubic-bezier(.2,.8,.2,1),visibility .22s}
    :host(.avoid-right) .dock{right:calc(100vw - var(--agy-hole-left) + 10px)}
    :host(.avoid-right) .drawer{left:12px;right:auto;width:min(380px,calc(var(--agy-hole-left) - 24px));transform:translateX(calc(-100% - 20px))}
    :host(.avoid-right) .peek-exit{left:18px;right:auto;max-width:calc(var(--agy-hole-left) - 36px)}
    .drawer.open,:host(.avoid-right) .drawer.open{visibility:visible;transform:none}
    header,footer,.toolbar,.row,.chips,.tabs{display:flex;align-items:center;gap:8px}
    header{padding:18px 18px 12px} h2{margin:0 auto 0 0;font-size:19px;letter-spacing:-.03em}
    header label{display:flex;gap:4px;align-items:center;font-size:13px}
    .tabs{margin:0 16px 12px;padding:3px;background:var(--wash);border-radius:12px;gap:3px}
    .tabs button{flex:1;background:transparent} .tabs [aria-pressed=true]{background:var(--paper);box-shadow:0 1px 4px #13223822}
    main{min-height:0;flex:1;overflow:auto;padding:2px 17px 18px;scrollbar-width:thin;
      scrollbar-color:color-mix(in srgb,var(--ink) 42%,transparent) transparent}
    input[type=search],select{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--paper)}
    .toolbar input[type=search]{flex:1;min-width:0;width:auto}.toolbar button{flex:none}
    .chips{margin:12px 0;flex-wrap:nowrap;gap:4px}.chips button{position:relative;flex:1 1 0;min-width:0;padding:5px 4px;border-radius:99px;font-size:12px;text-align:center;white-space:nowrap}
    .chips button[data-has-items="true"]::after{content:'';position:absolute;top:4px;right:5px;width:5px;height:5px;border-radius:50%;background:var(--accent)}
    .chips button[aria-pressed=true][data-has-items="true"]::after{background:var(--paper)}
    .chips [aria-pressed=true],.presets [aria-pressed=true],.tones [aria-pressed=true]{background:var(--accent);color:var(--paper)}
    .tones{display:flex;gap:4px;margin-bottom:8px}.tones button{flex:1;padding-inline:4px}
    .tone-label{margin:0 0 8px}
    .grid,.presets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 10px}
    .tile{min-width:0;position:relative;border:1px solid var(--line);border-radius:12px}
    .tile-select{display:block;width:100%;padding:0;overflow:hidden;text-align:left;border-radius:11px}
    .tile:has(.tile-select[aria-pressed=true]){outline:2px solid var(--accent);outline-offset:1px;
      box-shadow:0 3px 10px color-mix(in srgb,var(--accent) 28%,transparent)}
    .tile img,.placeholder{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;background:var(--wash)}
    .title{display:block;padding:8px 9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:550}
    .badge{position:absolute;top:6px;left:6px;border-radius:5px;background:#19232cd9;color:white;font:600 10px/1.6 system-ui;padding:0 5px}
    .tile-actions{position:absolute;top:5px;right:5px;display:flex;gap:4px}
    .tile-actions button{display:grid;place-items:center;width:26px;height:26px;padding:0;border-radius:8px;
      background:#19232ce8;color:white;line-height:1}
    .tile-actions button:hover{background:#344655}
    .tile-actions svg{width:15px;height:15px}
    .tile-actions [aria-pressed=true]{color:#ffdb7f}
    .tile-actions [aria-pressed=true] svg{fill:currentColor}
    .trash-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 10px;
      margin:0 0 12px;padding:8px 9px;border:1px solid var(--line);border-radius:10px}
    .trash-toolbar>span,.trash-warning{color:var(--sub);font-size:12px}
    .trash-toolbar>span{flex:1 1 130px}
    .trash-toolbar .trash-actions{justify-content:flex-end;margin-left:auto}
    .trash-actions{display:flex;align-items:center;flex-wrap:wrap;gap:4px}
    .trash-actions button{font-size:12px;white-space:nowrap;padding-inline:7px}
    .trash-card-actions{padding:0 7px 7px}
    .trash-warning{flex-basis:100%}
    .trash-card-actions,.trash-preview{cursor:default}
    .trash-danger{color:light-dark(#a12a32,#ffabb0)}
    @media(max-width:340px){.toolbar{flex-wrap:wrap}.toolbar input[type=search]{flex:1 0 100%}}
    h3{font-size:14px;margin:20px 0 8px}.row{min-height:34px;justify-content:space-between}
    .row select{width:auto;padding:4px 7px}.range{display:block;margin:10px 0}
    .range span{float:right;color:var(--sub);font-variant-numeric:tabular-nums}
    input[type=range]{display:block;width:100%;margin:6px 0}.presets button{min-height:36px}
    footer{border-top:1px solid var(--line);padding:10px 16px;color:var(--sub);font-size:12px;flex-wrap:wrap}
    footer output{margin-right:auto} footer button{font-size:12px;white-space:nowrap} .empty{color:var(--sub);padding:16px 0}
    @media(prefers-reduced-motion:reduce){.drawer{transition:none}}
  `;

  // Event-driven geometry tracking; no polling fallback in minimal VM environments.
  function watchBrowserHoles(owner, apply) {
    if (typeof document.querySelectorAll !== 'function') return () => {};
    let stopped = false, frame, observed = [];
    const raf = typeof window.requestAnimationFrame === 'function'
      && typeof window.cancelAnimationFrame === 'function';
    const Resize = window.ResizeObserver ?? globalThis.ResizeObserver;
    const Mutation = window.MutationObserver ?? globalThis.MutationObserver;
    const resize = typeof Resize === 'function' ? new Resize(schedule) : null;
    function sync() {
      frame = undefined;
      if (stopped) return;
      const width = window.innerWidth, height = window.innerHeight;
      const nodes = [...document.querySelectorAll('[data-browser-hole="true"]')];
      const next = [document.body, ...nodes].filter(Boolean);
      if (next.length !== observed.length || next.some((n, i) => n !== observed[i])) {
        resize?.disconnect();
        for (const node of next) resize?.observe(node);
        observed = next;
      }
      const holes = [];
      if (Number.isFinite(width) && Number.isFinite(height)) for (const node of nodes) {
        if (typeof node.getBoundingClientRect !== 'function') continue;
        const rect = node.getBoundingClientRect();
        const computed = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(node) : null;
        if (computed?.display === 'none' || ['hidden', 'collapse'].includes(computed?.visibility)) continue;
        const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
        const right = Math.min(width, rect.right), bottom = Math.min(height, rect.bottom);
        if (rect.width > 0 && rect.height > 0 && right > left && bottom > top)
          holes.push({ left, top, right, bottom, width: right - left, height: bottom - top });
      }
      apply(holes, width, height);
    }
    function schedule() {
      if (stopped || frame !== undefined) return;
      if (raf) frame = window.requestAnimationFrame(sync);
      else sync();
    }
    const mutation = typeof Mutation === 'function' ? new Mutation(records => {
      // Our own style writes and artwork changes must not schedule another frame.
      if (records.some(({ target }) => target !== owner && !owner.contains?.(target))) schedule();
    }) : null;
    mutation?.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['data-browser-hole', 'data-has-browser-hole', 'data-has-drawer-browser-hole',
        'data-has-three-layer-browser-hole', 'class', 'style', 'hidden'] });
    window.addEventListener?.('resize', schedule);
    window.addEventListener?.('scroll', schedule, { capture: true });
    sync();
    return () => {
      stopped = true;
      mutation?.disconnect();
      resize?.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      observed = [];
      window.removeEventListener?.('resize', schedule);
      window.removeEventListener?.('scroll', schedule, { capture: true });
    };
  }

  let stopHoles;
  let host, root, panel, dock, peekBtn, library, controls, grid, search, status, tabLibrary, tabControls;
  let payload, items = [], filter = '全部', opened = false, peeking = false, loaded = false, notice = '';
  let pending = {}, writing, writeTask, debounce, heartbeat, life, scan = 0;
  let importButton, randomButton, trashToolbar, mediaBusy = false, renderedFavorites;
  let trashItems = [], hiddenCount = 0, purgeTarget = null;
  let loadFailed = false;
  const fields = new Map(), filters = new Map(), presetButtons = new Map(), toneButtons = new Map();

  function merge(base, patch) {
    const next = { ...base, ...patch };
    for (const group of ['bg', 'glass', 'slideshow']) {
      if (patch[group]) next[group] = { ...base[group], ...patch[group] };
    }
    return next;
  }
  function settings() {
    return merge(merge(merge(defaults, payload.settings), writing ?? {}), pending);
  }
  function node(tag, parent, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    parent.append(el);
    return el;
  }
  function button(parent, label, fn, cls) {
    const el = node('button', parent, label, cls);
    el.type = 'button';
    el.onclick = fn;
    return el;
  }
  function preview() {
    const cfg = settings();
    const same = payload.wallpaper?.id === cfg.activeId;
    const wallpaper = same ? payload.wallpaper : items.find(item => item.id === cfg.activeId);
    window.__agyWeBg?.update({ ...payload, settings: cfg, wallpaper, manifest: same ? payload.manifest : null });
  }
  function refreshStatus() {
    const state = window.__agyWeBg?.getState() ?? {};
    const modes = { scene: state.stats?.fps ? 'WebGL ' + Math.round(state.stats.fps) + ' FPS' : 'WebGL',
      video: '视频', 'embedded-video': '内嵌视频', image: '图片', web: '网页', preview: '已降级预览',
      idle: settings().enabled ? '请选择壁纸' : '壁纸已关闭', unavailable: '壁纸不可用' };
    const message = notice || modes[state.mode] || '正在加载壁纸…';
    if (status.textContent !== message) status.textContent = message;
  }
  function flush() {
    clearTimeout(debounce);
    if (writing) return writeTask;
    if (!Object.keys(pending).length) return;
    writeTask = saveSettings();
    return writeTask;
  }
  async function saveSettings() {
    writing = pending;
    pending = {};
    const lifetime = life;
    try {
      const response = await fetch(payload.baseUrl + '/api/settings', {
        method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(writing), signal:lifetime.signal,
      });
      if (!response.ok) throw Error();
      const saved = await response.json();
      if (life === lifetime) payload = { ...payload, settings:saved };
    } catch {
      if (life === lifetime) notice = '保存失败，请重试';
    } finally {
      if (life === lifetime) {
        writing = undefined;
        writeTask = undefined;
        preview();
        sync();
        if (Object.keys(pending).length) void flush();
      }
    }
  }
  function change(patch, delayed = false) {
    notice = '';
    pending = merge(pending, patch);
    preview();
    sync();
    clearTimeout(debounce);
    if (delayed) debounce = setTimeout(flush, 180);
    else void flush();
  }
  function matchingItems(favorites) {
    const query = search.value.trim().toLowerCase();
    const types = { '场景':'scene', '视频':'video', '网页':'web' };
    const source = filter === '回收站' ? trashItems : items;
    return source.filter(item => item.title.toLowerCase().includes(query)
      && (filter !== '收藏' || favorites.has(item.id))
      && (filter !== '内置' || item.source === 'default')
      && (!types[filter] || item.type === types[filter]));
  }
  function trashAction(parent, action, label, onClick, className) {
    const control = button(parent, label, onClick, className);
    control.dataset.action = action;
    control.disabled = mediaBusy;
    return control;
  }
  function drawPurgeActions(actions, target, label, confirmLabel, warning) {
    if (purgeTarget !== target) {
      trashAction(actions, 'purge', label, () => {
        purgeTarget = target;
        drawGrid();
      }, 'trash-danger');
      return;
    }
    if (warning) node('span', actions, warning, 'trash-warning');
    trashAction(actions, 'purge', confirmLabel, () => void purgeWallpapers(target), 'trash-danger');
    trashAction(actions, 'cancel', '取消', () => {
      purgeTarget = null;
      drawGrid();
    });
  }
  function drawTrashToolbar() {
    const focusedAction = root.activeElement?.closest('.trash-toolbar') && root.activeElement.dataset.action;
    trashToolbar.replaceChildren();
    trashToolbar.hidden = filter !== '回收站' || !trashItems.length;
    if (!trashToolbar.hidden) {
      const warnsOfLocalFiles = purgeTarget === true && trashItems.some(item => item.source === 'upload');
      node('span', trashToolbar, warnsOfLocalFiles ? '本地导入的文件将被删除' : `回收站 (${trashItems.length}) · 可复原或彻底删除`);
      const actions = node('div', trashToolbar, undefined, 'trash-actions');
      if (purgeTarget !== true) {
        trashAction(actions, 'restore', '全部复原', () => void restoreWallpapers({ all: true }));
      }
      drawPurgeActions(actions, true, '清空回收站', '确认清空？');
      if (focusedAction) {
        const nextAction = focusedAction === 'cancel' ? 'purge' : focusedAction;
        ([...actions.children].find(el => el.dataset.action === nextAction) ?? filters.get(filter)).focus();
      }
    } else if (focusedAction) filters.get(filter).focus();
  }
  function drawGrid() {
    const cfg = settings();
    renderedFavorites = JSON.stringify(cfg.favorites ?? []);
    const favorites = new Set(cfg.favorites);
    const activeElement = root.activeElement;
    const focusedId = activeElement?.closest('.tile')?.dataset.id;
    const focusedAction = activeElement?.dataset.action;
    const inTrash = filter === '回收站';
    drawTrashToolbar();
    grid.replaceChildren();
    let restoreFocus;
    const matching = matchingItems(favorites);
    matching.sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)));
    for (const item of matching) {
      const card = node('div', grid, undefined, 'tile');
      card.dataset.id = item.id;
      card.title = item.title;
      const select = inTrash ? node('div', card, undefined, 'tile-select trash-preview') : button(card, '', null, 'tile-select');
      if (!inTrash) {
        card.onclick = () => { if (!mediaBusy) change({ activeId:item.id, enabled:true }); };
        select.dataset.action = 'select';
        select.setAttribute('aria-pressed', item.id === cfg.activeId);
      }
      if (item.previewUrl?.startsWith('/media/preview/') || (item.type === 'image'
        && item.source === 'upload' && item.previewUrl?.startsWith('/media/file/'))) {
        const img = node('img', select);
        img.alt = '';
        img.loading = 'lazy';
        img.src = new URL(item.previewUrl, payload.baseUrl).href;
        img.onerror = () => { img.style.visibility = 'hidden'; };
      } else node('span', select, '', 'placeholder');
      const badge = node('span', select, { scene:'场景',video:'视频',web:'网页',image:'图片' }[item.type], 'badge');
      badge.setAttribute('aria-hidden', 'true');
      node('span', select, item.title, 'title');
      if (inTrash) {
        const actions = node('div', card, undefined, 'trash-actions trash-card-actions');
        if (purgeTarget !== item.id) {
          trashAction(actions, 'restore', '复原', () => void restoreWallpapers({ id: item.id }));
        }
        const warning = item.source === 'upload' ? '将删除本地文件' : '将永久移除，不删磁盘文件';
        drawPurgeActions(actions, item.id, '彻底删除', '确认彻底删除', warning);
        if (item.id === focusedId) {
          const nextAction = focusedAction === 'cancel' ? 'purge' : focusedAction;
          restoreFocus = [...actions.children].find(el => el.dataset.action === nextAction);
        }
        continue;
      }
      const actions = node('div', card, undefined, 'tile-actions');
      const star = button(actions, '', (event) => {
        event.stopPropagation();
        if (mediaBusy) return;
        const next = new Set(settings().favorites);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        change({ favorites: [...next] });
      });
      star.dataset.action = 'favorite';
      star.title = favorites.has(item.id) ? '取消收藏' : '收藏';
      star.setAttribute('aria-label', '收藏 ' + item.title);
      star.setAttribute('aria-pressed', favorites.has(item.id));
      star.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9Z"/></svg>';
      const remove = button(actions, '×', (event) => {
        event.stopPropagation();
        void hideWallpaper(item);
      });
      remove.dataset.action = 'delete';
      remove.title = '移入回收站';
      remove.setAttribute('aria-label', '移入回收站 ' + item.title);
      if (item.id === focusedId) {
        restoreFocus = [select, ...actions.children].find(el => el.dataset.action === focusedAction);
      }
    }
    if (!grid.children.length) {
      let empty = '没有匹配的壁纸';
      if (inTrash && !trashItems.length) empty = '回收站为空';
      if (filter === '收藏' && !search.value.trim()) empty = '还没有收藏，点击壁纸上的星标即可添加';
      if (loadFailed) empty = '壁纸库读取失败，请刷新';
      else if (!loaded) empty = '正在读取壁纸库…';
      node('span', grid, empty, 'empty');
    }
    if (focusedId) (restoreFocus ?? filters.get(filter)).focus();
    refreshStatus();
  }
  function setFilter(label) {
    if (label !== filter) purgeTarget = null;
    filter = label;
    randomButton.disabled = mediaBusy || filter === '回收站';
    for (const [name, el] of filters) el.setAttribute('aria-pressed', name === filter);
  }
  function setMediaBusy(busy, message) {
    mediaBusy = busy;
    importButton.disabled = busy;
    randomButton.disabled = busy || filter === '回收站';
    grid.setAttribute('aria-busy', String(busy));
    notice = message;
    if (filter === '回收站') drawGrid();
    else refreshStatus();
  }
  async function importLocal(file) {
    if (!file || mediaBusy) return;
    const lifetime = life;
    setMediaBusy(true, '正在导入壁纸…');
    let message = '导入失败，请重试';
    try {
      const response = await fetch(payload.baseUrl + '/api/uploads', {
        method: 'POST', body: file, signal: lifetime.signal,
        headers: { 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' },
      });
      if (response.status === 413) message = '壁纸大小不能超过 200 MB';
      if (response.status === 400) message = '请选择支持的图片或视频文件';
      if (!response.ok) throw Error();
      const item = await response.json();
      if (life !== lifetime) return;
      items = [...items.filter(existing => existing.id !== item.id), item];
      search.value = '';
      setFilter('全部');
      message = '';
      change({ activeId: item.id, enabled: true });
      drawGrid();
      void load(false, true);
    } catch {
      // Keep the status visible so the user can retry with the same file.
    } finally {
      if (life === lifetime) setMediaBusy(false, message);
    }
  }
  function updateHiddenCount(count) {
    hiddenCount = count;
    const chip = filters.get('回收站');
    if (!chip) return;
    chip.textContent = '回收';
    chip.title = count ? `回收站 (${count})` : '回收站';
    chip.setAttribute('aria-label', chip.title);
    if (count > 0) chip.dataset.hasItems = 'true';
    else delete chip.dataset.hasItems;
  }
  async function editLibrary(action, body, { progress, success, failure }) {
    if (mediaBusy) return;
    const lifetime = life;
    setMediaBusy(true, progress);
    let message = failure;
    try {
      while (life === lifetime && (writing || Object.keys(pending).length)) await flush();
      if (life !== lifetime) return;
      const response = await fetch(payload.baseUrl + '/api/wallpapers/' + action, {
        method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: lifetime.signal,
      });
      if (!response.ok) throw Error();
      const saved = await response.json();
      if (life !== lifetime) return;
      payload = { ...payload, settings: saved.settings };
      updateHiddenCount(saved.hiddenCount);
      const hidden = new Set(saved.settings.hiddenIds);
      const removed = new Set(saved.settings.permanentlyRemovedIds);
      items = items.filter(item => !hidden.has(item.id) && !removed.has(item.id));
      trashItems = trashItems.filter(item => hidden.has(item.id) && !removed.has(item.id));
      purgeTarget = null;
      preview();
      drawGrid();
      message = await load(false, true) ? success : '壁纸库读取失败，请刷新';
    } catch {
      if (life === lifetime && action === 'purge') await load(false, true);
    } finally {
      if (life === lifetime) setMediaBusy(false, message);
    }
  }
  function hideWallpaper(item) {
    return editLibrary('hide', { id: item.id }, {
      progress: '正在移入回收站…', success: '已移入回收站，可在「回收站」复原或彻底删除', failure: '移入回收站失败，请重试',
    });
  }
  function restoreWallpapers(body) {
    return editLibrary('unhide', body, { progress: '正在复原壁纸…', success: '已复原壁纸', failure: '复原失败，请重试' });
  }
  function purgeWallpapers(target) {
    return editLibrary('purge', target === true ? { all: true } : { id: target }, {
      progress: '正在彻底删除…', success: target === true ? '回收站已清空' : '已彻底删除壁纸', failure: '彻底删除失败，请重试',
    });
  }
  async function load(refresh, keepNotice = false) {
    const request = ++scan;
    const inTrash = filter === '回收站';
    const query = new URLSearchParams();
    if (inTrash) query.set('trash', '1');
    if (refresh) query.set('refresh', '1');
    const path = '/api/wallpapers' + (query.size ? '?' + query : '');
    loadFailed = false;
    if (!keepNotice && !mediaBusy) notice = '';
    try {
      const response = await fetch(payload.baseUrl + path, {signal:life.signal});
      if (!response.ok) throw Error();
      const result = await response.json();
      if (request !== scan) return;
      if (inTrash) trashItems = result.items;
      else items = result.items;
      updateHiddenCount(result.hiddenCount ?? hiddenCount);
      loaded = true;
      drawGrid();
      return true;
    } catch {
      if (request !== scan) return;
      loaded = false;
      loadFailed = true;
      if (!notice) notice = '壁纸库读取失败，请刷新';
      drawGrid();
    }
  }
  function sync() {
    if (!host) return;
    const cfg = settings();
    for (const [path, { input, readout, unit }] of fields) {
      const [group, key] = path.split('.');
      const value = key ? cfg[group][key] : cfg[group];
      if (input.type === 'checkbox') input.checked = value;
      else input.value = value;
      if (readout) readout.textContent = unit ? value + ' px' : Math.round(value * 100) + '%';
    }
    for (const [id, el] of presetButtons) {
      const preset = presetSettings(id);
      const exact = cfg.bg.dim === preset.bg.dim
        && Object.entries(preset.glass).every(([key, value]) => cfg.glass[key] === value);
      el.setAttribute('aria-pressed', exact);
    }
    for (const [id, el] of toneButtons) el.setAttribute('aria-pressed', cfg.glass.toneMode === id);
    if (renderedFavorites !== JSON.stringify(cfg.favorites ?? [])) drawGrid();
    if (filter !== '回收站') {
      for (const el of grid.children) if (el.dataset.id) el.children[0].setAttribute('aria-pressed', el.dataset.id === cfg.activeId);
    }
    refreshStatus();
  }
  function field(parent, path, label, type, options = {}) {
    const row = node('label', parent, label, type === 'range' ? 'range' : 'row');
    const readout = type === 'range' && node('span', row);
    const input = node(type === 'select' ? 'select' : 'input', row);
    if (type === 'select') {
      for (const [value, name] of options.choices) node('option', input, name).value = value;
    } else input.type = type;
    if (type === 'range') Object.assign(input, { min:options.min,max:options.max,step:options.unit ? 1 : .01 });
    fields.set(path, { input, readout, unit:options.unit });
    const edit = () => {
      const [group,key] = path.split('.');
      const value = type === 'checkbox' ? input.checked : type === 'range' || options.numeric ? Number(input.value) : input.value;
      const patch = key ? { [group]:{ [key]:value } } : { [group]:value };
      change(patch, type === 'range');
    };
    if (type === 'range') { input.oninput = edit; input.onchange = flush; }
    else input.onchange = edit;
  }
  function tab(isLibrary) {
    library.hidden = !isLibrary;
    controls.hidden = isLibrary;
    tabLibrary.setAttribute('aria-pressed', isLibrary);
    tabControls.setAttribute('aria-pressed', !isLibrary);
    if (!isLibrary && purgeTarget !== null) {
      purgeTarget = null;
      drawGrid();
    }
  }
  function open() {
    if (!host || opened) return;
    opened = true;
    panel.inert = false;
    panel.classList.add('open');
    dock.hidden = true;
    (library.hidden ? tabControls : search).focus();
    if (!loaded) void load(false);
    refreshStatus();
    heartbeat = setInterval(refreshStatus, 750);
  }
  function close() {
    if (!opened) return;
    opened = false;
    panel.inert = true;
    panel.classList.remove('open');
    dock.hidden = false;
    dock.focus();
    if (purgeTarget !== null) {
      purgeTarget = null;
      drawGrid();
    }
    clearInterval(heartbeat);
  }
  function setPeek(on) {
    peeking = Boolean(on);
    if (peeking) {
      if (opened) close();
      document.body?.setAttribute('data-agy-we-peek', 'on');
      if (dock) dock.hidden = true;
      if (peekBtn) peekBtn.hidden = false;
    } else {
      document.body?.removeAttribute('data-agy-we-peek');
      if (peekBtn) peekBtn.hidden = true;
      if (dock && !opened) dock.hidden = false;
    }
  }
  function pickRandom() {
    if (mediaBusy || filter === '回收站') return;
    const pool = matchingItems(new Set(settings().favorites));
    const active = settings().activeId;
    const candidates = pool.length > 1 ? pool.filter((item) => item.id !== active) : pool;
    if (!candidates.length) return;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    change({ activeId: chosen.id, enabled: true });
  }
  function keydown(event) {
    if (event.altKey && event.shiftKey && event.code === 'KeyW') {
      event.preventDefault();
      if (!event.repeat) {
        if (peeking) setPeek(false);
        opened ? close() : open();
      }
    } else if (event.altKey && event.shiftKey && event.code === 'KeyH') {
      event.preventDefault();
      if (!event.repeat) setPeek(!peeking);
    } else if (peeking && event.key === 'Escape') {
      event.preventDefault();
      setPeek(false);
    } else if (opened && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (purgeTarget !== null) {
        purgeTarget = null;
        drawGrid();
      } else close();
    }
  }
  function build() {
    if (host || !document.body || !payload) return;
    const candidate = document.createElement('div');
    if (!candidate.attachShadow) return;
    host = candidate;
    host.id = 'agy-we-picker-host';
    Object.assign(host.style, { position:'fixed',inset:'0',pointerEvents:'none',zIndex:'2147483000' });
    root = host.attachShadow({mode:'open'});
    document.body.append(host);
    life = new AbortController();
    node('style', root, styles);
    let startY, startTop, dragged;
    dock = button(root, '', () => { if (!dragged) open(); dragged = false; }, 'dock');
    dock.title = '打开壁纸库（Alt+Shift+W · Alt+Shift+H 赏图）';
    dock.setAttribute('aria-label', dock.title);
    try {
      const savedTop = globalThis.localStorage?.getItem('agy-we-dock-top');
      if (savedTop) dock.style.top = savedTop;
    } catch {}
    dock.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" rx="4"/><circle cx="8" cy="9" r="1.3"/><path d="m4 17 5-5 4 3 3-4 5 5"/></svg>';
    dock.onpointerdown = e => {
      startY = e.clientY; startTop = dock.getBoundingClientRect().top; dragged = false;
      dock.setPointerCapture(e.pointerId);
    };
    dock.onpointermove = e => {
      if (startY == null) return;
      const delta = e.clientY - startY;
      if (Math.abs(delta) > 4) dragged = true;
      if (dragged) {
        dock.style.top = 'clamp(0px,' + (startTop + delta) + 'px,calc(100% - 44px))';
        try { globalThis.localStorage?.setItem('agy-we-dock-top', dock.style.top); } catch {}
      }
    };
    dock.onlostpointercapture = () => { startY = null; };
    peekBtn = button(root, '退出纯净赏图（Esc / Alt+Shift+H）', () => setPeek(false), 'peek-exit');
    peekBtn.hidden = true;
    panel = node('section', root, undefined, 'drawer');
    panel.setAttribute('aria-label', '壁纸控制台');
    panel.inert = true;
    const header = node('header', panel);
    node('h2', header, '壁纸控制台');
    field(header, 'enabled', '启用', 'checkbox');
    button(header, '赏图', () => setPeek(true));
    button(header, '关闭', close);
    const tabs = node('div', panel, '', 'tabs');
    tabLibrary = button(tabs, '壁纸库', () => tab(true));
    tabControls = button(tabs, '液态玻璃与调节', () => tab(false));
    library = node('main', panel);
    const searchRow = node('div', library, '', 'toolbar');
    search = node('input', searchRow);
    search.type = 'search'; search.placeholder = '搜索壁纸标题'; search.setAttribute('aria-label', search.placeholder);
    search.oninput = () => {
      purgeTarget = null;
      drawGrid();
    };
    const fileInput = node('input', searchRow);
    fileInput.type = 'file';
    fileInput.accept = '.jpg,.jpeg,.png,.webp,.gif,.mp4,.webm';
    fileInput.hidden = true;
    fileInput.onchange = () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      void importLocal(file);
    };
    importButton = button(searchRow, '导入', () => fileInput.click());
    randomButton = button(searchRow, '随机', pickRandom);
    button(searchRow, '刷新', () => { if (!mediaBusy) void load(true); });
    const chips = node('div', library, '', 'chips');
    for (const label of ['全部','收藏','场景','视频','网页','内置','回收站']) {
      const chip = button(chips, label === '回收站' ? '回收' : label, () => {
        if (mediaBusy) return;
        const changeView = (filter === '回收站') !== (label === '回收站');
        setFilter(label);
        if (changeView) {
          trashItems = [];
          loaded = false;
          void load(false, true);
        }
        drawGrid();
      });
      filters.set(label, chip);
      chip.setAttribute('aria-pressed', label === filter);
    }
    trashToolbar = node('div', library, undefined, 'trash-toolbar');
    grid = node('div', library, '', 'grid');
    controls = node('main', panel);
    node('h3', controls, '玻璃色调', 'tone-label');
    const toneChoices = node('div', controls, undefined, 'tones');
    toneChoices.setAttribute('role', 'group');
    toneChoices.setAttribute('aria-label', '玻璃色调');
    for (const [toneMode, label] of Object.entries(tones)) {
      toneButtons.set(toneMode, button(toneChoices, label, () => change({ glass: { toneMode } })));
    }
    field(controls, 'glass.enabled', '启用液态玻璃', 'checkbox');
    const choices = node('div', controls, '', 'presets');
    for (const [id,[label]] of Object.entries(presets)) {
      presetButtons.set(id, button(choices, label, () => change(presetSettings(id))));
    }
    node('h3', controls, '背景与材质');
    for (const [path,label,min,max,unit] of sliders) field(controls,path,label,'range',{min,max,unit});
    node('h3', controls, '播放与省电');
    field(controls,'bg.fpsLimit','场景帧率','select',{numeric:true,choices:[15,24,30,60].map(n => [n,n+' FPS'])});
    field(controls,'bg.fit','填充模式','select',{choices:[['cover','铺满'],['contain','完整显示']]});
    field(controls,'bg.muted','静音','checkbox');
    field(controls,'bg.volume','音量','range',{min:0,max:1});
    field(controls,'bg.pauseOnHidden','窗口隐藏时暂停','checkbox');
    field(controls,'slideshow.enabled','自动轮播','checkbox');
    field(controls,'slideshow.intervalSec','轮播间隔','select',{numeric:true,choices:[1,5,15,30].map(n => [n*60,n+' 分钟'])});
    const footer = node('footer', panel);
    status = node('output', footer);
    status.setAttribute('aria-live', 'polite');
    updateHiddenCount(settings().hiddenIds?.length ?? 0);
    button(footer, '恢复默认参数', () => change(defaults));
    tab(true);
    drawGrid();
    stopHoles = watchBrowserHoles(host, (holes, width) => {
      const right = holes.filter(h => h.width > 80 && h.right >= width - 40 && h.left >= 180)
        .sort((a, b) => a.left - b.left)[0];
      if (right) {
        host.style.setProperty?.('--agy-hole-left', right.left + 'px');
        host.classList.add('avoid-right');
      } else {
        host.classList.remove('avoid-right');
        host.style.removeProperty?.('--agy-hole-left');
      }
    });
    window.addEventListener('keydown', keydown, {capture:true, signal:life.signal});
  }
  function update(next) {
    if (!next?.settings) return;
    const libraryChanged = ['hiddenIds', 'permanentlyRemovedIds'].some(key =>
      JSON.stringify(payload?.settings[key]) !== JSON.stringify(next.settings[key]));
    payload = next;
    preview();
    if (document.body) build();
    else document.addEventListener('DOMContentLoaded', build, {once:true});
    if (host && libraryChanged) {
      loaded = false;
      if (opened && !mediaBusy) void load(false, true);
    }
    sync();
  }
  function destroy() {
    ++scan;
    stopHoles?.();
    stopHoles = undefined;
    life?.abort();
    clearTimeout(debounce);
    if (opened) clearInterval(heartbeat);
    if (peeking) setPeek(false);
    document.removeEventListener('DOMContentLoaded', build);
    host?.remove();
    host = root = panel = dock = peekBtn = library = controls = grid = search = status = tabLibrary = tabControls = undefined;
    payload = life = writing = writeTask = importButton = randomButton = trashToolbar = renderedFavorites = undefined;
    opened = peeking = loaded = loadFailed = mediaBusy = false;
    pending = {}; items = []; filter = '全部'; notice = '';
    trashItems = []; hiddenCount = 0; purgeTarget = null;
    filters.clear(); fields.clear(); presetButtons.clear(); toneButtons.clear();
  }
  window.__agyWePicker = { version:PICKER_VERSION, mount:update, update, destroy, open, close, setPeek };
})();
