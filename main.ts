import * as Regl from "regl"
import * as Webgl2 from "./regl-webgl2-compat.js"

const regl = Webgl2.overrideContextType(() => Regl({canvas: "#regl-canvas", extensions: ['WEBGL_draw_buffers', 'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float', 'ANGLE_instanced_arrays']}));

var config = {
  numParticles: 9000,
};
window.onload = function() {
  initFramebuffers();
};

let particlesFBO;
let screenCanvas;
let reglCanvas;
function initFramebuffers() {
  reglCanvas = document.getElementById('regl-canvas') as HTMLCanvasElement;
  screenCanvas = {
    dst: document.getElementById('screen') as HTMLCanvasElement,
    src: document.createElement('canvas') as HTMLCanvasElement,
  }
  reglCanvas.width = screenCanvas.src.width = screenCanvas.dst.width = window.innerWidth;
  reglCanvas.height = screenCanvas.src.height = screenCanvas.dst.height = window.innerHeight;

  // Holds the particle data.
  particlesFBO = createDoubleFBO(2, {
    type: 'float32',
    format: 'rgba',
    wrap: 'clamp',
    width: config.numParticles,
    height: 1,
  });

  // Position. particles0[i, 0].xyzw = {lastPosX, lastPosY, posX, posY}
  particlesFBO.src.color[0].subimage({
    width: config.numParticles,
    height: 1,
    data: Array.from({length: config.numParticles}, (_, i) => [0,0,Math.random(),Math.random()]),
  });
  
  // Hue. particles1[i, 0].xyzw = {hue, _, _, _}
  particlesFBO.src.color[1].subimage({
    width: config.numParticles,
    height: 1,
    data: Array.from({length: config.numParticles}, (_, i) => [Math.random(), 0, 0, 0]),
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

const commonFrag = `#version 300 es
precision highp float;
precision highp sampler2D;

#define PI 3.1415

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
float turb( vec2 U, float t ) {
  float f = 0., q=1., s=0.;

  float m = 2.;
// mat2 m = mat2( 1.6,  1.2, -1.2,  1.6 );
  for (int i=0; i<2; i++) {
    U -= t*vec2(.6,.2);
    f += q*noise(vec3(U,t));
    s += q;
    q /= 2.; U *= m; t *= 1.71;  // because of diff, we may rather use q/=4.;
  }
  return f/s;
}
vec2 rotate(vec2 _st, float _angle) {
    return mat2(cos(_angle), -sin(_angle),
                sin(_angle), cos(_angle)) * _st;
}
vec2 randomPoint(vec2 uv, float t) {
  float x = noise(vec3(uv*3., t));
  float y = noise(vec3(uv*5., t+5.));
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
  // float f = noise(vec3(p*5., t*.4));
  float f = turb(p*5., t*.1)*1.5;
  // f += .3*sin(p.x*.2 + p.y*.5);
  return rotate(uv, f * PI * 2. * signHACK);
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
  uniform sampler2D positionTex;
  uniform sampler2D hueTex;
  uniform float time;

  layout(location = 0) out vec4 fragData0; // position
  layout(location = 1) out vec4 fragData1; // hue

  void checkForBounds(inout vec2 pos, inout vec2 newPos){
    if (newPos.x < 0. || newPos.x > 1. || newPos.y < 0. || newPos.y > 1.)
      newPos = pos = randomPoint(gl_FragCoord.xy, time);
  }
  void main() {
    vec2 pos = texelFetch(positionTex, ivec2(gl_FragCoord.xy), 0).zw;
    vec2 velocity = velocityAtPoint(pos, vec2(1., 0.), time, 1.);

    vec2 newPos = pos + velocity * .01;
    checkForBounds(pos, newPos);
    fragData0 = vec4(pos, newPos);
    fragData1 = texelFetch(hueTex, ivec2(gl_FragCoord.xy), 0);
  }`,
  uniforms: {
    positionTex: () => particlesFBO.src.color[0],
    hueTex: () => particlesFBO.src.color[1],
    time: regl.context('time'),
  },
  framebuffer: () => particlesFBO.dst,
});

const drawFlowField = baseVertShader({
  frag: commonFrag + `
  in vec2 uv;
  uniform float time;
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
    vec2 velocity = velocityAtPoint(uv, fract(uv*64.) - .5, time, -1.0);
    float c = cell(velocity);
    fragColor.rgb = vec3(c);
  }`,
  uniforms: {
    time: regl.context('time'),
  },
});

regl.frame(function(context) {
  if (!particlesFBO)
    return;

  regl.clear({color: [0, 0, 0, 1]});

  updateParticles();
  particlesFBO.swap();

  drawFlowField({});

  regl({framebuffer: particlesFBO.dst})(() => {
    let gl = reglCanvas.getContext('webgl2');
    gl.readBuffer(gl.COLOR_ATTACHMENT1);  // FIXME
    let pixels = regl.read() as Float32Array;
    let ctx = screenCanvas.src.getContext('2d');
    ctx.clearRect(0, 0, screenCanvas.src.width, screenCanvas.src.height);
    if (!ctx || context.tick < 4) return;
    console.log("pixels=", pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      let [ox, oy] = [pixels[i], pixels[i+1]];
      let [px, py] = [pixels[i+2], pixels[i+3]];
      let hue = 160 + 120 * i/config.numParticles/4;
      ctx.strokeStyle = `hsl(${hue}, 100%, 50%)`;
      ctx.beginPath();
      ctx.moveTo(ox * screenCanvas.src.width, oy * screenCanvas.src.height);
      ctx.lineTo(px * screenCanvas.src.width, py * screenCanvas.src.height);
      ctx.lineWidth = .1;
      ctx.stroke();
    }
    let ctxDst = screenCanvas.dst.getContext('2d') as CanvasRenderingContext2D;
    ctxDst.fillStyle = 'rgba(0, 0, 0, 1.0%)';
    ctxDst.fillRect(0, 0, screenCanvas.dst.width, screenCanvas.dst.height);
    // ctxDst.drawImage(reglCanvas, 0, 0);

    ctxDst.drawImage(screenCanvas.src, 0, 0);
  });
});

