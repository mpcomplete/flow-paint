import * as Regl from "regl"
import * as Webgl2 from "./regl-webgl2-compat.js"
import { imageGenerator } from "./image-shader"
import * as dragdrop from "./dragdrop"
import * as dat from "dat.gui"
import * as guiPresets from "./gui-presets.json"

let webgl: WebGL2RenderingContext;
const regl = Webgl2.overrideContextType(
  () => Regl({canvas: "#regl-canvas", extensions: ['WEBGL_draw_buffers', 'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float', 'ANGLE_instanced_arrays']}),
  (gl) => webgl = gl);

type Point = [number, number];

var config:any = {
  numParticles: 9000,
  clear: () => clearScreen(),
};
window.onload = function() {
  let gui = new dat.GUI({load: guiPresets});
  gui.remember(config);
  const readableName = (n) => n.replace(/([A-Z])/g, ' $1').toLowerCase()
  function addConfig(name, initial, min?, max?) {
    config[name] = initial;
    return gui.add(config, name, min, max).name(readableName(name));
  }
  addConfig('image', 'starry').options(['starry', 'face', 'forest', 'landscape', 'tree', 'try drag and drop']).onFinishChange((v) => loadImage(v));
  addConfig('lineWidth', 0.5, 0.2, 20.0).step(.01);
  addConfig('lineLength', 0.1, 0.02, 1.0).step(.01);
  addConfig('lineSpeed', 1., 0.1, 2.0).step(.1);
  addConfig('variance', 1., 0.1, 3.).step(.1);
  addConfig('jaggies', 3., 0., 5.).step(1);
  addConfig('flowType', 'voronoi').options(['voronoi', 'fractal', 'simplex', 'sinusoid']);
  addConfig('varyFlowField', true);
  addConfig('showFlowField', true);
  gui.add(config, 'clear');
  initFramebuffers();
  dragdrop.init();
  dragdrop.handlers.ondrop = function(url) {
    initGenerator({type: 'image', imageUrl: url});
  };
};

let particles: any = {
  positions: Float32Array,
  colors: Float32Array,
  fbo: null,
  hue: [],
  birth: [],
};
let reglCanvas;
let screenCanvas;
let sourceImageGenerator;
let animateTime = 0;
function initFramebuffers() {
  reglCanvas = document.getElementById('regl-canvas') as HTMLCanvasElement;
  screenCanvas = document.getElementById('screen') as HTMLCanvasElement;
  reglCanvas.width = screenCanvas.width = window.innerWidth;
  reglCanvas.height = screenCanvas.height = window.innerHeight;

  loadImage(config.image);

  // Holds the particle positions. particles[i, 0].xyzw = {lastPosX, lastPosY, posX, posY}
  particles.positions = new Float32Array(config.numParticles * 4);
  particles.colors = new Float32Array(config.numParticles * 4);
  particles.fbo = createDoubleFBO(2, {
    type: 'float32',
    format: 'rgba',
    wrap: 'clamp',
    width: config.numParticles,
    height: 1,
  });

  particles.fbo.src.color[0].subimage({ // position
    width: config.numParticles,
    height: 1,
    data: Array.from({length: config.numParticles}, (_, i) => [-1,0,-1,0]),
  });
}

const loadImage = (name) => initGenerator({type: 'image', imageUrl: `images/${name}.jpg`});
function initGenerator(opts) {
  sourceImageGenerator = imageGenerator(regl, [reglCanvas.width, reglCanvas.height], opts);
  clearScreen();
}

function clearScreen() {
  let ctxDst = screenCanvas.getContext('2d') as CanvasRenderingContext2D;
  ctxDst.clearRect(0, 0, screenCanvas.width, screenCanvas.height);
}

function createFBO(count, props) {
  return regl.framebuffer({
    color: Array.from({length: count}, () => regl.texture(props)),
    depthStencil: false,
    depth: false,
    stencil: false,
  });
}

