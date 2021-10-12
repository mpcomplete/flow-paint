import * as Regl from "regl"
import * as Webgl2 from "./regl-webgl2-compat.js"
import { imageGenerator } from "./image-shader"
import * as dragdrop from "./dragdrop"
import * as dat from "dat.gui"

const regl = Webgl2.overrideContextType(() => Regl({canvas: "#regl-canvas", extensions: ['WEBGL_draw_buffers', 'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float', 'ANGLE_instanced_arrays']}));

type Point = [number, number];

var config:any = {
  numParticles: 9000,
};
window.onload = function() {
  let gui = new dat.GUI();
  gui.remember(config);
  const readableName = (n) => n.replace(/([A-Z])/g, ' $1').toLowerCase()
  function addConfig(name, initial, min?, max?) {
    config[name] = initial;
    return gui.add(config, name, min, max).name(readableName(name));
  }
  addConfig('lineWidth', 0.5, 0.2, 20.0).step(.01);
  addConfig('lineLength', 0.1, 0.02, 1.0).step(.01);
  addConfig('lineSpeed', 1., 0.1, 2.0).step(.1);
  addConfig('wiggles', 3., 0., 5.).step(1);
  addConfig('flowType', 'voronoi').options(['voronoi', 'smooth noise']);
  addConfig('varyFlowField', true);
  addConfig('showFlowField', true);
  initFramebuffers();
  dragdrop.init();
  dragdrop.handlers.ondrop = function(url) {
    initGenerator({type: 'image', imageUrl: url});
  };
};

