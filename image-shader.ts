export function imageShader(regl) {
  return regl({
    vert: `#version 300 es
    precision highp float;
    in vec2 position;
    out vec2 uv;

    void main () {
      uv = position * 0.5 + 0.5;
      // HTML5 canvas has y=0 at the top, GL at the bottom.
      gl_Position = vec4(position.x, -position.y, 0.0, 1.0);
    }`,
    frag: `#version 300 es
    precision highp float;
    precision highp sampler2D;
    in vec2 uv;
    uniform float iTime;
    out vec4 fragColor;

    #define time (0.)

    vec4 mod289(vec4 x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
    vec4 perm(vec4 x){return mod289(((x * 34.0) + 1.0) * x);}
    float noise3(vec3 p){
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

    float noise(vec2 p) {
      return noise3(vec3(p, time*0.7));
    }

    const mat2 m = mat2( 0.80,  0.60, -0.60,  0.80 );

    float fbm4( vec2 p )
    {
      float f = 0.0;
      f += 0.5000*noise( p ); p = m*p*2.02;
      f += 0.2500*noise( p ); p = m*p*2.03;
      f += 0.1250*noise( p ); p = m*p*2.01;
      f += 0.0625*noise( p );
      return f/0.9375;
    }

    //vec2 mid(vec2 p) { return .5 + .5*p; }
    vec2 mid(vec2 p) { return p; }

    float fbm6( vec2 p )
    {
      float f = 0.0;
      f += 0.500000*noise(mid(p)); p = m*p*2.02;
      f += 0.250000*noise(mid(p)); p = m*p*2.03;
      f += 0.125000*noise(mid(p)); p = m*p*2.01;
      f += 0.062500*noise(mid(p)); p = m*p*2.04;
      f += 0.031250*noise(mid(p)); p = m*p*2.01;
      f += 0.015625*noise(mid(p));
      return f/0.96875;
    }

    vec2 fbm4_2( vec2 p )
    {
      return vec2(fbm4(p), fbm4(p+vec2(7.8)));
    }

    vec2 fbm6_2( vec2 p )
    {
      return vec2(fbm6(p+vec2(16.8)), fbm6(p+vec2(11.5)));
    }

    vec3 fbm4_3(in vec2 p)
    {
      return vec3(fbm4(p), fbm4(p+vec2(7.8)), fbm4(p+vec2(-4.2)));
    }

    mat3 rotation(float angle, vec3 axis)
    {
      vec3 a = normalize(axis);
      float s = sin(angle);
      float c = cos(angle);
      float oc = 1.0 - c;

      return mat3(oc * a.x * a.x + c,        oc * a.x * a.y - a.z * s,  oc * a.z * a.x + a.y * s,
                  oc * a.x * a.y + a.z * s,  oc * a.y * a.y + c,        oc * a.y * a.z - a.x * s,
                  oc * a.z * a.x - a.y * s,  oc * a.y * a.z + a.x * s,  oc * a.z * a.z + c);
    }

    vec3 func(vec2 p)
    {
      vec2 q = fbm4_2(p);
      vec2 r = fbm6_2(p + 2.1*q+(sin(.6*time)));
      return fbm4_3(p + 3.9*r + (sin(time)));
    }

    void main()
    {
      vec2 p = -1.0 + 2.0 * uv;
      // p.x *= iResolution.x/iResolution.y;

      p.x = p.x*(1. + .2*sin(time*2.));
      p.y = p.y*(1. + .2*sin(time*2.));
      p += vec2(6.5, 6.5);

      vec3 color = func(1.5*p);
      fragColor.xyz = color;
    //    return;

      color = time*vec3(0.9, 0.7, 0.25) + color;

      float c1 = color.x*3.;
      float c2 = color.y*9.;
      vec3 col1 = 0.5 + 0.5*sin(c1 + vec3(0.0,0.5,1.0));
      vec3 col2 = 0.5 + 0.5*sin(c2 + vec3(0.5,1.0,0.0));
      color = 2.0*pow(col1*col2,vec3(0.8));

      vec3 axis = fbm4_3(p*2.75);
      color = rotation(.9*length(axis)*sin(8.*time), axis)*color;

      fragColor.xyz = color;
      fragColor.a = 1.;
    }
    `,

    attributes: {
      position: [[-1, -1], [-1, 1], [1, 1], [-1, -1], [1, 1], [1, -1]]
    },
    count: 6,
    uniforms: {
      iTime: regl.context('time'),
    },
    framebuffer: regl.prop('framebuffer'),
  });
}