function createDoubleFBO(count, props) {
  return {
    src: createFBO(count, props),
    dst: createFBO(count, props),
    swap: function () {
      [this.src, this.dst] = [this.dst, this.src];
    }
  }
}

const commonFrag = `#version 300 es
precision highp float;
precision highp sampler2D;

struct Options {
  bool useVoronoi;
  bool useFBM;
  bool useSimplex;
  float jaggies;
  float variance;
};

float PI = 3.14159269369;
float TAU = 6.28318530718;

vec2 rotate(vec2 p, float angle) {
  return mat2(cos(angle), -sin(angle),
              sin(angle), cos(angle)) * p;
}

// http://www.jcgt.org/published/0009/03/02/
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;

  v.x += v.y*v.z;
  v.y += v.z*v.x;
  v.z += v.x*v.y;

  v ^= v >> 16u;

  v.x += v.y*v.z;
  v.y += v.z*v.x;
  v.z += v.x*v.y;

  return v;
}
// https://www.shadertoy.com/view/XlGcRh#
vec3 hash3(vec3 uvt) {
  uvec3 hu = pcg3d(uvec3(uvt * 1717.));  // scale by approximate resolution
  return vec3(hu) * (1.0/float(0xffffffffu));
}

// Basic 3D noise
// https://gist.github.com/patriciogonzalezvivo/670c22f3966e662d2f83
vec3 noise3(vec3 x) {
	vec3 i = floor(x);
	vec3 f = fract(x);
	vec3 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(mix( hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), u.x),
                 mix( hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), u.x), u.y),
             mix(mix( hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), u.x),
                 mix( hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), u.x), u.y), u.z);
}

// Simplex Noise
// https://gist.github.com/patriciogonzalezvivo/670c22f3966e662d2f83
const float F3 = 0.3333333;
const float G3 = 0.1666667;
float snoise(vec3 p) {
	vec3 s = floor(p + dot(p, vec3(F3)));
	vec3 x = p - s + dot(s, vec3(G3));

	vec3 e = step(vec3(0.0), x - x.yzx);
	vec3 i1 = e*(1.0 - e.zxy);
	vec3 i2 = 1.0 - e.zxy*(1.0 - e);

	vec3 x1 = x - i1 + G3;
	vec3 x2 = x - i2 + 2.0*G3;
	vec3 x3 = x - 1.0 + 3.0*G3;

	vec4 w, d;

	w.x = dot(x, x);
	w.y = dot(x1, x1);
	w.z = dot(x2, x2);
	w.w = dot(x3, x3);

	w = max(0.6 - w, 0.0);

	d.x = dot(hash3(s), x);
	d.y = dot(hash3(s + i1), x1);
	d.z = dot(hash3(s + i2), x2);
	d.w = dot(hash3(s + 1.0), x3);

	w *= w;
	w *= w;
	d *= w;

	return .5 + .5*dot(d, vec4(52.0));
}
vec2 snoise2(vec3 p) {
  return vec2(snoise(p+vec3(17.1)), snoise(p+vec3(3.7)));
}

// Fractional Brownian Motion
// Íñigo Quílez
const mat2 m = mat2(0.80,  0.60, -0.60,  0.80);
float fbm(vec3 p) {
  float f = 0.0;
  f += 0.500000*snoise(p); p.xy = m*p.xy*2.02;
  f += 0.250000*snoise(p); p.xy = m*p.xy*2.03;
  f += 0.125000*snoise(p); p.xy = m*p.xy*2.01;
  f += 0.062500*snoise(p); p.xy = m*p.xy*2.04;
  f += 0.031250*snoise(p); p.xy = m*p.xy*2.01;
  f += 0.015625*snoise(p);
  return f/0.96875;
}
vec2 fbm2(vec3 p) {
  return vec2(fbm(p+vec3(16.8)), fbm(p+vec3(11.5)));
}

// Voronoi noise
vec2 voronoi(vec2 p, float t, Options options) {
  vec2 i = floor(p);
  vec2 f = fract(p);

  float minDist = 1.;
  vec2 v = vec2(1., 0.);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 cell = vec2(float(x), float(y));
      vec2 cellCenter = snoise2(vec3(i + cell, t));
      vec2 diff = cell + cellCenter - f;
      float dist = dot(diff, diff);
      if (dist < minDist) {
        dist = minDist;
        v = diff;
      }
    }
  }
  return rotate(normalize(v), PI/2.);
}

vec2 velocityAtPoint(vec2 p, float t, Options options) {
  t = snoise(vec3(t*.03, 0, 0));
  p *= options.variance;
  vec2 v = vec2(1., 0.);
  if (options.useVoronoi) {
    v = voronoi(p*7., t, options);
  } else if (options.useFBM) {
    v = fbm2(vec3(p*2., t)) - .5;
  } else if (options.useSimplex) {
    v = snoise2(vec3(p*5., t)) - .5;
  } else {
    float th = (t - .5)*.4;
    vec2 pr = p * TAU/4.;
    v.x = sin(TAU * sin(pr.x*1.7) * sin(pr.y*3.1) + (pr.x-.1 + th)*(pr.y+.2)*TAU);
    pr.y += sin(pr.x);
    v.y = sin(1.3 + TAU * sin(pr.x*4.5) * sin(pr.y*1.3) + (pr.x+.1)*(pr.y-.4 + th)*TAU*.7);
  }
  float a = 0.;
  if (options.jaggies > 0.)
    a = snoise(vec3(p*options.jaggies*11., t*3.)) - .5;
  return rotate(normalize(v), a * TAU/4.);
}`;

