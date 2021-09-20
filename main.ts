import * as Regl from "regl"
import * as Webgl2 from "./regl-webgl2-compat.js"

const regl = Webgl2.overrideContextType(() => Regl({canvas: "#regl-canvas", extensions: ['WEBGL_draw_buffers', 'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float', 'ANGLE_instanced_arrays']}));

var config = {
  numParticles: 900,
};
window.onload = function() {
  initFramebuffers();
};

let screenFBO;
let particlesFBO;
let screenCanvas : HTMLCanvasElement;
function initFramebuffers() {
  let canvas = document.getElementsByTagName('canvas')[0];
  screenFBO = createDoubleFBO(1, {
    type: 'half float',
    format: 'rgba',
    wrap: 'clamp',
    min: 'linear',
    mag: 'linear',
    width: canvas.width,
    height: canvas.height,
  });
  screenCanvas = document.getElementById('screen') as HTMLCanvasElement;
  if (screenCanvas) {
    console.log(screenCanvas);
    screenCanvas.width = window.innerWidth;
    screenCanvas.height = window.  innerHeight;
  }

  // Holds the particle positions. particles[i, 0].xyzw = {lastPosX, lastPosY, posX, posY}
  particlesFBO = createDoubleFBO(1, {
    type: 'float32',
    format: 'rgba',
    wrap: 'clamp',
    width: config.numParticles,
    height: 1,
  });

  particlesFBO.src.color[0].subimage({ // position
    width: config.numParticles,
    height: 1,
    data: Array.from({length: config.numParticles}, (_, i) => [0,0,Math.random(),Math.random()]),
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

function HSVtoRGB(h, s, v) {
  let r, g, b, i, f, p, q, t;
  i = Math.floor(h * 6);
  f = h * 6 - i;
  p = v * (1 - s);
  q = v * (1 - f * s);
  t = v * (1 - (1 - f) * s);

  switch (i%6) {
    case 0: r=v, g=t, b=p; break;
    case 1: r=q, g=v, b=p; break;
    case 2: r=p, g=v, b=t; break;
    case 3: r=p, g=q, b=v; break;
    case 4: r=t, g=p, b=v; break;
    case 5: r=v, g=p, b=q; break;
  }

  return [
    r,
    g,
    b
  ];
}

const baseVertShader = (opts) => regl(Object.assign(opts, {
  vert: `#version 300 es
  precision highp float;
  in vec2 position;
  out vec2 uv;
  uniform sampler2D particles;
  void main () {
    uv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
  }`,

  attributes: {
    position: [[-1, -1], [-1, 1], [1, 1], [-1, -1], [1, 1], [1, -1]]
  },
  count: 6,
  framebuffer: regl.prop("framebuffer"),
}));

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
vec2 randomPoint(vec2 uv) {
  float x = noise(vec3(uv, 0.));
  float y = noise(vec3(uv, 5.));
  return vec2(x, y);
}
vec3 hsv2rgb(vec3 c) {
  // Íñigo Quílez
  // https://www.shadertoy.com/view/MsS3Wc
  vec3 rgb = clamp(abs(mod(c.x*6.+vec3(0.,4.,2.),6.)-3.)-1.,0.,1.);
  rgb = rgb * rgb * (3. - 2. * rgb);
  return c.z * mix(vec3(1.), rgb, c.y);
}
// TODO: figure out why the angle is negated in updateParticles vs drawParticles.
vec2 velocityAtPoint(vec2 p, vec2 uv, float t, float signHACK) {
  float f = noise(vec3(p*5., t*.4));
  return rotate(uv, f * PI * 2. * signHACK);
}`;

const updateParticles = regl({
  vert: `#version 300 es
  precision highp float;
  in vec2 position;
  out vec2 uv;
  out vec2 ijf;
  uniform sampler2D particlesTex;
  void main () {
    ijf = vec2(textureSize(particlesTex, 0)) * (position * .5 + .5);
    uv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
  }`,

  frag: commonFrag + `
  in vec2 uv;
  in vec2 ijf;
  out vec4 fragColor;
  uniform sampler2D particlesTex;
  uniform float time;

  void checkForBounds(inout vec2 pos, inout vec2 newPos){
    if (newPos.x < 0. || newPos.x > 1. || newPos.y < 0. || newPos.y > 1.)
      newPos = pos = randomPoint(vec2(ijf.x, 0.));
  }

  void main() {
    vec2 pos = texelFetch(particlesTex, ivec2(ijf), 0).zw;
    vec2 velocity = velocityAtPoint(pos, vec2(1., 0.), time, -1.);

    vec2 newPos = pos + velocity * .01;
    checkForBounds(pos, newPos);
    fragColor = vec4(pos, newPos);
  }`,

  attributes: {
    position: [[-1, -1], [-1, 1], [1, 1], [-1, -1], [1, 1], [1, -1]]
  },
  count: 6,
  framebuffer: () => particlesFBO.dst,
  uniforms: {
    particlesTex: () => particlesFBO.src,
    time: regl.context('time'),
  },
});

const drawParticles = baseVertShader({
  frag: commonFrag + `
  in vec2 uv;
  uniform sampler2D particlesTex;
  uniform sampler2D screenTex;
  uniform float numParticles;
  uniform float time;
  out vec4 fragColor;

  float dist2Line(vec2 a, vec2 b, vec2 p) {
    p -= a, b -= a;
    float h = clamp(dot(p, b) / dot(b, b), 0., 1.);
    return length( p - b * h );
  }
  void main() {
    vec3 clr = vec3(0.);
    for (float i = 0.; i < numParticles; i++) {
      vec4 pos = texelFetch(particlesTex, ivec2(i, 0), 0);
      float p = 1. - smoothstep(.0002, .0015, dist2Line(pos.xy, pos.zw, uv));
      clr += p*hsv2rgb(vec3(.3+.5*i/numParticles, 1., 1.));
    }

    // fragColor = vec4(clr, 1.);
    fragColor = vec4(clr + texture(screenTex, uv).rgb * .97, 1.);
  }`,

  uniforms: {
    screenTex: regl.prop('screen'),
    particlesTex: () => particlesFBO.src,
    numParticles: () => config.numParticles,
    time: regl.context('time'),
  },
});

const blit = baseVertShader({
  frag: commonFrag + `
  in vec2 uv;
  uniform sampler2D screenTex;
  uniform bool drawFlowField;
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
    fragColor = vec4(texture(screenTex, uv).rgb, 1.);

    if (drawFlowField) {
      vec2 velocity = velocityAtPoint(uv, fract(uv*64.) - .5, time, 1.0);
      float c = cell(velocity);
      fragColor.rgb += vec3(c);
    }
  }`,

  uniforms: {
    screenTex: regl.prop('screen'),
    drawFlowField: regl.prop('drawFlowField'),
    time: regl.context('time'),
  },
});

regl.frame(function(context) {
  if (!screenFBO)
    return;

  regl.clear({color: [0, 0, 0, 1]});
  // regl.clear({color: [0, 0, 0, 1], framebuffer: screenFBO.dst});

  updateParticles();
  particlesFBO.swap();

  regl({framebuffer: particlesFBO.dst})(() => {
    let pixels = regl.read() as Float32Array;
    let ctx = screenCanvas.getContext('2d');
    if (!ctx || context.tick < 4) return;
    // ctx.clearRect(0, 0, screenCanvas.width, screenCanvas.height);
    for (let i = 0; i < pixels.length; i += 4) {
      let [ox, oy] = [pixels[i], pixels[i+1]];
      let [px, py] = [pixels[i+2], pixels[i+3]];
      let hue = 160 + 120 * i/config.numParticles/4;
      ctx.strokeStyle = `hsl(${hue}, 100%, 50%)`;
      ctx.fillStyle = 'white';
      // ctx.fillRect(px * screenCanvas.width, py * screenCanvas.height, 1, 1);
      ctx.beginPath();
      ctx.moveTo(ox * screenCanvas.width, oy * screenCanvas.height);
      // ctx.moveTo(0, 0);
      ctx.lineTo(px * screenCanvas.width, py * screenCanvas.height);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  });

  // drawParticles({screen: screenFBO.src, framebuffer: screenFBO.dst});
  // screenFBO.swap();

  // blit({screen: screenFBO.src, drawFlowField: false});
});

