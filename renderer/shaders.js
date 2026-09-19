'use strict';

/**
 * 黑洞着色器
 *
 * 物理设定（几何单位，史瓦西半径 Rs = 1）：
 *   事件视界      r = 1
 *   光子球        r = 1.5
 *   临界碰撞参数  b = 3√3/2 ≈ 2.598   → 阴影半径
 *   ISCO          r = 3
 *
 * 每条光线从相机出发，用零测地线的标准近似做积分：
 *     a = -1.5 · h² · r / |r|⁵        (h = r × v，守恒)
 * 光线要么落入视界（→ 黑），要么逃逸到无穷远（→ 采样桌面纹理）。
 * 逃逸方向反投影回屏幕，就得到引力透镜后的背景 —— 因为 fov 是按
 * 「sp=1 ⇔ b=b_crit」标定的，所以远处未被弯曲的光线采样到的正好是它自己
 * 那一像素，桌面快照能天衣无缝地和真实桌面接上。
 */

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

uniform vec2  uRes;
uniform vec2  uCenter;
uniform float uHoleR;
uniform float uTime;
uniform float uCamD;
uniform float uCamH;
uniform float uRoll;
uniform float uLensR;
uniform float uMaxSteps;
uniform float uBGMode;
uniform float uDiskBright;
uniform float uJets;
uniform float uFlash;
uniform float uSpin;
uniform float uRingGlow;
uniform float uDebug;
uniform sampler2D uDesktop;

const float BCRIT = 2.5980762;
const float RIN   = 3.0;
const float ROUT  = 14.0;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

float fbm3(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p *= 2.07; a *= 0.5; }
  return s;
}

