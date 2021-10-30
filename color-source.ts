type Point = [number, number];
type Shader = {code: String, command?: any};
let shaders:any = {};
let regl;

shaders['firerings'] = { code: `
vec3 firerings(vec2 uv, float t) {
  vec3 p = vec3(uv, t);
  p.xy = rotate((p.xy+1.)*.7, snoise(p)*TAU);
  float f = snoise(p)+.5;
  vec3 fv = (f + vec3(.25 + .15*sin(t*9.), .3, .25));
  vec3 c = pow(.5 + .5 * sin(2. * fv), vec3(8.0));
  return c;
}
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(firerings(uv, iTime*.01), 1.);
}`};

shaders['colorspill'] = { code: `
vec3 colorspill(vec2 uv, float t) {
  vec3 p = vec3(uv, t);
  p.xy = rotate(uv, fbm(p)*TAU);
  p.z *= 7.;
  return vec3(fbm(p+vec3(1.8)), fbm(p+vec3(11.5)), fbm(p+vec3(27.5)));
}
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(colorspill(uv, iTime*.02), 1.);
}`};

shaders['media'] = { code: `
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 tsize = vec2(textureSize(iChannel0, 0));
  vec2 scale = iResolution.xy / tsize.xy;
  vec2 uvScaled = uv;
  if (scale.x > scale.y) {
    // We scaled in y (the smaller dim). Center uv, scale it, and un-center it.
    uvScaled.x -= .5;
    uvScaled.x *= scale.x/scale.y;
    uvScaled.x += .5;
  } else {
    uvScaled.y -= .5;
    uvScaled.y *= scale.y/scale.x;
    uvScaled.y += .5;
  }
  fragColor = texture(iChannel0, uvScaled);
}`};

shaders['spiral'] = { code: `
#define time 6.31
#define phase 1.37
#define colorAngle 1.36
#define colorPhase (iTime*.2)
#define spikes 1.0

// Make a pattern of squares in a repeating grid.
vec2 dupSquare(in vec2 p) {
  vec2 ap = abs(sin(p*3.));
  float r = max(ap.x, ap.y);
  float angle = atan(p.y, p.x);

  return r*vec2(cos(angle), sin(angle));
}
// Duplicate pattern in dupSquareConcentric squares.
vec2 dupSquareConcentric(in vec2 p) {
  vec2 ap = abs(p);
  float r = max(ap.x, ap.y);
  float angle = atan(p.y, p.x);

  return sin(3.*r)*vec2(cos(angle), sin(angle));
}
// Duplicate pattern in a repeating grid.
vec2 dupGrid(in vec2 p) {
  return abs(sin(p*4.));
}

vec2 getTransform(in vec2 p, float t) {
  int which = int(mod(t, 3.)+1.);

  if (which == 2) {
    p = dupSquare(rotate(p, 3.14));
    p = rotate(p, -time*.3);
    p = dupSquare(p);
  } else {
    p = dupSquareConcentric(p*1.5);
  }
  return p;
}
vec2 applyTransform(in vec2 p) {
  float t = phase;
  float pct = smoothstep(0., 1., mod(t, 1.));
  return mix(getTransform(p, t), getTransform(p, t+1.), pct);
}

mat3 rotation(float angle, vec3 axis) {
  vec3 a = normalize(axis);
  float s = sin(angle);
  float c = cos(angle);
  float oc = 1.0 - c;

  return mat3(oc * a.x * a.x + c,        oc * a.x * a.y - a.z * s,  oc * a.z * a.x + a.y * s,
              oc * a.x * a.y + a.z * s,  oc * a.y * a.y + c,        oc * a.y * a.z - a.x * s,
              oc * a.z * a.x - a.y * s,  oc * a.y * a.z + a.x * s,  oc * a.z * a.z + c);
}

vec4 gradient(float f) {
  vec3 col1 = 0.5 + 0.5*sin(f*0.908 + vec3(0.941,1.000,0.271));
	vec3 col2 = 0.5 + 0.5*sin(f*7.240 + vec3(0.611,0.556,1.000));
	vec3 c = 1.888*pow(col1*col2, vec3(0.800,0.732,0.660));

  vec3 axis = vec3(0.454,0.725,1.072);
  c = rotation(colorAngle, axis)*c;

  return vec4(c, 1.0);
}
float offset(float th) {
  return .2*sin(25.*th)*sin(spikes);
}
vec4 tunnel(float th, float radius) {
	return gradient(offset(th) + 2.*log(radius) - colorPhase);
}

void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
  vec2 p = -1.0 + 2.0 * fragCoord.xy / iResolution.xy;
  p.x *= iResolution.x/iResolution.y;

  p = rotate(p, -2.);
  p = applyTransform(p);
	fragColor = tunnel(atan(p.y, p.x), 2.0 * length(p));
}`};

