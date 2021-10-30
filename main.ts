import * as Regl from "regl"
import * as dat from "dat.gui"
import * as Webgl2 from "./regl-webgl2-compat.js"
import * as dragdrop from "./dragdrop"
import * as guiPresets from "./gui-presets.json"
import { ColorSource } from "./color-source"
import { Pointer, pointers } from "./pointers"

if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
  location.replace(`https:${location.href.substring(location.protocol.length)}`);
}

const regl = Webgl2.overrideContextType(() => Regl({canvas: "#regl-canvas", extensions: ['WEBGL_draw_buffers', 'OES_texture_float', 'OES_texture_float_linear', 'ANGLE_instanced_arrays']}));

var config:any = {
  numParticles: 12000, // See initFramebuffers
  // This is an optimization: Keep a history of 10 frames (line segments) so we only have to read the particle pixel buffer (which is slow) once per N frames.
  numSegments: 10,
};
const imageAssets = ['starry', 'face', 'forest', 'landscape', 'tree'];
const videoAssets = ['city', 'elephants', 'field', 'sunflower', 'webcam'];
const flowTypes = ['sinusoid', 'voronoi', 'fractal', 'simplex', 'raining', 'edge detect', 'custom'];
window.onload = function() {
  let topgui = new dat.GUI({load: guiPresets});
  let gui = topgui;
  gui.remember(config);
  const readableName = (n) => n.replace(/([A-Z])/g, ' $1').toLowerCase()
  function addConfig(name, initial, min?, max?) {
    config[name] = initial;
    return gui.add(config, name, min, max).name(readableName(name));
  }
  gui = topgui.addFolder('Color source');
  addConfig('image', 'starry').options(imageAssets.concat(['try drag and drop'])).listen().onFinishChange((v) => {if (v) {loadImageAsset(v); config.video = config.algorithm = ''; guiPause.name('pause');}});
  addConfig('video', '').options(videoAssets.concat(['try drag and drop'])).listen().onFinishChange((v) => {if (v) {loadVideoAsset(v); config.image = config.algorithm = ''; guiPause.name('pause');}});
  addConfig('algorithm', '').options(['colorspill', 'firerings']).listen().onFinishChange((v) => {if (v) {loadShader(v); config.image = config.video = ''; guiPause.name('pause');}});
  let guiPause = addConfig('pause', () => {let isPaused = colorSource.pause(); guiPause.name(isPaused ? 'resume' : 'pause');});
  let guiRecord = addConfig('record', () => {let isRecording = record(); guiRecord.name(isRecording ? 'stop' : 'record')});
  gui = topgui.addFolder('Brush options');
  addConfig('lineWidth', 1, 0.2, 10.0).step(.01);
  addConfig('lineLength', 4, 1, 50.0).step(1);
  addConfig('lineSpeed', 2., 1., 10.0).step(.1);
  gui = topgui.addFolder('Flow options');
  addConfig('variance', 1., 0.1, 3.).step(.1);
  addConfig('jaggies', 3., 0., 5.).step(1);
  addConfig('flowType', flowTypes[0]).options(flowTypes).listen().onFinishChange(() => config.paintWithMouse = config.flowType == 'custom');
  addConfig('animateFlowField', true);
  addConfig('paintWithMouse', false).listen().onFinishChange((v) => {if (v) {console.log("paintChange=",v);copyFlowField({}); flowFieldFBO.swap(); config.flowType = 'custom';}});
  addConfig('paintBrushSize', 2.5, 1., 10.);
  gui = topgui.addFolder('Debug');
  addConfig('showFlowField', true);
  addConfig('fps', 30).listen();
  addConfig('clear', clearScreen);

  initFramebuffers();

  Pointer.init(reglCanvas);

  dragdrop.init();
  dragdrop.handlers.ondrop = (url) => initColorSource({type: 'media', mediaUrl: url});

  colorSource = ColorSource.create(regl, fragLib, [reglCanvas.width/4, reglCanvas.height/4]);
  if (config.image) {
    loadImageAsset(config.image);
  } else if (config.video) {
    // Need user interaction before video can play.
    document.querySelector('#status')!.innerHTML = 'Click to play';
    window.onclick = function() {
      loadVideoAsset(config.video);
      window.onclick = null;
    };
  } else if (config.algorithm) {
    loadShader(config.algorithm);
  }
};

