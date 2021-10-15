type Point = [number, number];

let shaders = [];
shaders['vangogh'] = `
`;

shaders['image'] = `
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 tsize = vec2(textureSize(iChannel0, 0));
  vec2 scale = vec2(iResolution.x/tsize.x, iResolution.y/tsize.y);
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
}`;

function makeShader(regl, fragCode) {
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

export function makeColorSource(regl, size: Point, opts:{
  type: 'image' | 'vangogh',
  imageUrl?: string,
  parameter?: number, // TODO iMouse
}) {
  const shader = makeShader(regl, shaders[opts.type]);
  const fbo = regl.framebuffer({
    color: regl.texture({
      type: 'float32',
      format: 'rgba',
      wrap: 'clamp',
      // min: 'linear',
      // mag: 'linear',
      width: size[0],
      height: size[1],
    }),
    depthStencil: false,
  });

  let texture;
  let waitImage = false;
  let statusDiv = document.querySelector('#status')!;
  if (opts.imageUrl) {
    var image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = opts.imageUrl;
    texture = regl.texture();
    waitImage = true;
    statusDiv.innerHTML = 'Loading...';
    image.onload = function() {
      texture = regl.texture(image);
      waitImage = false;
      statusDiv.innerHTML = '';
    }
    image.onerror = function() {
      statusDiv.innerHTML = 'Error loading image';
    }
  }

  let ready = false;
  return {
    draw: () => shader({texture: texture, parameter: opts.parameter}),
    ensureData: function() {
      if (!ready && !waitImage) {
        regl({framebuffer: fbo})(() => {
          shader({texture: texture, parameter: opts.parameter, framebuffer: fbo});
          ready = true;
        });
      }
      return ready;
    },
    getTexture: () => fbo.color[0],
  };
}