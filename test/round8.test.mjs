import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const renderer = await readFile(new URL('../src/webwallgl-host/renderer.js', import.meta.url), 'utf8');
const particleShader = `#version 300 es
uniform int u_albedoR8;
vec3 albedoRgb = u_albedoR8 == 1 ? vec3(1.0) : t.rgb;
float albedoA = u_albedoR8 == 1 ? t.r : t.a;`;
const drawMethods = ['drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced'];

function startRenderer(host) {
  const window = new EventTarget();
  const messages = [];
  window.parent = { postMessage: ({ event }) => messages.push(event) };
  let mountedCanvas;
  let destroyed = false;
  window.WebWallGL = {
    createScene(canvas) {
      mountedCanvas = canvas;
      return {
        on() {}, load: async () => {}, setFit() {}, setFps() {}, setVolume() {}, resume() {},
        destroy() { destroyed = true; },
      };
    },
    httpSource: (url) => url,
  };
  runInNewContext(renderer, {
    window,
    document: { getElementById: () => host, referrer: '' },
    location: new URL('http://localhost/webwallgl/index.html?id=workshop:2992857467&parentOrigin=http://localhost'),
    URL, URLSearchParams, setInterval: () => 1, clearInterval() {},
  });
  return {
    canvas: mountedCanvas,
    messages,
    dispose() {
      window.dispatchEvent(new Event('pagehide'));
      assert.ok(destroyed);
    },
  };
}

function mockGl() {
  const calls = [];
  const gl = {
    TEXTURE0: 0x84c0, TEXTURE1: 0x84c1, TEXTURE_2D: 0x0de1, TEXTURE_CUBE_MAP: 0x8513,
    R8: 0x8229, RG8: 0x822b, RGBA: 0x1908, RGBA8: 0x8058,
    getUniformLocation(program, name) { return program[name] ?? null; },
  };
  for (const method of [
    'activeTexture', 'bindTexture', 'texImage2D', 'texStorage2D', 'shaderSource',
    'useProgram', 'uniform1i', ...drawMethods,
  ]) {
    gl[method] = function (...args) {
      assert.equal(this, gl);
      calls.push([method, ...args]);
    };
  }
  return { gl, calls };
}

function fixture() {
  const { gl, calls } = mockGl();
  const canvas = { getContext: () => gl };
  startRenderer(canvas);
  assert.equal(canvas.getContext('webgl2'), gl);
  const program = { u_albedoR8: {}, u_tex: {} };
  const location = gl.getUniformLocation(program, 'u_albedoR8');
  gl.useProgram(program);
  function upload(format, method = 'texImage2D', level = 0, texture = {}) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl[method](gl.TEXTURE_2D, method === 'texStorage2D' ? 1 : level, format, 1, 1);
    return texture;
  }
  return { gl, calls, program, location, upload };
}

test('Round 8 upgrades both particle shader expressions and passes other sources through', () => {
  const { gl, calls } = fixture();
  const shader = {};
  const upgraded = particleShader
    .replace(': t.rgb;', ': (u_albedoR8 == 2 ? vec3(t.r) : t.rgb);')
    .replace(': t.a;', ': (u_albedoR8 == 2 ? t.g : t.a);');
  const ordinary = particleShader.replace('uniform int u_albedoR8;', '// Ordinary effect');
  const alreadyUpgraded = upgraded.replace('uniform int u_albedoR8;', 'uniform  int u_albedoR8 ;');
  const spaced = particleShader.replace('u_albedoR8 == 1 ?', 'u_albedoR8==1?');
  for (const [source, expected] of [
    [particleShader, upgraded], [ordinary, ordinary], [alreadyUpgraded, alreadyUpgraded],
    [spaced, upgraded], [null, null],
  ]) {
    gl.shaderSource(shader, source);
    assert.deepEqual(calls.at(-1), ['shaderSource', shader, expected]);
  }
});

test('Round 8 uses level-zero TEXTURE_2D formats and leaves unrelated uniform writes intact', () => {
  const { gl, calls, program, location, upload } = fixture();
  const other = gl.getUniformLocation(program, 'u_tex');
  const texture = upload(gl.RG8);
  assert.deepEqual(calls.at(-1), ['texImage2D', gl.TEXTURE_2D, 0, gl.RG8, 1, 1]);
  for (const [format, mode] of [[gl.RG8, 2], [gl.R8, 1], [gl.RGBA, 0], [gl.RGBA8, 0]]) {
    upload(format, 'texImage2D', 0, texture);
    gl.uniform1i(location, 0);
    assert.deepEqual(calls.at(-1), ['uniform1i', location, mode]);
  }
  upload(gl.RG8, 'texImage2D', 1, texture);
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, {});
  gl.texImage2D(gl.TEXTURE_CUBE_MAP, 0, gl.RG8, 1, 1);
  gl.uniform1i(location, 0);
  assert.deepEqual(calls.at(-1), ['uniform1i', location, 0]);
  upload(gl.RG8);
  gl.uniform1i(other, 0);
  assert.deepEqual(calls.at(-1), ['uniform1i', other, 0]);
  gl.uniform1i(location, 1);
  assert.deepEqual(calls.at(-1), ['uniform1i', location, 1]);
});