let particles: any = {
  fbo: null,
  indexBuffer: Float32Array,
};
let reglCanvas;
let screenFBO;
let flowFieldFBO;
let colorSource;
let animateTime = 0;
let currentTick = 0;
function initFramebuffers() {
  reglCanvas = document.getElementById('regl-canvas') as HTMLCanvasElement;
  reglCanvas.width = window.innerWidth;
  reglCanvas.height = window.innerHeight;

  let sizes = [12000, 8000, 6000, 3000, 1000, 100];
  for (let i = 0; i < sizes.length; i++) {
    try {
      config.numParticles = sizes[i];
      // Create 2 buffers to hold particle data:
      // * particles.fbo0[i, segment].xyzw = {lastPosX, lastPosY, posX, posY}
      // * particles.fbo1[i, segment].xyzw = {r, g, b, birth}
      particles.fbo = createDoubleFBO(2, {
        type: 'float32',
        format: 'rgba',
        wrap: 'clamp',
        width: config.numParticles,
        height: config.numSegments,
      });
      break;
    } catch (e) {
      particles.fbo?.destroy();
    }
  }
  particles.indexBuffer = regl.buffer(Float32Array.from({length: config.numParticles}, (_, i) => i));

  screenFBO = createFBO(1, {
    type: 'float32',
    format: 'rgba',
    wrap: 'clamp',
    min: 'linear',
    mag: 'linear',
    width: reglCanvas.width*2,
    height: reglCanvas.height*2,
  });

  flowFieldFBO = createDoubleFBO(1, {
    type: 'float32',
    format: 'rgba',
    wrap: 'clamp',
    width: 256,
    height: 256,
  });
  flowFieldFBO.src.color[0].subimage({
    width: 256,
    height: 256,
    data: Array.from({length: 256*256}, (_, i) => [1,1,0,0]),
  });
}

const loadImageAsset = (name) => initColorSource({type: 'media', mediaUrl: `assets/${name}.jpg`});
const loadVideoAsset = (name) => initColorSource({type: 'media', mediaUrl: name == 'webcam' && 'webcam' || `assets/${name}.mp4`});
const loadShader = (name) => initColorSource({type: name});
function initColorSource(opts) {
  colorSource.load(opts);
  clearScreen();
}

function clearScreen() {
  let c = .2;
  regl.clear({color: [c,c,c,0], framebuffer: screenFBO});

  currentTick = 0;

  particles.fbo.src.color[0].subimage({ // position
    width: config.numParticles,
    height: config.numSegments,
    data: Array.from({length: config.numParticles*config.numSegments}, (_, i) => [-1,-1,-1,-1]),
  });
  createDebugLines();
}

function createDebugLines() {
  let data = Array.from({length: config.numParticles*config.numSegments}, (_, i) => [-1,-1,-1,-1]);
  const gi = (p, s) => s*config.numParticles + p;
  const set = (p, s, [x0, y0], [x1, y1]) => {
    let i = gi(p, s);
    data[i] = [x0, y0, x1, y1];
  };
  function makeLine(p, pts:Array<[number,number]>) {
    let s = 0;
    set(p, s++, [pts[0][0]-.01, pts[0][1]-.01], pts[0]);
    for (let i = 0; i < pts.length-1; i++) {
      set(p, s++, pts[i], pts[i+1]);
    }
  }
  makeLine(0, [[.1, .1], [.6, .7], [.8, .4]]);
  particles.fbo.src.color[0].subimage({
    width: config.numParticles,
    height: config.numSegments,
    data: data,
  });
}

