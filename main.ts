import * as Regl from "regl"
import * as Webgl2 from "./regl-webgl2-compat.js"

const regl = Webgl2.overrideContextType(() => Regl({extensions: ['WEBGL_draw_buffers', 'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float', 'ANGLE_instanced_arrays']}));

var config = {
  numParticles: 900,
};
window.onload = function() {
  initFramebuffers();
};

let screenFBO;
let particlesFBO;
function initFramebuffers() {
  let canvas = document.getElementsByTagName("canvas")[0];
  screenFBO = createDoubleFBO(1, {
    type: 'half float',
    format: 'rgba',
    wrap: 'clamp',
    min: 'linear',
    mag: 'linear',
    width: canvas.width,
    height: canvas.height,
  });

  // Holds the particle positions. particles[i, 0].xyzw = {lastPosX, lastPosY, posX, posY}
  particlesFBO = createDoubleFBO(1, {
    type: 'float32',
    format: 'rgba',
    wrap: 'clamp',
    width: config.numParticles,
    height: 1,
  });
  
  // particlesFBO.src.color[0].subimage({ // position
  //   width: config.numParticles,
  //   height: 1,
  //   data: Array.from({length: config.numParticles}, (_, i) => [0,0,0,0]),
  // });
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

const bufferA = regl({
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

  frag: `#version 300 es
  precision highp float;
  precision highp sampler2D;

  in vec2 uv;
  in vec2 ijf;
  out vec4 fragColor;
  uniform sampler2D particlesTex;
  uniform float time;

#define PI 3.1415
#define CELL_COUNT 16.
#define SPEED 2.
#define TIME (iTime * SPEED)

#define PARTICLES_COUNT 64.
#define MAX_PARTICLE_Y floor(PARTICLES_COUNT/480.)
#define PIX (uv.y * 480. + uv.x)

  float random (in vec2 _st) {
    return fract(sin(dot(_st.xy,
                        vec2(12.9898,78.233)))*
        43758.5453123);
  }

  // Based on Morgan McGuire @morgan3d
  // https://www.shadertoy.com/view/4dS3Wd
  float noise (in vec2 _st) {
    vec2 i = floor(_st);
    vec2 f = fract(_st);

    // Four corners in 2D of a tile
    float a = random(i);
    float b = random(i + vec2(1.0, 0.0));
    float c = random(i + vec2(0.0, 1.0));
    float d = random(i + vec2(1.0, 1.0));

    vec2 u = f * f * (3.0 - 2.0 * f);

    return mix(a, b, u.x) +
            (c - a)* u.y * (1.0 - u.x) +
            (d - b) * u.x * u.y;
  }
  
  float turb( vec2 U, float t )
  { 	float f = 0., q=1., s=0.;
    
      float m = 2.; 
   // mat2 m = mat2( 1.6,  1.2, -1.2,  1.6 );
      for (int i=0; i<2; i++) {
        U -= t*vec2(.6,.2);
        f += q*noise( U ); 
        s += q; 
        q /= 2.; U *= m; t *= 1.71;  // because of diff, we may rather use q/=4.;
      }
      return f/s; 
  }
  vec2 rotate2D (vec2 _st, float _angle) {
      return mat2(cos(_angle), -sin(_angle),
                  sin(_angle), cos(_angle)) * _st;
  }
  vec2 randomOnEdge(vec2 uv, vec2 MAX){
    float x = noise(uv);
    float y = noise(uv*.25 + .25);
    return vec2(x, y);
  }
  vec3 hsv2rgb(vec3 c) {
    // Íñigo Quílez
    // https://www.shadertoy.com/view/MsS3Wc
    vec3 rgb = clamp(abs(mod(c.x*6.+vec3(0.,4.,2.),6.)-3.)-1.,0.,1.);
    rgb = rgb * rgb * (3. - 2. * rgb);
    return c.z * mix(vec3(1.), rgb, c.y);
  }

  void checkForBounds(float pos, inout vec2 ptnt, inout vec2 prevPtnt){
    if(ptnt.x < 0. || ptnt.x > 1. || ptnt.y < 0. || ptnt.y > 1.)
          prevPtnt = ptnt = randomOnEdge(vec2(pos, 0.), vec2(1.));
  }

  void main() {
    float partIndex = ijf.x;
    // if (partIndex <= PARTICLES_COUNT)
    //     return;
    vec2 pos = texelFetch(particlesTex, ivec2(ijf), 0).zw;

    float f = noise(pos*5.);
    // TODO: figure out why the angle is negated vs drawParticles.
    vec2 velocity = rotate2D(vec2(1., 0.), -f * PI * 2.);

    vec2 newPos = pos + velocity * .01;
    checkForBounds(partIndex, newPos, pos);
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
  frag: `#version 300 es
  precision highp float;
  precision highp sampler2D;

  in vec2 uv;
  uniform sampler2D particlesTex;
  uniform sampler2D screenTex;
  uniform float numParticles;
  uniform float time;
  out vec4 fragColor;

  #define PI 3.1415

  float random (in vec2 _st) {
    return fract(sin(dot(_st.xy,
                         vec2(12.9898,78.233)))*
           43758.5453123);
  }
  // Based on Morgan McGuire @morgan3d
  // https://www.shadertoy.com/view/4dS3Wd
  float noise (in vec2 _st) {
    vec2 i = floor(_st);
    vec2 f = fract(_st);

    // Four corners in 2D of a tile
    float a = random(i);
    float b = random(i + vec2(1.0, 0.0));
    float c = random(i + vec2(0.0, 1.0));
    float d = random(i + vec2(1.0, 1.0));

    vec2 u = f * f * (3.0 - 2.0 * f);

    return mix(a, b, u.x) +
            (c - a)* u.y * (1.0 - u.x) +
            (d - b) * u.x * u.y;
  }
  vec3 hsv2rgb(vec3 c) {
    // Íñigo Quílez
    // https://www.shadertoy.com/view/MsS3Wc
    vec3 rgb = clamp(abs(mod(c.x*6.+vec3(0.,4.,2.),6.)-3.)-1.,0.,1.);
    rgb = rgb * rgb * (3. - 2. * rgb);
    return c.z * mix(vec3(1.), rgb, c.y);
  }
  vec2 rotate2D (vec2 _st, float _angle) {
      return mat2(cos(_angle), -sin(_angle),
                  sin(_angle), cos(_angle)) * _st;
  }
  float dist2Line(vec2 a, vec2 b, vec2 p) {
    p -= a, b -= a;
    float h = clamp(dot(p, b) / dot(b, b), 0., 1.);
    return length( p - b * h );
  }
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
    uv = rotate2D(uv, -PI*.5);
    return 1. - sign(sdTriangleIsosceles(uv - vec2(0., .5), vec2(.15, -.75)));
  }
  void main() {
    vec3 clr = vec3(0.);
    for (float i = 0.; i < numParticles; i++) {
      vec4 pos = texelFetch(particlesTex, ivec2(i, 0), 0);
      // seeds += 1. - smoothstep(.001, .005, distance(uv, pos.zw));
      float p = 1. - smoothstep(.0002, .0005, dist2Line(pos.xy, pos.zw, uv));
      if (p > 0.)
        clr += hsv2rgb(vec3(i/numParticles, 1., 1.));
    }

    float f = noise(uv*5.);
    // TODO: figure out why the angle is negated vs bufferA.
    vec2 velocity = rotate2D(fract(uv*64.) - .5, f * PI * 2.);
    float c = cell(velocity);
    clr += hsv2rgb(vec3(c* (f > .25 && f < .75 ? .1 : .4), 1., c));

    fragColor = vec4(clr, 1.);
    // fragColor = vec4(clr + texture(screenTex, uv).rgb * .98, 1.);
  }`,

  uniforms: {
    screenTex: regl.prop("screen"),
    particlesTex: () => particlesFBO.src,
    numParticles: () => config.numParticles,
    time: regl.context('time'),
  },
});

const blit = baseVertShader({
  frag: `#version 300 es
  precision highp float;
  precision highp sampler2D;

  in vec2 uv;
  uniform sampler2D screenTex;
  out vec4 fragColor;

  void main() {
  	fragColor = vec4(texture(screenTex, uv).rgb, 1.);
  }`,

  uniforms: {
    screenTex: regl.prop("screen"),
  },
});

regl.frame(function(context) {
  if (!screenFBO)
    return;

  regl.clear({color: [0, 0, 0, 1]});
  regl.clear({color: [0, 0, 0, 1], framebuffer: screenFBO.dst});

  bufferA();
  particlesFBO.swap();

  drawParticles({screen: screenFBO.src, framebuffer: screenFBO.dst});
  screenFBO.swap();

  blit({screen: screenFBO.src});
});