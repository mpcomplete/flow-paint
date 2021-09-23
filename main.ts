import * as Regl from "regl"
import * as Webgl2 from "./regl-webgl2-compat.js"
import { imageGenerator } from "./image-shader"

const regl = Webgl2.overrideContextType(() => Regl({canvas: "#regl-canvas", extensions: ['WEBGL_draw_buffers', 'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float', 'ANGLE_instanced_arrays']}));

type Point = [number, number];

var config = {
  numParticles: 9000,
  lineWidth: .5,
  lineLength: 0.02,
};
window.onload = function() {
  initFramebuffers();
};

let particles: any = {
  pixels: Float32Array,
  fbo: null,
  hue: [],
  birth: [],
};
let screenCanvas;
let baseImageGenerator;
function initFramebuffers() {
  let reglCanvas = document.getElementById('regl-canvas') as HTMLCanvasElement;
  screenCanvas = {
    dst: document.getElementById('screen') as HTMLCanvasElement,
    src: document.createElement('canvas') as HTMLCanvasElement,
  }
  reglCanvas.width = screenCanvas.src.width = screenCanvas.dst.width = window.innerWidth;
  reglCanvas.height = screenCanvas.src.height = screenCanvas.dst.height = window.innerHeight;

  baseImageGenerator = imageGenerator(regl, [reglCanvas.width, reglCanvas.height], {
    // type: 'vangogh', parameter: 0.0});
    type: 'image', imageUrl: 'images/face.jpg'});

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
  let rgba = baseImageGenerator.get(uv);
  particles.hue[i] = [rgba[0]*255, rgba[1]*255, rgba[2]*255, rgba[3]*100];
  particles.birth[i*4] = time;
}

const commonFrag = `#version 300 es
precision highp float;
precision highp sampler2D;

float PI = 3.14159269369;
float TAU = 6.28318530718;

// Random static, output range [0,1].
float PHIg = 1.61803398874989484820459 * 00000.1; // Golden Ratio
float PIg  = 3.14159265358979323846264 * 00000.1; // PI
float SRTg = 1.41421356237309504880169 * 10000.0; // Square Root of Two
float goldRand(in vec2 uv, in float seed) {
    return fract(sin(dot(uv*seed, vec2(PHIg, PIg)))*SRTg);
}
// Smooth noise, output range [0,1] but biased near 0.5.
vec4 mod289(vec4 x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
vec4 perm(vec4 x){return mod289(((x * 34.0) + 1.0) * x);}
float noise(vec3 p){
  vec3 a = floor(p);
  vec3 d = p - a;
  d = d * d * (3.0 - 2.0 * d);

  vec4 b = a.xxyy + vec4(0.0, 1.0, 0.0, 1.0);
  vec4 k1 = perm(b.xyxy);
  vec4 k2 = perm(k1.xyxy + b.zzww);

  vec4 c = k2 + a.zzzz;
  vec4 k3 = perm(c);
  vec4 k4 = perm(c + 1.0);

  vec4 o1 = fract(k3 * (1.0 / 41.0));
  vec4 o2 = fract(k4 * (1.0 / 41.0));

  vec4 o3 = o2 * d.z + o1 * (1.0 - d.z);
  vec2 o4 = o3.yw * d.x + o3.xz * (1.0 - d.x);

  return o4.y * d.y + o4.x * (1.0 - d.y);
}
vec2 rotate(vec2 _st, float _angle) {
    return mat2(cos(_angle), -sin(_angle),
                sin(_angle), cos(_angle)) * _st;
}
vec2 randomPoint(vec2 uv, float t) {
  float x = goldRand(uv*3., fract(t)+1.);
  float y = goldRand(uv*5., fract(t)+2.);
  return vec2(x, y);
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
  float f = .5*noise(vec3(p*5., t*.4));
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
  uniform float iTime;

  void maybeReset(inout vec2 pos, inout vec2 newPos) {
    float birth = texelFetch(birthTex, ivec2(gl_FragCoord.xy), 0).x;
    float death = maxAge*(1. + .5*goldRand(gl_FragCoord.xy + pos, fract(iTime)+1.));
    if ((iTime - birth) > death || newPos.x < 0. || newPos.x > 1. || newPos.y < 0. || newPos.y > 1.) {
      newPos = randomPoint(gl_FragCoord.xy, iTime);
      pos = vec2(-1, -1);  // Tells the main loop that this particle was reset.
    }
  }
  void main() {
    vec2 pos = texelFetch(particlesTex, ivec2(gl_FragCoord.xy), 0).zw;
    vec2 velocity = velocityAtPoint(pos, vec2(1., 0.), iTime, 1.);

    vec2 newPos = pos + velocity * .01;
    maybeReset(pos, newPos);
    fragColor = vec4(pos, newPos);
  }`,
  framebuffer: () => particles.fbo.dst,
  uniforms: {
    particlesTex: () => particles.fbo.src,
    birthTex: () => particles.birthBuffer,
    maxAge: () => config.lineLength,
    iTime: regl.context('time'),
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

  if (context.tick < 120) {
    baseImageGenerator.draw();
    return;
  }
  baseImageGenerator.ensureData();

  regl.clear({color: [0, 0, 0, 1]});

  updateParticles();
  particles.fbo.swap();

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
    // ctxDst.drawImage(document.getElementById('regl-canvas') as HTMLCanvasElement, 0, 0);

    ctxDst.drawImage(screenCanvas.src, 0, 0);
  });

  particles.birthBuffer.subimage({
    width: config.numParticles,
    height: 1,
    data: particles.birth
  });
});