test('Round 8 corrects the current program just before each draw when the bind comes after the uniform', () => {
  const { gl, calls, location, upload } = fixture();
  const rg8 = upload(gl.RG8);
  for (const draw of drawMethods) {
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.uniform1i(location, 0);
    gl.bindTexture(gl.TEXTURE_2D, rg8);
    gl[draw](4, 0, 6);
    assert.deepEqual(calls.slice(-4), [
      ['uniform1i', location, 0], ['bindTexture', gl.TEXTURE_2D, rg8],
      ['uniform1i', location, 2], [draw, 4, 0, 6],
    ]);
  }
  for (const program of [{}, null]) {
    gl.useProgram(program);
    gl.drawArrays(4, 0, 6);
    assert.deepEqual(calls.slice(-2), [['useProgram', program], ['drawArrays', 4, 0, 6]]);
  }
});

test('Round 8 tracks immutable storage on each unit and uses only TEXTURE0 for particle albedo', () => {
  const { gl, calls, location, upload } = fixture();
  for (const [format, mode] of [[gl.RG8, 2], [gl.R8, 1]]) {
    gl.activeTexture(gl.TEXTURE0);
    upload(format, 'texStorage2D');
    gl.activeTexture(gl.TEXTURE1);
    upload(gl.RGBA8, 'texStorage2D');
    gl.uniform1i(location, 0);
    assert.deepEqual(calls.at(-1), ['uniform1i', location, mode]);
    gl.drawArrays(4, 0, 6);
    assert.deepEqual(calls.at(-2), ['uniform1i', location, mode]);
  }
  gl.activeTexture(gl.TEXTURE0);
  upload(gl.RGBA8, 'texStorage2D');
  gl.activeTexture(gl.TEXTURE1);
  upload(gl.RG8, 'texStorage2D');
  gl.uniform1i(location, 0);
  gl.drawArrays(4, 0, 6);
  assert.deepEqual(calls.slice(-2), [['uniform1i', location, 0], ['drawArrays', 4, 0, 6]]);
});

test('Round 8 patches only the actual scene canvas and wraps a WebGL2 context once', () => {
  const { gl, calls } = mockGl();
  const context2d = { drawArrays() {} };
  const getContext = function (type, options) {
    assert.equal(this, canvas);
    calls.push([type, options]);
    if (type === 'webgl2') return gl;
    return type === '2d' ? context2d : null;
  };
  const proto = { getContext };
  const canvas = Object.assign(Object.create(proto), { style: {} });
  const host = {
    ownerDocument: { createElement: (tag) => { assert.equal(tag, 'canvas'); return canvas; } },
    appendChild(child) { this.child = child; },
  };
  const instance = startRenderer(host);
  assert.equal(instance.canvas, canvas);
  assert.equal(host.child, canvas);
  assert.equal(proto.getContext, getContext);
  const draw2d = context2d.drawArrays;
  assert.equal(canvas.getContext('2d'), context2d);
  assert.equal(context2d.drawArrays, draw2d);
  assert.equal(canvas.getContext('webgl'), null);
  const options = Object.freeze({ alpha: false, antialias: true });
  assert.equal(canvas.getContext('webgl2', options), gl);
  assert.deepEqual([calls.at(-1)[0], { ...calls.at(-1)[1] }], ['webgl2', { alpha: false, antialias: false }]);
  const wrapped = gl.uniform1i;
  assert.equal(canvas.getContext('webgl2'), gl);
  assert.deepEqual({ ...calls.at(-1)[1] }, { antialias: false });
  assert.equal(gl.uniform1i, wrapped);
  instance.dispose();
});

test('renderer reports known software backends once using debug info or the standard renderer', () => {
  for (const [unmasked, standard, isSoftware] of [
    ['ANGLE (Microsoft Basic Render Driver)', 'WebKit WebGL', true],
    ['ANGLE (Vulkan, SwiftShader Device)', 'WebKit WebGL', true],
    [undefined, 'llvmpipe (LLVM 20.1.8)', true],
    ['ANGLE (Intel UHD Graphics)', 'WebKit WebGL', false],
  ]) {
    const { gl } = mockGl();
    const unmaskedRenderer = 0x9246;
    gl.RENDERER = 0x1f01;
    const queried = [];
    gl.getExtension = (name) => {
      assert.equal(name, 'WEBGL_debug_renderer_info');
      return unmasked ? { UNMASKED_RENDERER_WEBGL: unmaskedRenderer } : null;
    };
    gl.getParameter = (key) => {
      queried.push(key);
      return key === unmaskedRenderer ? unmasked : standard;
    };
    const canvas = { getContext: () => gl };
    const instance = startRenderer(canvas);
    canvas.getContext('webgl2');
    canvas.getContext('webgl2');
    assert.deepEqual(queried, [unmasked ? unmaskedRenderer : gl.RENDERER]);
    assert.deepEqual(instance.messages, isSoftware ? ['software-renderer'] : []);
    instance.dispose();
  }
});

test('Round 8 permits a scene mock without getContext', async () => {
  const host = {};
  const instance = startRenderer(host);
  assert.equal(instance.canvas, host);
  await new Promise(setImmediate);
  assert.deepEqual(instance.messages, ['ready']);
  instance.dispose();
});
