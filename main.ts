import * as Regl from "regl"
import * as Webgl2 from "./regl-webgl2-compat.js"
import { imageGenerator } from "./image-shader"
import * as dragdrop from "./dragdrop"
import * as dat from "dat.gui"

const regl = Webgl2.overrideContextType(() => Regl({canvas: "#regl-canvas", extensions: ['WEBGL_draw_buffers', 'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float', 'ANGLE_instanced_arrays']}));

type Point = [number, number];

var config:any = { };
window.onload = function() {
  let gui = new dat.GUI();
  const readableName = (n) => n.replace(/([A-Z])/g, ' $1').toLowerCase()
  function addConfig(name, initial, min?, max?) {
    config[name] = initial;
    return gui.add(config, name, min, max).name(readableName(name));
  }
  addConfig('numParticles', 9000, 1000, 16000).name('line count').step(500).onFinishChange(initFramebuffers);
  addConfig('lineWidth', 0.5, 0.2, 20.0).step(.01);
  addConfig('lineLength', 0.09, 0.02, 1.0).step(.01);
  addConfig('lineSpeed', 1., 0.1, 2.0).step(.01);
  addConfig('drawFlowField', true);
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
let startTime:Date;
function initFramebuffers() {
  reglCanvas = document.getElementById('regl-canvas') as HTMLCanvasElement;
  screenCanvas = {
    dst: document.getElementById('screen') as HTMLCanvasElement,
    src: document.createElement('canvas') as HTMLCanvasElement,
  }
  reglCanvas.width = screenCanvas.src.width = screenCanvas.dst.width = window.innerWidth;
  reglCanvas.height = screenCanvas.src.height = screenCanvas.dst.height = window.innerHeight;

  // initGenerator({type: 'vangogh', parameter: 0.0});
  initGenerator({type: 'image', imageUrl: 'images/face.jpg'});

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
  startTime = new Date();

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

const commonFrag = `#version 300 es
precision highp float;
precision highp sampler2D;

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
// TODO: figure out why the angle is negated in updateParticles vs drawFlowField.
vec2 velocityAtPoint(vec2 p, vec2 uv, float t, float signHACK) {
  // t=0.;
  // return normalize(noise3(vec3(p*5., t*.4)).xy);
  float f = noise3(vec3(p*7., t*.4)).x;
  // float f = .5*sin(p.x*3.2 + p.y*4.5 + t*.4) + .5*sin(p.x*p.y*TAU);
  // float f = noise(vec3(p*99.+99., p.x*p.y));
  return rotate(uv, f * TAU * signHACK);
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
  uniform float iTime;
  uniform vec2 iResolution;

  void maybeReset(inout vec2 pos, inout vec2 newPos) {
    float birth = texelFetch(birthTex, ivec2(gl_FragCoord.xy), 0).x;
    float death = maxAge*(1. + .5*hash3(vec3(gl_FragCoord.xy/iResolution.xy + pos, iTime)).x);
    if ((iTime - birth) > death || newPos.x < 0. || newPos.x > 1. || newPos.y < 0. || newPos.y > 1.) {
      newPos = randomPoint(gl_FragCoord.xy, iTime);
      pos = vec2(-1, -1);  // Tells the main loop that this particle was reset.
    }
  }
  void main() {
    vec2 pos = texelFetch(particlesTex, ivec2(gl_FragCoord.xy), 0).zw;
    vec2 velocity = velocityAtPoint(pos, vec2(0., 1.), iTime, 1.);

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
    iTime: regl.context('time'),
    iResolution: (context) => [context.viewportWidth, context.viewportHeight],
  },
});

const drawFlowField = baseVertShader({
  frag: commonFrag + `
  in vec2 uv;
  uniform float iTime;
  out vec4 fragColor;

  // p is base, q is width,height
  float sdTriangleIsosceles( in vec2 p, in vec2 q ) {
      p.x = abs(p.x);
      vec2 a = p - q*clamp( dot(p,q)/dot(q,q), 0.0, 1.0 );
      vec2 b = p - q*vec2( clamp( p.x/q.x, 0.0, 1.0 ), 1.0 );
      float s = -sign( q.y );
      vec2 d = min( vec2( dot(a,a), s*(p.x*q.y-p.y*q.x) ),
                    vec2( dot(b,b), s*(p.y-q.y)  ));
      return -sqrt(d.x)*sign(d.y);
  }
  float cell(in vec2 uv) {
    uv = rotate(uv, -PI*.5);
    return 1. - sign(sdTriangleIsosceles(uv - vec2(0., .5), vec2(.05, -.4)));
  }
  void main() {
    vec2 velocity = velocityAtPoint(uv, fract(uv*64.) - .5, iTime, -1.0);
    float c = cell(velocity);
    fragColor.rgb = vec3(c);
  }`,
  uniforms: {
    iTime: regl.context('time'),
  },
});

regl.frame(function(context) {
  if (!particles.fbo)
    return;

  if ((new Date().getTime() - startTime.getTime()) < 2000) {
    sourceImageGenerator.draw();
    return;
  }
  sourceImageGenerator.ensureData();

  regl.clear({color: [0, 0, 0, 0]});

  updateParticles();
  particles.fbo.swap();

  if (config.drawFlowField)
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