const baseVertShader = (opts) => regl(Object.assign({
  vert: `#version 300 es
  precision highp float;
  in vec2 position;
  out vec2 uv;

  void main () {
    uv = position * 0.5 + 0.5;
    // HTML5 canvas has y=0 at the top, GL at the bottom.
    gl_Position = vec4(position.x, -position.y, 0.0, 1.0);
  }`,

  attributes: {
    position: [[-1, -1], [-1, 1], [1, 1], [-1, -1], [1, 1], [1, -1]]
  },
  count: 6,
  framebuffer: regl.prop('framebuffer'),
}, opts));

const updateParticles = baseVertShader({
  frag: commonFrag + `
  in vec2 uv;
  layout(location = 0) out vec4 fragData0; // lastPos, pos
  layout(location = 1) out vec4 fragData1; // colors.xyz, birth
  // out vec4 fragColor;
  uniform sampler2D particlePositions;
  uniform sampler2D particleColors;
  uniform sampler2D sourceImage;
  uniform float maxAge;
  uniform float maxSpeed;
  uniform float clockTime;
  uniform float iTime;
  uniform vec2 iResolution;
  uniform Options options;

  vec2 randomPoint(vec2 uv, float t) {
    return hash3(vec3(uv, t)).xy;
  }
  void maybeReset(inout vec2 pos, inout vec2 newPos, inout vec3 color, inout float birth) {
    float death = maxAge*(1. + .5*hash3(vec3(gl_FragCoord.xy, clockTime)).x);
    if ((clockTime - birth) > death || newPos.x < 0. || newPos.x > 1. || newPos.y < 0. || newPos.y > 1.) {
      pos = newPos = randomPoint(gl_FragCoord.xy, clockTime);
      color = texture(sourceImage, pos).rgb*255.;
      birth = clockTime;
    }
  }
  void main() {
    vec2 pos = texelFetch(particlePositions, ivec2(gl_FragCoord.xy), 0).zw;
    vec2 velocity = velocityAtPoint(pos, iTime, options);

    vec2 newPos = pos + velocity * .003 * maxSpeed;
    vec4 colors = texelFetch(particleColors, ivec2(gl_FragCoord.xy), 0);
    maybeReset(pos, newPos, colors.rgb, colors.a);
    fragData0 = vec4(pos, newPos);
    fragData1 = colors;
  }`,
  framebuffer: () => particles.fbo.dst,
  uniforms: {
    particlePositions: () => particles.fbo.src.color[0],
    particleColors: () => particles.fbo.src.color[1],
    sourceImage: () => sourceImageGenerator.getTex(),
    maxAge: () => Math.max(.02, config.lineLength / config.lineSpeed),
    maxSpeed: () => config.lineSpeed,
    clockTime: regl.context('time'),
    iTime: () => animateTime,
    iResolution: (context) => [context.viewportWidth, context.viewportHeight],
    'options.useVoronoi': () => config.flowType == 'voronoi',
    'options.useFBM': () => config.flowType == 'fractal',
    'options.useSimplex': () => config.flowType == 'simplex',
    'options.jaggies': () => config.jaggies,
    'options.variance': () => config.variance,
  },
});

