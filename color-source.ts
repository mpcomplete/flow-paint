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
  private videoElement = document.createElement('video');
  private outputFBO;
  private shader : Shader | null;
  private texture;
  private domElement : HTMLElement | null;
  private animated = false;
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
    type: 'media' | 'firerings' | 'colorspill',
    mediaUrl?: string,
  }) {
    let statusDiv = document.querySelector('#status')!;

    this.shader = shaders[opts.type];
    this.texture?.destroy();
    this.texture = null;
    this.domElement = null;
    this.animated = true;
    this.canDraw = !opts.mediaUrl;
    this.didDraw = false;

    if (opts.mediaUrl) {
      let attempts = [this.imageElement, this.videoElement];
      let errors = 0;
      for (let i = 0; i < 2; i++) {
        let elem = attempts[i];

        elem.crossOrigin = 'anonymous';
        elem.src = opts.mediaUrl;
        statusDiv.innerHTML = 'Loading...';

        let onload = (function() {
          this.canDraw = true;
          this.domElement = elem;
          this.texture = regl.texture(this.domElement);
          statusDiv.innerHTML = '';
        }).bind(this);

        if (elem instanceof HTMLVideoElement) {
          this.animated = true;
          elem.autoplay = true;
          elem.loop = true;
          elem.addEventListener('loadeddata', onload);
        } else {
          this.animated = false;
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
    if (this.canDraw && (this.animated || !this.didDraw)) {
      this.shader!.command({texture: this.texture?.subimage(this.domElement), framebuffer: this.outputFBO});
      this.didDraw = true;
    }
    return this.didDraw;
  }

  public getTexture() { return this.outputFBO.color[0]; }
}