function createFBO(count, props) {
  return regl.framebuffer({
    color: Array.from({length: count}, () => regl.texture(props)),
    depthStencil: false,
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

const fragLib = `
const float PI = 3.14159269369;
const float TAU = 6.28318530718;

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
vec2 voronoi(vec2 p, float t) {
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
        minDist = dist;
        v = diff;
      }
    }
  }
  return rotate(normalize(v), PI/2.);
}`;

const baseFlowShader = (opts) => regl(Object.assign(opts, {
  frag: `#version 300 es
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  ${fragLib}

  struct FieldOptions {
    int flowType;
    float jaggies;
    float variance;
  };
  uniform vec2 iResolution;
  uniform float iTime;
  uniform FieldOptions fieldOptions;
  uniform sampler2D flowField;
  uniform sampler2D sourceImage;

  vec2 velocityAtPoint(vec2 uv, float t) {
    t = snoise(vec3(t*.03, 0, 0));
    vec2 p = uv*fieldOptions.variance;
    vec2 v = vec2(1., 0.);
    if (fieldOptions.flowType == ${flowTypes.indexOf('voronoi')}) {
      v = voronoi(p*5., t);
    } else if (fieldOptions.flowType == ${flowTypes.indexOf('fractal')}) {
      v = fbm2(vec3(p*2., t)) - .5;
    } else if (fieldOptions.flowType == ${flowTypes.indexOf('simplex')}) {
      v = snoise2(vec3(p*5., t)) - .5;
    } else if (fieldOptions.flowType == ${flowTypes.indexOf('raining')}) {
      v = vec2(.1, 1.);
    } else if (fieldOptions.flowType == ${flowTypes.indexOf('edge detect')}) {
      vec3 source = texture(sourceImage, uv).rgb;
      vec2 avg = source.rg + source.gb + source.rb - 1.5;
      v = normalize(avg);
    } else if (fieldOptions.flowType == ${flowTypes.indexOf('sinusoid')}) {
      float th = (t - .5)*.4;
      vec2 pr = p * TAU/4.;
      v.x = sin(TAU * sin(pr.x*1.7) * sin(pr.y*3.1) + (pr.x-.1 + th)*(pr.y+.2)*TAU);
      pr.y += sin(pr.x);
      v.y = sin(1.3 + TAU * sin(pr.x*4.5) * sin(pr.y*1.3) + (pr.x+.1)*(pr.y-.4 + th)*TAU*.7);
    } else {  // custom
      v = texture(flowField, uv).xy;
    }
    float a = 0.;
    if (fieldOptions.jaggies > 0.)
      a = snoise(vec3(p*(fieldOptions.jaggies-1.)*11., t+1.)) - .5;
    return rotate(normalize(v), a * TAU/4.);
  }` + opts.frag,

  vert: `#version 300 es
  precision highp float;
  in vec2 position;
  out vec2 uv;

  void main () {
    uv = position * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`,

  attributes: {
    position: [[-1, -1], [-1, 1], [1, 1], [-1, -1], [1, 1], [1, -1]]
  },
  uniforms: Object.assign(opts.uniforms||{}, {
    iTime: () => animateTime,
    iResolution: () => [reglCanvas.width, reglCanvas.height],
    sourceImage: () => colorSource.getTexture(),
    flowField: () => flowFieldFBO.src.color[0],
    'fieldOptions.flowType': () => flowTypes.indexOf(config.flowType),
    'fieldOptions.jaggies': () => config.jaggies,
    'fieldOptions.variance': () => config.variance,
  }),
  count: 6,
}));

const updateParticles = baseFlowShader({
  frag: `
  layout(location = 0) out vec4 fragData0; // lastPos, pos
  layout(location = 1) out vec4 fragData1; // colors.xyz, birth
  uniform sampler2D particlePositions;
  uniform sampler2D particleColors;
  uniform int readIdx;
  uniform int writeIdx;
  uniform float clockTime;
  uniform float lineLifetime;
  uniform float lineSpeed;

  vec2 randomPoint(vec2 uv, float t) {
    return hash3(vec3(uv, t)).xy;
  }
  void maybeReset(inout vec2 pos, inout vec2 newPos, inout vec3 color, inout float birth) {
    float death = lineLifetime*(1. + hash3(vec3(gl_FragCoord.yx*.0013, clockTime)).x);
    if ((clockTime - birth) > death || newPos.x < 0. || newPos.x > 1. || newPos.y < 0. || newPos.y > 1.) {
      newPos = randomPoint(vec2(gl_FragCoord.xy*.001), clockTime);
      pos = vec2(-1., -1.);
      color = texture(sourceImage, newPos).rgb;
      birth = clockTime;
    }
  }
  void main() {
    ivec2 ij = ivec2(gl_FragCoord.xy);
    if (ij.y != writeIdx) {
      // We are not writing to this index on this pass: keep data intact.
      fragData0 = texelFetch(particlePositions, ij, 0);
      fragData1 = texelFetch(particleColors, ij, 0);
      return;
    }

    ivec2 ijRead = ivec2(gl_FragCoord.x, readIdx);

    vec2 pos = texelFetch(particlePositions, ijRead, 0).zw;
    vec2 velocity = velocityAtPoint(pos, iTime);
    vec2 newPos = pos + velocity * .001 * lineSpeed;

    vec4 colors = texelFetch(particleColors, ijRead, 0);

    maybeReset(pos, newPos, colors.rgb, colors.a);
    fragData0 = vec4(pos, newPos);
    fragData1 = colors;
  }`,
  framebuffer: () => particles.fbo.dst,
  uniforms: {
    particlePositions: () => particles.fbo.src.color[0],
    particleColors: () => particles.fbo.src.color[1],
    readIdx: regl.prop('readIdx'),
    writeIdx: regl.prop('writeIdx'),
    clockTime: () => currentTick,
    lineLifetime: () => Math.max(1, config.lineLength / config.lineSpeed),
    lineSpeed: () => config.lineSpeed,
  },
});

const copyFlowField = baseFlowShader({
  frag: `
  in vec2 uv;
  out vec4 fragColor;

  void main() {
    vec2 velocity = velocityAtPoint(uv, iTime);
    fragColor.xy = velocity;
  }`,
  framebuffer: () => flowFieldFBO.dst,
});

const paintFlowField = baseFlowShader({
  frag: `
  in vec2 uv;
  out vec4 fragColor;
  uniform vec4 iMouse;
  uniform float brushSize;

  void main() {
    vec2 p = uv - iMouse.xy;
    p.x *= iResolution.x/iResolution.y;
    float d = exp(-dot(p,p) / brushSize);
    vec2 flow = texelFetch(flowField, ivec2(gl_FragCoord.xy), 0).xy;
    if (length(iMouse.zw) > .001) {
      flow = normalize(iMouse.zw)*d + flow*(1.-d);
    }
    fragColor.xy = flow;
  }`,
  framebuffer: () => flowFieldFBO.dst,
  uniforms: {
    iMouse: regl.prop('iMouse'),
    brushSize: () => .005*Math.pow(config.paintBrushSize/3, 1.5),
  }
});

const drawLineWithMiter = regl({
  vert: `#version 300 es
  precision highp float;
  in vec2 vertex;
  in float particleIdx;
  out vec4 vColor;
  out vec2 vEdge;

  uniform sampler2D particlePositions;
  uniform sampler2D particleColors;
  uniform int segmentIdx, prevSegmentIdx;
  uniform float lineWidth;
  uniform vec2 iResolution;

  vec2 getNormal(vec2 p) {
    return vec2(-p.y, p.x);
  }
  void main() {
    ivec2 ijPrev = ivec2(particleIdx, prevSegmentIdx);
    ivec2 ij = ivec2(particleIdx, segmentIdx);
    vec4 posPrev = texelFetch(particlePositions, ijPrev, 0);
    vec4 pos = texelFetch(particlePositions, ij, 0);
    vec4 color = texelFetch(particleColors, ij, 0);

    // Get 3 points to make 2 line segments.
    vec2 p1 = posPrev.xy, p2 = pos.xy, p3 = pos.zw;
    vec2 line1 = p2 - p1;
    vec2 line2 = p3 - p2;
    vec2 normal1 = getNormal(normalize(line1));
    vec2 normal2 = getNormal(normalize(line2));

    vec2 worldPos;
    float width = max(1., lineWidth)*.0005;  // Handle subpixel lines using low alpha, below
    if (vertex.y < 0.) {  // Back point
      if (p1.x < 0. || p2.x < 0.) {
        vColor = vec4(0);
        return;
      }
      worldPos = p1 + vertex.x * normal1 * width;
    } else if (vertex.y < 1.) {  // Mid point
      if (p2.x < 0. || p3.x < 0.) {
        vColor = vec4(0);
        return;
      }
      // vec2 tangent = normalize(normalize(normalize(line1)*iResolution.xy) + normalize(normalize(line2)*iResolution.xy));
      vec2 tangent = normalize(normalize(line1) + normalize(line2));
      vec2 miter = getNormal(tangent);
      float invMiterLength = dot(miter, normal1);
      if (p1.x < 0. || invMiterLength < .5) {
        worldPos = p2 + vertex.x * normal2 * width + vertex.y * line2;
      } else {
        worldPos = p2 + vertex.x * miter * width / invMiterLength;
      }
    } else {  // Front point
      if (p2.x < 0. || p3.x < 0.) {
        vColor = vec4(0);
        return;
      }
      worldPos = p3 + vertex.x * normal2 * width;
    }

    gl_Position = vec4(worldPos*2. - 1., 0, 1);
    vEdge = .5*vertex;
    vColor = vec4(color.rgb, 1.);
  }`,
  frag: `#version 300 es
  precision highp float;
  in vec4 vColor;
  in vec2 vEdge;
  out vec4 fragColor;
  uniform float lineWidth;
  void main() {
    vec2 dedge = fwidth(vEdge);  // Gives 1 / lineWidth projected along each axis (I think)
    dedge.y *= .5;  // Line is half as long in Y direction
    vec2 coverage = clamp((.5 - abs(vEdge)) / dedge, vec2(0.), vec2(1.));
    float alpha = coverage.x*coverage.y;
    alpha *= clamp(lineWidth, .0, 1.);  // Handle subpixel lines using low alpha
    fragColor = vec4(vColor.rgb, vColor.a*alpha);
  }`,

  attributes: {
    vertex: [[-1,-1], [1,-1], [-1,0], [1,0], [-1,1], [1,1]],
    particleIdx: {
      buffer: () => particles.indexBuffer,
      divisor: 1,
      stride: Uint32Array.BYTES_PER_ELEMENT,
    }
  },
  elements: [[0,2,1], [1,2,3], [2,4,3], [3,4,5]],
  primitive: () => "triangles",
  instances: () => config.numParticles,

  uniforms: {
    particlePositions: () => particles.fbo.src.color[0],
    particleColors: () => particles.fbo.src.color[1],
    segmentIdx: regl.prop('segmentIdx'),
    prevSegmentIdx: regl.prop('prevSegmentIdx'),
    lineWidth: () => config.lineWidth,
    iResolution: () => [reglCanvas.width, reglCanvas.height],
  },

  blend: {
    enable: true,
    func: {
      src: 'src alpha',
      dst: 'one minus src alpha',
    },
    equation: {
      rgb: 'add',
      alpha: 'add'
    },
  },

  framebuffer: regl.prop('framebuffer'),
});

const blit = baseFlowShader({
  frag:`
  in vec2 uv;
  out vec4 fragColor;
  uniform sampler2D source;
  uniform vec4 iMouse;
  uniform bool showFlowField;
  uniform float brushSize;

  // Íñigo Quílez
  float udSegment( in vec2 p, in vec2 a, in vec2 b ) {
    vec2 ba = b-a;
    vec2 pa = p-a;
    float h = clamp( dot(pa,ba)/(1.1*dot(ba,ba)), 0.0, 1.0 );
    return length(pa-h*ba) - .05;
  }
  float circle(in vec2 p, float r) {
    float d = length(p);
    return step(r,d) - step(r+.01,d);
  }
  void main() {
    vec2 uvFlip = vec2(uv.x, 1. - uv.y);
    fragColor = texture(source, uvFlip);
    if (showFlowField) {
      vec2 velocity = velocityAtPoint(uvFlip, iTime);
      float c = udSegment(fract(uvFlip*64.) - .5, vec2(0), velocity);
      fragColor.rgb += vec3(1. - sign(c));
    }
    if (iMouse.x >= 0.) {
      vec2 p = uvFlip - iMouse.xy;
      p.x *= iResolution.x/iResolution.y;
      float d = exp(-dot(p,p) / brushSize);
      float c = circle(p, d);
      fragColor.r += c;
    }
  }`,
  uniforms: {
    source: regl.prop('source'),
    iMouse: regl.prop('iMouse'),
    showFlowField: () => config.showFlowField,
    brushSize: () => .005*Math.pow(config.paintBrushSize/3, 1.5),
  },
});

let mediaRecorder: MediaRecorder | null;
function record() {
  if (mediaRecorder) {
    mediaRecorder.stop();
    mediaRecorder = null;
    return false;
  }

  let stream = reglCanvas.captureStream(30);
  let recordedChunks:Array<any> = [];

  mediaRecorder = new MediaRecorder(stream, {mimeType: 'video/webm; codecs=vp9'});

  mediaRecorder.ondataavailable = function(event) {
    console.log('data available', event.data);
    recordedChunks.push(event.data);
  };
  mediaRecorder.onstop = function(event) {
    console.log('onstop', recordedChunks.length, event);
    let blob = new Blob(recordedChunks, {type: 'video/webm'});
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = 'flow.webm';
    a.click();
    window.URL.revokeObjectURL(url);
  };
  mediaRecorder.start();
  return true;
}

let lastTime = 0;
regl.frame(function(context) {
  let deltaTime = context.time - lastTime;
  lastTime = context.time;
  { // moving average
    let instantFPS = 1/deltaTime;
    const N = 30;
    config.fps = (instantFPS + N*config.fps)/(N+1);
  }

  if (!particles.fbo)
    return;

  let t0 = performance.now();

  if (!colorSource.ensureData())
    return;

  if (config.animateFlowField)
    animateTime += deltaTime;

  regl.clear({color: [0, 0, 0, 0]});

  let t1 = performance.now();

  let readIdx = (currentTick-1 + config.numSegments) % config.numSegments;
  let writeIdx = (currentTick) % config.numSegments;

  updateParticles({readIdx: readIdx, writeIdx: writeIdx});
  particles.fbo.swap();

  let iMouse = [-1,-1,-1,-1];
  if (config.paintWithMouse) {
    for (let p of pointers) {
      if (p.isDown) {
        iMouse = [p.pos[0], 1 - p.pos[1], p.delta[0], -p.delta[1]];
        paintFlowField({iMouse: iMouse});
        flowFieldFBO.swap();
      }
    }
  }

  let t2 = performance.now();

  // if (!config.pause) {
  drawLineWithMiter({ segmentIdx: writeIdx, prevSegmentIdx: readIdx, framebuffer: screenFBO });
  // }

  let t3 = performance.now();
  blit({source: screenFBO, iMouse: iMouse});

  currentTick++;
  // console.log(`frame=${(deltaTime*1000).toFixed(2)}`, (t1 - t0).toFixed(2), (t2 - t1).toFixed(2), (t3 - t2).toFixed(2));
});