/* 吸积盘发光：命中点 → 前乘颜色，dens 输出不透明度 */
vec3 diskEmission(vec3 hit, vec3 camPos, out float dens) {
  dens = 0.0;
  float rr = length(hit.xz);
  if (rr < RIN || rr > ROUT) return vec3(0.0);

  float phi = atan(hit.z, hit.x);
  // 开普勒剪切：内圈转得快 → 噪声被拉成旋臂
  float omega = 2.6 * pow(max(rr, 0.9) / 6.0, -1.5) * uSpin;
  float ang = phi - omega * uTime * 0.4 + 2.6 * log(max(rr, 0.9) / RIN);

  vec3 q = vec3(cos(ang) * rr, rr * 0.33, sin(ang) * rr);
  float n = fbm3(q * 0.45);
  n = smoothstep(0.20, 0.86, n);

  // 连续谱 + 丝状结构。原来只有噪声，缝隙等于真空，整个盘淡成几缕游丝。
  float filament = smoothstep(0.12, 0.72, n);

  // 「发光」和「光学厚度」必须是两个量，而且径向边界要错开对：
  //   发光 → 先淡出，它决定盘的"视觉边界"
  //   厚度 → 一直保持到更外面，保证淡出的那一段仍然是实的
  //
  // 反过来（厚度先收、发光还在）会得到一圈硬切的椭圆边，像贴纸；
  // 两者用同一条曲线则会得到半透明的纱：
  // 按半径量过，一起归零的版本在 4.6R 透出 1.46 倍、5.4R 处 3.33 倍、6.2R 处 15.7 倍。
  //
  // 现在的形状是：亮 → 逐渐暗下去 → 暗但依然不透明的外缘 → 厚度淡出。
  // 视觉上边界由亮度消失定义，而那里盘还是挡得住背景，所以既不透也没有硬边。
  float radialEmit  = smoothstep(RIN, RIN + 1.0, rr) * (1.0 - smoothstep(ROUT * 0.55, ROUT * 0.92, rr));
  float radialThick = smoothstep(RIN, RIN + 0.8, rr) * (1.0 - smoothstep(ROUT * 0.90, ROUT, rr));

  float emitting = clamp(radialEmit * (0.32 + 0.80 * filament), 0.0, 1.0);
  dens = clamp(radialThick * (0.85 + 0.30 * filament), 0.0, 1.0);
  if (dens < 0.002) return vec3(0.0);

  float t = clamp((rr - RIN) / (ROUT - RIN), 0.0, 1.0);
  vec3 col = mix(vec3(1.00, 0.97, 0.95), vec3(1.00, 0.58, 0.18), smoothstep(0.0, 0.42, t));
  col = mix(col, vec3(0.72, 0.16, 0.05), smoothstep(0.42, 1.0, t));

  // 相对论多普勒增亮：迎向观察者的一侧亮得多
  vec3 vdir = normalize(cross(vec3(0.0, 1.0, 0.0), hit)) * uSpin;
  float beta = min(0.62, 0.52 / sqrt(max(rr, 1.2)));
  vec3 los = normalize(camPos - hit);
  float dop = 1.0 / max(0.18, 1.0 - beta * dot(vdir, los));
  col *= pow(clamp(dop, 0.0, 3.2), 2.0);

  // 引力红移
  col *= clamp(sqrt(max(0.0, 1.0 - 1.0 / max(rr, 1.06))), 0.30, 1.0) * 1.45;

  return col * emitting * uDiskBright;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 dv = frag - uCenter;
  float dist = length(dv);
  float sp0 = dist / uHoleR;
  bool dbg = uDebug > 0.5;
  if (!dbg && sp0 > uLensR) { gl_FragColor = vec4(0.0); return; }

  float cs = cos(uRoll);
  float sn = sin(uRoll);
  vec2 sp = vec2(dv.x * cs - dv.y * sn, dv.x * sn + dv.y * cs) / uHoleR;

  // 相机：位于 (0, camH, camD)，看向原点
  float fov = BCRIT / uCamD;
  vec3 C = vec3(0.0, uCamH, uCamD);
  vec3 fwd = normalize(-C);
  vec3 rgt = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 upv = cross(rgt, fwd);
  vec3 rd = normalize(fwd + (sp.x * fov) * rgt + (sp.y * fov) * upv);

  vec3 pos = C;
  vec3 vel = rd;
  vec3 Lv = cross(pos, vel);
  float h2 = dot(Lv, Lv);

  vec3 accC = vec3(0.0);
  float accA = 0.0;
  bool captured = false;
  int maxSteps = int(uMaxSteps);
  bool jetOn = uJets > 0.01;

  for (int i = 0; i < 256; i++) {
    if (i >= maxSteps) break;
    float r2 = dot(pos, pos);
    float r = sqrt(r2);
    if (r < 1.0) { captured = true; break; }
    if (r > 70.0 && dot(pos, vel) > 0.0) break;

    float dt = clamp(r * 0.09, 0.006, 3.0);
    vec3 prev = pos;

    float r5 = r2 * r2 * r;
    vec3 acc = -1.5 * h2 * pos / r5;
    vel += acc * (0.5 * dt);
    pos += vel * dt;
    r2 = dot(pos, pos);
    r = sqrt(r2);
    r5 = r2 * r2 * r;
    acc = -1.5 * h2 * pos / r5;
    vel += acc * (0.5 * dt);

    // 极向喷流：被吞噬物质的一部分沿自转轴抛出
    if (jetOn) {
      float ay = abs(pos.y);
      if (ay > 1.7) {
        float jr = length(pos.xz);
        float w = 0.30 + 0.065 * ay;
        float je = exp(-(jr * jr) / (w * w)) * exp(-ay * 0.115);
        accC += (1.0 - accA) * (uJets * je * dt * 0.5) * vec3(0.38, 0.62, 1.00);
      }
    }

    // 穿越赤道面 → 吃到吸积盘
    if (prev.y * pos.y < 0.0 && accA < 0.995) {
      float tt = prev.y / (prev.y - pos.y);
      vec3 hit = mix(prev, pos, tt);
      float d;
      vec3 e = diskEmission(hit, C, d);
      if (d > 0.002) {
        float aa = clamp(d * 1.20, 0.0, 1.0);
        accC += (1.0 - accA) * e;
        accA += (1.0 - accA) * aa;
      }
    }
  }

  vec3 bgC = vec3(0.0);
  float bgA = 0.0;

  if (captured) {
    // 事件视界：绝对的黑
    bgC = vec3(0.0);
    bgA = 1.0;
  } else {
    float df = dot(vel, fwd) * fov;
    vec2 spOut = vec2(dot(vel, rgt), dot(vel, upv)) / max(df, 1e-4);
    vec2 dOut = vec2(spOut.x * cs + spOut.y * sn, -spOut.x * sn + spOut.y * cs) * uHoleR;
    vec2 uv = (uCenter + dOut) / uRes;
    uv.y = 1.0 - uv.y;
    if (uBGMode > 0.5) {
      bgC = texture2D(uDesktop, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
      bgA = 1.0;
    } else {
      bgC = vec3(0.055, 0.065, 0.105);
      bgA = 0.85;
    }
  }

  float fade = 1.0 - smoothstep(uLensR * 0.68, uLensR * 0.99, sp0);
  if (!captured) bgA *= fade;
  if (uBGMode < 0.5 && !captured) bgA *= 0.12;   // 没有桌面快照时只留极淡的暗雾

  accC *= (1.0 + uFlash * 1.7);

  vec3 outRGB = accC + (1.0 - accA) * bgA * bgC;
  float outA = accA + (1.0 - accA) * bgA;
  outRGB *= fade;
  outA *= fade;

  // 光子环：视界边缘那一圈细亮线（保证在任何背景下都好看）
  float ring = exp(-pow((sp0 - 1.05) * 8.5, 2.0)) * step(1.0, sp0);
  ring *= uRingGlow * (1.0 + uFlash * 2.5);
  // 光子环也带多普勒不对称：迎向观察者的一侧更亮。
  // 均匀亮环会让视界看起来像一个规规矩矩画上去的圆。
  ring *= 1.0 + 0.65 * clamp(sp.x, -1.0, 1.0);
  outRGB += ring * vec3(1.0, 0.74, 0.44);
  outA = clamp(outA + ring * 0.6, 0.0, 1.0);

  // 调试通道：红点=uCenter 标记，蓝=被视界捕获，绿=吃到吸积盘，灰带=每 1 个阴影半径的等高线
  if (dbg) {
    if (uDebug > 1.5) {
      // 坐标场：R=frag.x/uRes.x, G=frag.y/uRes.y；红点=uCenter，青点=(res.x,res.y)，黄点=原点
      vec3 c = vec3(frag / uRes, 0.15);
      if (dist < 22.0) c = vec3(1.0, 0.0, 0.0);
      if (length(frag - uRes) < 22.0) c = vec3(0.0, 1.0, 1.0);
      if (length(frag) < 22.0) c = vec3(1.0, 1.0, 0.0);
      gl_FragColor = vec4(c, 1.0);
      return;
    }
    if (sp0 > uLensR) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    if (dist < 14.0) { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); return; }
    if (captured) { gl_FragColor = vec4(0.05, 0.45, 1.0, 1.0); return; }
    if (accA > 0.02) { gl_FragColor = vec4(0.10, 1.0, 0.24, 1.0); return; }
    gl_FragColor = vec4(vec3(0.10 + 0.45 * fract(sp0)), 1.0);
    return;
  }

  gl_FragColor = vec4(outRGB, outA);
}
`;

window.BH_SHADERS = { VERT, FRAG };