const drawFlowField = baseVertShader({
  frag: commonFrag + `
  in vec2 uv;
  uniform float iTime;
  out vec4 fragColor;
  uniform Options options;

  // Íñigo Quílez
  float udSegment( in vec2 p, in vec2 a, in vec2 b ) {
    vec2 ba = b-a;
    vec2 pa = p-a;
    float h = clamp( dot(pa,ba)/(1.1*dot(ba,ba)), 0.0, 1.0 );
    return length(pa-h*ba) - .05;
  }
  void main() {
    vec2 center = vec2(0.);
    vec2 velocity = velocityAtPoint(uv, iTime, options);
    float c = udSegment(fract(uv*64.) - .5, center, velocity);
    fragColor.rgb = vec3(1. - sign(c));
  }`,
  uniforms: {
    iTime: () => animateTime,
    'options.useVoronoi': () => config.flowType == 'voronoi',
    'options.useFBM': () => config.flowType == 'fractal',
    'options.useSimplex': () => config.flowType == 'simplex',
    'options.jaggies': () => config.jaggies,
    'options.variance': () => config.variance,
  },
});

let lastTime = 0;
regl.frame(function(context) {
  let deltaTime = context.time - lastTime;
  lastTime = context.time;

  if (!particles.fbo)
    return;

  if (!sourceImageGenerator.ensureData())
    return;

  if (config.varyFlowField)
    animateTime += deltaTime;

  regl.clear({color: [0, 0, 0, 0]});

  if (config.showFlowField)
    drawFlowField({});

  let t1 = performance.now();

  updateParticles();
  particles.fbo.swap();

  let t2 = performance.now();

  webgl.readBuffer(webgl.COLOR_ATTACHMENT0);
  regl.read({data: particles.positions, framebuffer: particles.fbo.dst});
  webgl.readBuffer(webgl.COLOR_ATTACHMENT1);
  regl.read({data: particles.colors, framebuffer: particles.fbo.dst});

  let t3 = performance.now();

  let ctx = screenCanvas.getContext('2d');
  if (!ctx || context.tick < 4) return;
  for (let i = 0; i < particles.positions.length; i += 4) {
    let [ox, oy] = [particles.positions[i], particles.positions[i+1]];
    let [px, py] = [particles.positions[i+2], particles.positions[i+3]];
    let rgb = particles.colors;
    ctx.strokeStyle = `rgba(${rgb[i]}, ${rgb[i+1]}, ${rgb[i+2]}, 100%)`;
    ctx.beginPath();
    ctx.moveTo(ox * screenCanvas.width, oy * screenCanvas.height);
    ctx.lineTo(px * screenCanvas.width, py * screenCanvas.height);
    ctx.lineWidth = config.lineWidth;
    ctx.stroke();
  }
  let t4 = performance.now();

  // console.log(t2 - t1, t3 - t2, t4 - t3);
});

