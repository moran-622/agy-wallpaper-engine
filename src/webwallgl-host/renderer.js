(() => {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const parentOrigin = parseOrigin(params.get('parentOrigin') || document.referrer);
  let scene;
  let statsTimer;
  let ready = false;
  let paused = false;
  const config = {
    fit: 'cover',
    fps: 30,
    volume: 0,
    muted: true,
  };
  const patchedCanvases = new WeakSet();
  const patchedContexts = new WeakSet();

  function patchParticleAlbedo(gl) {
    if (patchedContexts.has(gl)) return;
    patchedContexts.add(gl);

    let activeUnit = 0;
    let currentProgram = null;
    const boundTextures = new Map();
    const textureModes = new WeakMap();
    const albedoLocations = new WeakMap();
    const programAlbedoLocations = new WeakMap();
    const patchedAlbedoPrograms = new WeakSet();

    function recordTextureFormat(target, internalFormat) {
      if (target !== gl.TEXTURE_2D) return;
      const texture = boundTextures.get(activeUnit);
      if (texture) {
        const mode = internalFormat === gl.R8 ? 1 : internalFormat === gl.RG8 ? 2 : 0;
        textureModes.set(texture, mode);
      }
    }

    const activeTexture = gl.activeTexture.bind(gl);
    gl.activeTexture = (unit) => {
      activeTexture(unit);
      activeUnit = unit - gl.TEXTURE0;
    };
    const bindTexture = gl.bindTexture.bind(gl);
    gl.bindTexture = (target, texture) => {
      bindTexture(target, texture);
      if (target === gl.TEXTURE_2D) boundTextures.set(activeUnit, texture);
    };
    const texImage2D = gl.texImage2D.bind(gl);
    gl.texImage2D = (target, level, internalFormat, ...args) => {
      texImage2D(target, level, internalFormat, ...args);
      if (level === 0) recordTextureFormat(target, internalFormat);
    };
    if (typeof gl.texStorage2D === 'function') {
      const texStorage2D = gl.texStorage2D.bind(gl);
      gl.texStorage2D = (target, levels, internalFormat, ...args) => {
        texStorage2D(target, levels, internalFormat, ...args);
        recordTextureFormat(target, internalFormat);
      };
    }

    const rgb = /\bvec3\s+albedoRgb\s*=\s*u_albedoR8\s*==\s*1\s*\?\s*vec3\(\s*1\.0\s*\)\s*:\s*t\.rgb\s*;/;
    const alpha = /\bfloat\s+albedoA\s*=\s*u_albedoR8\s*==\s*1\s*\?\s*t\.r\s*:\s*t\.a\s*;/;
    const shaderSource = gl.shaderSource.bind(gl);
    gl.shaderSource = (shader, source) => {
      if (typeof source === 'string' && /\buniform\s+int\s+u_albedoR8\s*;/.test(source)
        && rgb.test(source) && alpha.test(source)) {
        source = source
          .replace(rgb, 'vec3 albedoRgb = u_albedoR8 == 1 ? vec3(1.0) : (u_albedoR8 == 2 ? vec3(t.r) : t.rgb);')
          .replace(alpha, 'float albedoA = u_albedoR8 == 1 ? t.r : (u_albedoR8 == 2 ? t.g : t.a);');
      }
      shaderSource(shader, source);
    };

    const useProgram = gl.useProgram.bind(gl);
    gl.useProgram = (program) => {
      useProgram(program);
      currentProgram = program;
    };
    const getUniformLocation = gl.getUniformLocation.bind(gl);
    gl.getUniformLocation = (program, name) => {
      const location = getUniformLocation(program, name);
      if (name === 'u_albedoR8' && location) {
        albedoLocations.set(location, program);
        programAlbedoLocations.set(program, location);
      }
      return location;
    };
    const uniform1i = gl.uniform1i.bind(gl);
    gl.uniform1i = (location, value) => {
      if (currentProgram && albedoLocations.get(location) === currentProgram) {
        const mode = value === 0 ? textureModes.get(boundTextures.get(0)) ?? 0 : 0;
        if (mode) {
          value = mode;
          patchedAlbedoPrograms.add(currentProgram);
        } else {
          patchedAlbedoPrograms.delete(currentProgram);
        }
      }
      uniform1i(location, value);
    };
    for (const method of ['drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced']) {
      if (typeof gl[method] !== 'function') continue;
      const draw = gl[method].bind(gl);
      gl[method] = (...args) => {
        const location = programAlbedoLocations.get(currentProgram);
        if (location) {
          // The particle texture may have been bound after the uniform was set.
          const mode = textureModes.get(boundTextures.get(0)) ?? 0;
          if (mode) {
            uniform1i(location, mode);
            patchedAlbedoPrograms.add(currentProgram);
          } else if (patchedAlbedoPrograms.delete(currentProgram)) {
            uniform1i(location, 0);
          }
        }
        draw(...args);
      };
    }
  }

  function patchCanvas(canvas) {
    if (typeof canvas?.getContext !== 'function' || patchedCanvases.has(canvas)) return;
    patchedCanvases.add(canvas);
    const getContext = canvas.getContext;
    canvas.getContext = function (type, ...args) {
      const gl = getContext.call(this, type, ...args);
      if (gl && (type === 'webgl2' || (typeof gl.R8 === 'number' && typeof gl.RG8 === 'number'))) {
        patchParticleAlbedo(gl);
      }
      return gl;
    };
  }

  function parseOrigin(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
    } catch {
      return null;
    }
  }

  function report(event, details = {}) {
    if (parentOrigin) window.parent.postMessage({ source: 'agy-we-renderer', event, ...details }, parentOrigin);
  }

  function setConfig(patch) {
    if (['cover', 'contain', 'stretch'].includes(patch.fit)) config.fit = patch.fit;
    if (Number.isFinite(patch.fps)) config.fps = Math.max(1, Math.min(120, patch.fps));
    if (Number.isFinite(patch.volume)) config.volume = Math.max(0, Math.min(1, patch.volume));
    if (typeof patch.muted === 'boolean') config.muted = patch.muted;
    if (ready) {
      scene.setFit(config.fit);
      scene.setFps(config.fps);
      scene.setVolume(config.muted ? 0 : config.volume);
    }
  }

  function setPaused(value) {
    paused = value;
    if (ready) {
      if (paused) scene.pause();
      else scene.resume();
    }
  }

  function receive(event) {
    if (event.source !== window.parent || event.origin !== parentOrigin || event.data?.source !== 'agy-we-bg') return;
    const { action, config: next } = event.data;
    if (action === 'pause') setPaused(true);
    if (action === 'resume') setPaused(false);
    if (action === 'setConfig' && next && typeof next === 'object') setConfig(next);
  }

  function dispose() {
    clearInterval(statsTimer);
    window.removeEventListener('message', receive);
    window.removeEventListener('pagehide', dispose);
    ready = false;
    const previous = scene;
    scene = undefined;
    previous?.destroy({ releasePkgCache: true });
  }

  function fail(error) {
    if (!scene) return;
    dispose();
    report('error', { message: String(error?.message ?? error).slice(0, 500) });
  }

  async function start() {
    const engine = window.WebWallGL;
    if (!id || !engine) {
      report('error', { message: id ? 'WebWallGL failed to load' : 'Missing wallpaper ID' });
      return;
    }
    setConfig({
      fit: params.get('fit'),
      fps: Number(params.get('fps') || 30),
      volume: Number(params.get('volume') || 0),
      muted: params.get('muted') !== 'false',
    });
    try {
      const host = document.getElementById('wallpaper');
      let canvas = host;
      if (typeof host?.getContext !== 'function' && host?.ownerDocument) {
        // Supply the canvas so WebWallGL uses the instance whose context we patch.
        canvas = host.ownerDocument.createElement('canvas');
        canvas.style.cssText = 'width:100%;height:100%;';
        host.appendChild(canvas);
      }
      patchCanvas(canvas);
      scene = engine.createScene(canvas, {
        fit: config.fit, fps: config.fps, volume: config.muted ? 0 : config.volume,
      });
      const mounting = scene;
      window.addEventListener('message', receive);
      window.addEventListener('pagehide', dispose);
      mounting.on('error', (error) => {
        if (ready) fail(error);
      });
      await mounting.load(engine.httpSource(`${location.origin}/media/scene-root/${encodeURIComponent(id)}`));
      if (scene !== mounting) return;
      ready = true;
      setConfig(config);
      setPaused(paused);
      report('ready');
      statsTimer = setInterval(() => {
        const { fps, running } = mounting.stats;
        report('stats', { fps, running });
      }, 2000);
    } catch (error) {
      if (scene) fail(error);
      else report('error', { message: String(error?.message ?? error).slice(0, 500) });
    }
  }

  void start();
})();