function makeShader(fragCode) {
  return regl({
    vert: `#version 300 es
    precision highp float;
    in vec2 position;
    out vec2 uv;
    void main () {
      uv = position * 0.5 + 0.5;
      gl_Position = vec4(position.x, position.y, 0.0, 1.0);
    }`,
    frag: `#version 300 es
    precision mediump float;
    precision highp int;
    in vec2 uv;
    out vec4 fragColor;
    uniform sampler2D iChannel0;
    uniform float iTime;
    uniform float parameter;
    uniform vec2 iResolution;
    void mainImage(out vec4 fragColor, in vec2 fragCoord);
    void main() {
      mainImage(fragColor, gl_FragCoord.xy);
    }` + fragCode,
    attributes: {
      position: [[-1, -1], [-1, 1], [1, 1], [-1, -1], [1, 1], [1, -1]]
    },
    count: 6,
    uniforms: {
      iChannel0: regl.prop('texture'),
      iTime: regl.context('time'),
      iResolution: (context) => [context.viewportWidth, context.viewportHeight],
      parameter: regl.prop('parameter'),
    },
    framebuffer: regl.prop('framebuffer'),
  });
}

export class ColorSource {
  private imageElement = new Image();
  private videoElement = document.createElement('video') as HTMLVideoElement;
  private outputFBO;
  private shader : Shader | null;
  private texture;
  private domElement : HTMLElement | null;
  private animated = false;
  private paused = false;
  private canDraw = false;
  private didDraw = false;

  public static create = function(reglObj, fragLib: string, size: Point) {
    regl = reglObj;
    for (let i of Object.keys(shaders))
      shaders[i].command = makeShader(fragLib + shaders[i].code);

    let instance = new ColorSource;
    instance.outputFBO = regl.framebuffer({
      color: regl.texture({
        type: 'float32',
        format: 'rgba',
        wrap: 'clamp',
        width: size[0],
        height: size[1],
      }),
      depthStencil: false,
    });
    return instance;
  };

  public load(opts:{
    type: 'media' | 'firerings' | 'colorspill' | 'spiral',
    mediaUrl?: string,
  }) {
    let statusDiv = document.querySelector('#status')!;

    this.shader = shaders[opts.type];
    this.texture?.destroy();
    this.texture = null;
    this.domElement = null;
    this.animated = true;
    this.paused = false;
    this.canDraw = opts.type != 'media';
    this.didDraw = false;
    this.videoElement.srcObject = null;
    this.imageElement.onerror = null;
    this.videoElement.onerror = null;

    if (opts.mediaUrl == 'webcam') {
      navigator.mediaDevices.getUserMedia({audio: false, video: {width: 1280, height: 720}})
      .then(function(mediaStream) {
        this.videoElement.srcObject = mediaStream;
          this.videoElement.onloadedmetadata = function(e) {
          this.canDraw = true;
          this.canDraw = true;
          this.animated = true;
          this.domElement = this.videoElement;
          this.videoElement.play();
          this.texture = regl.texture(this.domElement);
        }.bind(this);
      }.bind(this));
    } else if (opts.mediaUrl) {
      let attempts = [this.imageElement, this.videoElement];
      let errors = 0;
      for (let i = 0; i < 2; i++) {
        let elem = attempts[i];

        elem.crossOrigin = 'anonymous';
        elem.src = opts.mediaUrl;
        statusDiv.innerHTML = 'Loading...';

        let onload = (function() {
          this.canDraw = true;
          this.animated = i == 1;
          this.domElement = elem;
          this.texture = regl.texture(this.domElement);
          statusDiv.innerHTML = '';
        }).bind(this);

        if (elem instanceof HTMLVideoElement) {
          elem.autoplay = true;
          elem.loop = true;
          elem.addEventListener('loadeddata', onload);
        } else {
          elem.onload = onload;
        }
        elem.onerror = function() {
          if (++errors >= 2)
            statusDiv.innerHTML = 'Error loading media';
        }
      }
    }
  }

  public ensureData() {
    let shouldAnimate = this.animated && !this.paused;
    if (this.canDraw && (shouldAnimate || !this.didDraw)) {
      this.shader!.command({texture: this.texture?.subimage(this.domElement), framebuffer: this.outputFBO});
      this.didDraw = true;
    }
    return this.didDraw;
  }

  public pause() {
    if (!this.animated)
      return false;
    this.paused = !this.paused;
    if (this.paused) {
      this.videoElement.pause();
    } else {
      this.videoElement.play();
    }
    return this.paused;
  }

  public getTexture() { return this.outputFBO.color[0]; }
}