let particles: any = {
  pixels: Float32Array,
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
  screenCanvas = {
    dst: document.getElementById('screen') as HTMLCanvasElement,
    src: document.createElement('canvas') as HTMLCanvasElement,
  }
  reglCanvas.width = screenCanvas.src.width = screenCanvas.dst.width = window.innerWidth;
  reglCanvas.height = screenCanvas.src.height = screenCanvas.dst.height = window.innerHeight;

  // initGenerator({type: 'vangogh', parameter: 0.0});
  initGenerator({type: 'image', imageUrl: 'images/starry.jpg'});

  // Holds the particle positions. particles[i, 0].xyzw = {lastPosX, lastPosY, posX, posY}
  particles.pixels = new Float32Array(config.numParticles * 4);
  particles.fbo = createDoubleFBO(1, {
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

  particles.hue = Array.from({length: config.numParticles});
  particles.birth = new Float32Array(config.numParticles*4);
  particles.birthBuffer = regl.texture({
    type: 'float32',
    format: 'rgba',
    width: config.numParticles,
    height: 1,
    data: particles.birth,
  });
}

function initGenerator(opts) {
  sourceImageGenerator = imageGenerator(regl, [reglCanvas.width, reglCanvas.height], opts);

  let ctxDst = screenCanvas.dst.getContext('2d') as CanvasRenderingContext2D;
  ctxDst.clearRect(0, 0, screenCanvas.dst.width, screenCanvas.dst.height);
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

function initParticle(i: number, uv: Point, time: number) {
  let rgba = sourceImageGenerator.get(uv);
  particles.hue[i] = [rgba[0]*255, rgba[1]*255, rgba[2]*255, rgba[3]*100];
  particles.birth[i*4] = time;
}

const clock = () => (performance ? performance.now() : Date.now()) / 1000.0;

const commonFrag = `#version 300 es
precision highp float;
precision highp sampler2D;

struct Options {
  bool useVoronoi;
  float wiggles;
};

float PI = 3.14159269369;
float TAU = 6.28318530718;

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
vec2 rotate(vec2 _st, float _angle) {
  return mat2(cos(_angle), -sin(_angle),
              sin(_angle), cos(_angle)) * _st;
}
vec2 randomPoint(vec2 uv, float t) {
  return hash3(vec3(uv, t)).xy;
}
vec3 hsv2rgb(vec3 c) {
  // Íñigo Quílez
  // https://www.shadertoy.com/view/MsS3Wc
  vec3 rgb = clamp(abs(mod(c.x*6.+vec3(0.,4.,2.),6.)-3.)-1.,0.,1.);
  rgb = rgb * rgb * (3. - 2. * rgb);
  return c.z * mix(vec3(1.), rgb, c.y);
}
float noise(vec3 p) {
  return noise3(p).x;
}
// Íñigo Quílez
const mat2 m = mat2( 0.80,  0.60, -0.60,  0.80 );
float fbm(vec3 p) {
  float f = 0.0;
  f += 0.500000*noise( p ); p.xy = m*p.xy*2.02;
  f += 0.250000*noise( p ); p.xy = m*p.xy*2.03;
  f += 0.125000*noise( p ); p.xy = m*p.xy*2.01;
  f += 0.062500*noise( p ); p.xy = m*p.xy*2.04;
  f += 0.031250*noise( p ); p.xy = m*p.xy*2.01;
  f += 0.015625*noise( p );
  return f/0.96875;
}
vec2 fbm2(vec3 p) {
  return vec2(fbm(p+vec3(16.8)), fbm(p+vec3(11.5)));
}

vec2 voronoi(vec2 st, float t, Options options) {
  vec2 i_st = floor(st);
  vec2 f_st = fract(st);

  float minDist = 1.;
  vec2 v = vec2(1., 0.);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 cell = vec2(float(x), float(y));
      vec2 cellCenter = noise3(vec3(i_st + cell, t*.1)).xy;
      vec2 diff = cell + cellCenter - f_st;
      float dist = dot(diff, diff);
      if (dist < minDist) {
        dist = minDist;
        v = diff;
      }
    }
  }
  float a = 0.;
  if (options.wiggles > 0.)
    a = noise3(vec3(st*options.wiggles*5., t)).x*TAU/4.;
  return rotate(normalize(v), PI/2. + a);
}
vec2 velocityAtPoint(vec2 p, float t, Options options) {
  p *= 7.;

  if (options.useVoronoi)
    return voronoi(p, t*.3, options);
  // vec2 v = noise3(vec3(p,0.)).xy - .5;
  // v = noise3(vec3(dFdx(v), 0.)).xy - .5;
  // v = vec2(dFdx(v).x, dFdy(v).y);
  vec2 v = fbm2(vec3(p*1.3, t*.1)) - .5;
  float a = (noise3(vec3(p*options.wiggles*11., t*.02)).x - .5)*TAU/8.;
  return rotate(normalize(v), a*0.);
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
  out vec4 fragColor;
  uniform sampler2D particlesTex;
  uniform sampler2D birthTex;
  uniform float maxAge;
  uniform float maxSpeed;
  uniform float clockTime;
  uniform float iTime;
  uniform vec2 iResolution;
  uniform Options options;

  void maybeReset(inout vec2 pos, inout vec2 newPos) {
    float birth = texelFetch(birthTex, ivec2(gl_FragCoord.xy), 0).x;
    float death = maxAge*(1. + .5*hash3(vec3(gl_FragCoord.xy/iResolution.xy + pos, clockTime)).x);
    if ((clockTime - birth) > death || newPos.x < 0. || newPos.x > 1. || newPos.y < 0. || newPos.y > 1.) {
      newPos = randomPoint(gl_FragCoord.xy, clockTime);
      pos = vec2(-1, -1);  // Tells the main loop that this particle was reset.
    }
  }
  void main() {
    vec2 pos = texelFetch(particlesTex, ivec2(gl_FragCoord.xy), 0).zw;
    vec2 velocity = velocityAtPoint(pos, iTime, options);

    vec2 newPos = pos + velocity * .003 * maxSpeed;
    maybeReset(pos, newPos);
    fragColor = vec4(pos, newPos);
  }`,
  framebuffer: () => particles.fbo.dst,
  uniforms: {
    particlesTex: () => particles.fbo.src,
    birthTex: () => particles.birthBuffer,
    maxAge: () => Math.max(.02, config.lineLength / config.lineSpeed),
    maxSpeed: () => config.lineSpeed,
    clockTime: regl.context('time'),
    iTime: () => animateTime,
    iResolution: (context) => [context.viewportWidth, context.viewportHeight],
    'options.useVoronoi': () => config.flowType == 'voronoi',
    'options.wiggles': () => config.wiggles,
  },
});

const drawFlowField = baseVertShader({
  frag: commonFrag + `
  in vec2 uv;
  uniform float iTime;
  out vec4 fragColor;
  uniform Options options;

  float udSegment( in vec2 p, in vec2 a, in vec2 b ) {
      vec2 ba = b-a;
      vec2 pa = p-a;
      float h =clamp( dot(pa,ba)/(1.1*dot(ba,ba)), 0.0, 1.0 );
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
    'options.wiggles': () => config.wiggles,
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

  updateParticles();
  particles.fbo.swap();

  if (config.showFlowField)
    drawFlowField({});

  regl({framebuffer: particles.fbo.dst})(() => {
    regl.read(particles.pixels);
    let ctx = screenCanvas.src.getContext('2d');
    ctx.clearRect(0, 0, screenCanvas.src.width, screenCanvas.src.height);
    if (!ctx || context.tick < 4) return;
    for (let i = 0; i < particles.pixels.length; i += 4) {
      let [ox, oy] = [particles.pixels[i], particles.pixels[i+1]];
      let [px, py] = [particles.pixels[i+2], particles.pixels[i+3]];
      if (px < 0)
        continue;
      if (ox < 0) {  // negative lastPos signals that this particle died
        initParticle(Math.floor(i / 4), [px, py], context.time);
        continue;
      }
      let rgba = particles.hue[Math.floor(i / 4)];
      ctx.strokeStyle = `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3]}%)`;
      ctx.beginPath();
      ctx.moveTo(ox * screenCanvas.src.width, oy * screenCanvas.src.height);
      ctx.lineTo(px * screenCanvas.src.width, py * screenCanvas.src.height);
      ctx.lineWidth = config.lineWidth;
      ctx.stroke();
    }
    let ctxDst = screenCanvas.dst.getContext('2d') as CanvasRenderingContext2D;
    // ctxDst.fillStyle = 'rgba(0, 0, 0, 1.5%)';
    // ctxDst.fillRect(0, 0, screenCanvas.dst.width, screenCanvas.dst.height);
    ctxDst.drawImage(screenCanvas.src, 0, 0);
  });

  particles.birthBuffer.subimage({
    width: config.numParticles,
    height: 1,
    data: particles.birth
  });
});

