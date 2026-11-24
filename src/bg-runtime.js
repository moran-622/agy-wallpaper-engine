(() => {
  const RUNTIME_VERSION = '2026.11.r13';
  const previous = window.__agyWeBg;
  if (previous?.version === RUNTIME_VERSION) return;
  try { previous?.destroy?.(); } catch {}
  delete window.__agyWeBg;

  const rootId = 'agy-we-bg-root';
  const styleId = 'agy-we-bg-base-style';
  const sceneTimeoutMs = 8000;
  const fadeMs = 240;
  const baseStyle = `
    #agy-we-bg-root { position: fixed; inset: 0; z-index: 0; overflow: hidden; }
    #agy-we-bg-root, #agy-we-bg-root * { pointer-events: none !important; }
    #agy-we-bg-root ~ #root { position: relative !important; z-index: 1 !important; }
    @media (prefers-reduced-motion: reduce) {
      #agy-we-bg-root * { transition: none !important; }
    }
  `;
  const fill = { position: 'absolute', inset: '0' };
  const cover = {
    ...fill, width: '100%', height: '100%', border: '0', opacity: '0',
    transition: `opacity ${fadeMs}ms ease`,
  };

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
        'data-has-three-layer-browser-hole', 'hidden'] });
    function onScroll() {
      if (observed.length > 1) schedule();
    }
    window.addEventListener?.('resize', schedule);
    window.addEventListener?.('scroll', onScroll, { capture: true, passive: true });
    sync();
    return () => {
      stopped = true;
      mutation?.disconnect();
      resize?.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      observed = [];
      window.removeEventListener?.('resize', schedule);
      window.removeEventListener?.('scroll', onScroll, { capture: true });
    };
  }

  let stopHoles;
  let scrollPauseTimer;
  let scrollPaused = false;
  let windowFocused = true;
  function onAnyScroll() {
    if (!layer || layer.kind !== 'scene') return;
    if (!scrollPaused) {
      scrollPaused = true;
      sceneMessage(layer, 'pause');
    }
    clearTimeout(scrollPauseTimer);
    scrollPauseTimer = setTimeout(() => {
      scrollPauseTimer = undefined;
      scrollPaused = false;
      syncPlayback();
    }, 160);
  }
  function stopScrollBoost() {
    window.removeEventListener?.('scroll', onAnyScroll, { capture: true });
    clearTimeout(scrollPauseTimer);
    scrollPauseTimer = undefined;
    scrollPaused = false;
    document.body?.removeAttribute('data-agy-we-scrolling');
  }
  let layer;
  let outgoing;
  let fadeTimer;
  let themeCss = '';
  let theme;
  let rotation;
  const variables = [
    ['blur', 'blur', 14, 0, 32, 'px'],
    ['surfaceOpacity', 'surface-alpha', 0, 0, .75, ''],
    ['sidebarOpacity', 'sidebar-alpha', .44, .12, .88, ''],
    ['cardOpacity', 'card-alpha', .68, .25, .94, ''],
    ['borderGlow', 'border-glow', .34, 0, .6, ''],
  ];

  function clearTheme() {
    if (!theme) return;
    document.body.removeAttribute('data-agy-we-glass');
    document.body.removeAttribute('data-agy-we-tone');
    document.body.removeAttribute('data-agy-we-preset');
    document.body.removeAttribute('data-agy-we-peek');
    for (const [, key] of variables) document.body.style.removeProperty?.('--agy-glass-' + key);
    theme.remove();
    theme = undefined;
  }

  function syncTheme(glass) {
    if (!glass?.enabled || !themeCss) return clearTheme();
    if (!theme) {
      theme = document.createElement('style');
      theme.id = 'agy-we-glass-style';
      document.head.append(theme);
    }
    if (theme.textContent !== themeCss) theme.textContent = themeCss;
    for (const [field, key, fallback, min, max, unit] of variables) {
      document.body.style.setProperty?.('--agy-glass-' + key, between(glass[field], fallback, min, max) + unit);
    }
    document.body.setAttribute('data-agy-we-preset', glass.preset);
    document.body.setAttribute('data-agy-we-tone', glass.toneMode ?? 'auto');
    document.body.setAttribute('data-agy-we-glass', 'on');
  }

  function stopRotation() {
    if (!rotation) return;
    clearTimeout(rotation.timer);
    rotation.controller.abort();
    rotation = undefined;
  }

  function syncRotation(base, settings, leader) {
    const { enabled, intervalSec } = settings.slideshow ?? {};
    if (!enabled || leader === false) return stopRotation();
    const ms = between(intervalSec, 300, 60, 86400) * 1000;
    const key = JSON.stringify([base.origin, settings.activeId, ms]);
    if (rotation?.key === key) return;
    stopRotation();
    const cycle = { key, controller: new AbortController() };
    rotation = cycle;
    async function advance() {
      const { signal } = cycle.controller;
      try {
        const response = await fetch(new URL('/api/wallpapers', base), { signal });
        if (!response.ok) return;
        const { items } = await response.json();
        const index = items.findIndex(item => item.id === settings.activeId);
        if (items.length < 2 || cycle !== rotation) return;
        await fetch(new URL('/api/settings', base), {
          method: 'PATCH', signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activeId: items[(index + 1) % items.length].id }),
        });
      } catch { /* Retry on the next interval while this selection is active. */ }
      finally {
        if (cycle === rotation) cycle.timer = setTimeout(advance, ms);
      }
    }
    cycle.timer = setTimeout(advance, ms);
  }
  let pending;
  let state = { enabled: false, activeId: null, mode: 'idle', error: null, stats: null };

  function between(value, fallback, min, max) {
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }

  function bgConfig(bg = {}) {
    return {
      fit: ['cover', 'contain', 'stretch'].includes(bg.fit) ? bg.fit : 'cover',
      fps: between(bg.fpsLimit, 30, 1, 120),
      volume: between(bg.volume, 0, 0, 1),
      muted: bg.muted !== false,
      opacity: between(bg.opacity, 1, 0, 1),
      blur: between(bg.blur, 0, 0, 100),
      dim: between(bg.dim, 0.10, 0, 1),
      pauseOnHidden: bg.pauseOnHidden !== false,
    };
  }

  function mediaUrl(base, path) {
    if (typeof path !== 'string' || !path.startsWith('/')) return null;
    try {
      const url = new URL(path, base);
      return url.origin === base.origin ? url.href : null;
    } catch {
      return null;
    }
  }

  function embeddedVideoUrl(base, wallpaperId, path) {
    if (typeof path !== 'string' || !path) return null;
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return mediaUrl(base, `/media/scene/${encodeURIComponent(wallpaperId)}/${encodedPath}`);
  }

  function hasFrame(current) {
    return current.mediaVisible || current.previewVisible;
  }

  function setVisibility(current) {
    const visible = hasFrame(current) || outgoing;
    current.root.toggleAttribute('data-visible', Boolean(visible) && current.config.opacity > 0);
  }

  function show(current, node, mode) {
    node.style.opacity = '1';
    if (node === current.preview) current.previewVisible = true;
    else current.mediaVisible = true;
    if (mode) state.mode = mode;
    setVisibility(current);
    if (outgoing) {
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(() => {
        fadeTimer = undefined;
        if (hasFrame(current)) releaseOutgoing();
      }, fadeMs);
    }
  }

  function revealReadyMedia(current) {
    clearTimeout(current.previewTimer);
    current.previewTimer = undefined;
    const ready = current.readyMedia;
    current.readyMedia = undefined;
    if (ready) {
      if (current.previewVisible) ready.style.transitionDelay = '80ms';
      show(current, ready);
    }
  }

  function showMedia(current, node, mode) {
    state.mode = mode;
    if (outgoing && current.preview && !current.previewVisible) {
      // Let the thumbnail lead the transition, with a bounded wait for slow previews.
      current.readyMedia = node;
      current.previewTimer ??= setTimeout(() => revealReadyMedia(current), fadeMs);
    } else show(current, node);
  }

  function disarm(current) {
    clearTimeout(current.timer);
    current.timer = undefined;
  }

  function cancelLoading(current) {
    disarm(current);
    clearTimeout(current.previewTimer);
    current.previewTimer = undefined;
    current.readyMedia = undefined;
  }

  function removeMedia(current) {
    cancelLoading(current);
    const media = current.media;
    current.media = undefined;
    const kind = current.kind;
    current.kind = undefined;
    current.mediaVisible = false;
    if (kind === 'video') {
      media.pause();
      media.removeAttribute('src');
      media.load();
    }
    media?.remove();
    if (layer === current) setVisibility(current);
  }

  function discardArtwork(current) {
    removeMedia(current);
    current.content.remove();
  }

  function releaseOutgoing() {
    clearTimeout(fadeTimer);
    fadeTimer = undefined;
    if (outgoing) discardArtwork(outgoing);
    outgoing = undefined;
  }

  function retireArtwork(current) {
    if (!hasFrame(current)) {
      discardArtwork(current);
      return;
    }
    const interruptedFade = fadeTimer !== undefined;
    releaseOutgoing();
    // A visible preview can bridge an interrupted fade without keeping its live media.
    if (interruptedFade && current.previewVisible) removeMedia(current);
    else cancelLoading(current);
    if (current.kind === 'video') current.media.pause();
    if (current.kind === 'scene') sceneMessage(current, 'pause');
    outgoing = current;
  }

  function unmount() {
    stopHoles?.();
    stopHoles = undefined;
    stopScrollBoost();
    clearTheme();
    stopRotation();
    const previous = layer;
    layer = undefined;
    if (!previous) return;
    window.removeEventListener('message', onRendererMessage);
    window.removeEventListener('blur', syncFocus);
    window.removeEventListener('focus', syncFocus);
    document.removeEventListener('visibilitychange', syncPlayback);
    releaseOutgoing();
    discardArtwork(previous);
    previous.root.remove();
    previous.style.remove();
  }

  function destroy() {
    pending = undefined;
    document.removeEventListener('DOMContentLoaded', applyPending);
    unmount();
    state = { enabled: false, activeId: null, mode: 'idle', error: null, stats: null };
  }

  function addMedia(current, tag, kind) {
    const node = document.createElement(tag);
    Object.assign(node.style, cover);
    node.tabIndex = -1;
    current.media = node;
    current.kind = kind;
    current.content.append(node);
    return node;
  }

  function fallback(current, reason, tryVideo = false) {
    if (layer !== current) return;
    removeMedia(current);
    state.error = reason;
    state.stats = null;
    if (tryVideo && current.embedded) {
      mountVideo(current, current.embedded, 'embedded-video');
      return;
    }
    current.waitingForEmbedded = tryVideo;
    state.mode = current.preview ? 'preview' : 'unavailable';
  }

  function mountPreview(current, url) {
    if (!url) return;
    const preview = document.createElement('img');
    preview.alt = '';
    Object.assign(preview.style, cover);
    current.preview = preview;
    preview.addEventListener('load', () => {
      if (layer !== current || current.preview !== preview) return;
      show(current, preview);
      revealReadyMedia(current);
    });
    preview.addEventListener('error', () => {
      if (layer !== current || current.preview !== preview) return;
      current.preview = undefined;
      current.previewVisible = false;
      if (state.mode === 'preview') state.mode = 'unavailable';
      preview.remove();
      setVisibility(current);
      revealReadyMedia(current);
    });
    current.content.append(preview);
    preview.src = url;
  }

  function mountImage(current, url) {
    const image = addMedia(current, 'img', 'image');
    image.alt = '';
    image.addEventListener('load', () => {
      if (layer === current && current.media === image) show(current, image, 'image');
    });
    image.addEventListener('error', () => {
      if (layer === current && current.media === image) fallback(current, 'Image failed to load');
    });
    image.src = url;
  }

  function mountVideo(current, url, mode) {
    const video = addMedia(current, 'video', 'video');
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.muted = current.config.muted;
    video.volume = current.config.volume;
    state.mode = mode;
    video.addEventListener('loadeddata', () => {
      if (layer === current && current.media === video) {
        showMedia(current, video, mode);
        syncPlayback();
      }
    });
    video.addEventListener('error', () => {
      if (layer === current && current.media === video) fallback(current, 'Video failed to load');
    });
    video.src = url;
    applyConfig(current);
  }

  function sceneMessage(current, action, config) {
    current.media?.contentWindow?.postMessage({ source: 'agy-we-bg', action, config }, current.base.origin);
  }

  function sceneFps({ fps }) {
    return windowFocused ? fps : Math.min(fps, 5);
  }

  function syncFocus(event) {
    windowFocused = event.type === 'focus';
    if (layer?.kind === 'scene') sceneMessage(layer, 'setConfig', { fps: sceneFps(layer.config) });
  }

  function syncPlayback() {
    if (!layer) return;
    const paused = layer.config.pauseOnHidden && document.visibilityState === 'hidden';
    if (layer.kind === 'video') {
      const video = layer.media;
      video.autoplay = !paused;
      if (paused) video.pause();
      else if (video.paused) void video.play().catch(() => {});
    } else if (layer.kind === 'scene') {
      sceneMessage(layer, paused || scrollPaused ? 'pause' : 'resume');
      if (state.mode === 'scene-loading') {
        if (paused) disarm(layer);
        else if (layer.timer === undefined) {
          const current = layer;
          current.timer = setTimeout(() => fallback(current, 'Scene did not produce a frame in 8 seconds', true), sceneTimeoutMs);
        }
      }
    }
  }

  function applyConfig(current) {
    const { config, media, preview } = current;
    current.root.style.opacity = String(config.opacity);
    current.content.style.filter = config.blur ? `blur(${config.blur}px)` : '';
    current.content.style.inset = config.blur ? `-${config.blur}px` : '0';
    current.dim.style.backgroundColor = `rgba(0, 0, 0, ${config.dim})`;
    const fit = config.fit === 'stretch' ? 'fill' : config.fit;
    if (preview) preview.style.objectFit = fit;
    if (media) media.style.objectFit = fit;
    if (current.kind === 'scene') {
      const { fit, volume, muted } = config;
      sceneMessage(current, 'setConfig', { fps: sceneFps(config), fit, volume, muted });
    } else if (current.kind === 'video') {
      media.muted = config.muted;
      media.volume = config.volume;
    }
    setVisibility(current);
    syncPlayback();
  }

  function onRendererMessage(event) {
    const current = layer;
    if (current?.kind !== 'scene' || event.origin !== current.base.origin
      || event.source !== current.media.contentWindow || event.data?.source !== 'agy-we-renderer') return;
    if (event.data.event === 'ready') {
      disarm(current);
      showMedia(current, current.media, 'scene');
      applyConfig(current);
    } else if (event.data.event === 'software-renderer') {
      fallback(current, '软件渲染省电模式', !current.preview);
    } else if (event.data.event === 'error') {
      const reason = typeof event.data.message === 'string' ? event.data.message : 'Scene renderer failed';
      fallback(current, reason, true);
    } else if (event.data.event === 'stats') {
      state.stats = { fps: event.data.fps, running: event.data.running === true };
    }
  }

  function mountFrame(current, kind, url) {
    const frame = addMedia(current, 'iframe', kind);
    frame.title = 'Desktop wallpaper';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.setAttribute('allow', 'autoplay');
    frame.addEventListener('error', () => {
      if (layer === current && current.media === frame) fallback(current, 'Wallpaper frame failed to load', kind === 'scene');
    });
    if (kind === 'web') {
      frame.addEventListener('load', () => {
        if (layer === current && current.media === frame) show(current, frame, 'web');
      });
    }
    frame.src = url;
  }

  function mount(base, settings, wallpaper, key, config, embedded) {
    const content = document.createElement('div');
    Object.assign(content.style, fill);
    const previous = layer;
    let root, dim, style;
    if (previous) {
      ({ root, dim, style } = previous);
      retireArtwork(previous);
      root.prepend(content);
      if (outgoing) outgoing.content.style.zIndex = '-1';
    } else {
      root = document.createElement('div');
      dim = document.createElement('div');
      style = document.createElement('style');
      root.id = rootId;
      root.setAttribute('aria-hidden', 'true');
      Object.assign(dim.style, fill, { zIndex: '1' });
      root.append(content, dim);
      style.id = styleId;
      style.textContent = baseStyle;
      document.body.prepend(root);
      stopHoles = watchBrowserHoles(root, (holes, width, height) => {
        // Union rectangles into disjoint vertical slabs: overlapping holes must
        // remain transparent rather than cancel each other under evenodd.
        const xs = [...new Set(holes.flatMap(h => [h.left, h.right]))].sort((a, b) => a - b);
        let path = `M0 0 H${width} V${height} H0 Z`;
        for (let i = 1; i < xs.length; i++) {
          const left = xs[i - 1], right = xs[i];
          const intervals = holes.filter(h => h.left < right && h.right > left)
            .map(h => [h.top, h.bottom]).sort((a, b) => a[0] - b[0]);
          const merged = [];
          for (const [top, bottom] of intervals) {
            const last = merged[merged.length - 1];
            if (last && top <= last[1]) last[1] = Math.max(last[1], bottom);
            else merged.push([top, bottom]);
          }
          for (const [top, bottom] of merged) path += ` M${left} ${top} H${right} V${bottom} H${left} Z`;
        }
        const clip = holes.length ? `path(evenodd, "${path}")` : '';
        if (root.style.clipPath !== clip) root.style.clipPath = clip;
      });
      document.head.append(style);
      windowFocused = document.hasFocus?.() ?? true;
      document.addEventListener('visibilitychange', syncPlayback);
      window.addEventListener('message', onRendererMessage);
      window.addEventListener('blur', syncFocus);
      window.addEventListener('focus', syncFocus);
      window.addEventListener?.('scroll', onAnyScroll, { capture: true, passive: true });
    }
    const current = { root, content, dim, style, base, key, config, embedded };
    layer = current;

    const url = mediaUrl(base, wallpaper.mediaUrl);
    const preview = mediaUrl(base, wallpaper.previewUrl);
    if (wallpaper.type !== 'image' || url !== preview) mountPreview(current, preview);
    if (wallpaper.type === 'scene') {
      state.mode = 'scene-loading';
      const source = new URL('/webwallgl/index.html', base);
      source.search = new URLSearchParams({
        id: settings.activeId, parentOrigin: location.origin,
        fps: sceneFps(config), fit: config.fit, volume: config.volume, muted: config.muted,
      }).toString();
      mountFrame(current, 'scene', source.href);
    } else if (wallpaper.type === 'video' && url) {
      mountVideo(current, url, 'video');
    } else if (wallpaper.type === 'web' && url) {
      state.mode = 'web-loading';
      mountFrame(current, 'web', url);
    } else if (wallpaper.type === 'image' && url) {
      state.mode = 'image-loading';
      mountImage(current, url);
    } else {
      fallback(current, 'Wallpaper has no media URL');
    }
    applyConfig(current);
  }

  function applyPending() {
    if (!pending || !document.body) return;
    const { baseUrl, settings, wallpaper, manifest, slideshowLeader } = pending;
    pending = undefined;
    let base;
    try {
      base = new URL(baseUrl);
    } catch {
      // An unavailable media server leaves the app's original surfaces in place.
    }
    if (!base || !settings.enabled || !settings.activeId || wallpaper?.id !== settings.activeId) {
      unmount();
      state = { enabled: Boolean(settings.enabled), activeId: settings.activeId ?? null, mode: 'idle', error: null, stats: null };
      return;
    }
    const config = bgConfig(settings.bg);
    const key = JSON.stringify([base.origin, wallpaper.id, wallpaper.type, wallpaper.mediaUrl, wallpaper.previewUrl]);
    const embedded = embeddedVideoUrl(base, wallpaper.id, manifest?.embeddedVideo);
    if (layer?.key === key) {
      layer.config = config;
      if (manifest) layer.embedded = embedded;
      syncTheme(settings.glass);
      syncRotation(base, settings, slideshowLeader);
      if (layer.waitingForEmbedded && layer.embedded) {
        layer.waitingForEmbedded = false;
        mountVideo(layer, layer.embedded, 'embedded-video');
      } else {
        applyConfig(layer);
      }
      return;
    }
    state = { enabled: true, activeId: settings.activeId, mode: 'loading', error: null, stats: null };
    mount(base, settings, wallpaper, key, config, embedded);
    syncTheme(settings.glass);
    syncRotation(base, settings, slideshowLeader);
  }

  // Payload: { baseUrl, settings, wallpaper: WallpaperItem|null, manifest?: SceneManifest }.
  function update(payload) {
    if (!payload?.settings?.enabled) {
      destroy();
      return;
    }
    pending = payload;
    if (document.body) applyPending();
    else document.addEventListener('DOMContentLoaded', applyPending, { once: true });
  }

  window.__agyWeBg = {
    version: RUNTIME_VERSION,
    setTheme(css) { themeCss = css; },
    update,
    destroy,
    getState: () => ({ ...state, stats: state.stats && { ...state.stats } }),
  };
})();
