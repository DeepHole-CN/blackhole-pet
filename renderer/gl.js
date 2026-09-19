'use strict';

/** 黑洞的 WebGL 渲染器：一个全屏三角形 + 一个重量级片元着色器。 */
class BlackHoleGL {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.maxSteps = 160;
    this.renderScale = 0.75;
    this.frameMs = 16;
    this._warmup = 90;
    this._slow = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._texDirty = false;
    this._texSrc = null;

    const opts = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    };
    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) { console.error('[pet] WebGL 不可用'); return; }
    this.gl = gl;

    if (!this._build()) return;

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    this._makeTexture();
    this.ok = true;
  }

  _shader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('[pet] shader 编译失败:\n' + gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  _build() {
    const gl = this.gl;
    const vs = this._shader(gl.VERTEX_SHADER, window.BH_SHADERS.VERT);
    const fs = this._shader(gl.FRAGMENT_SHADER, window.BH_SHADERS.FRAG);
    if (!vs || !fs) return false;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[pet] program 链接失败:\n' + gl.getProgramInfoLog(prog));
      return false;
    }
    this.prog = prog;
    gl.useProgram(prog);

    const names = ['uRes', 'uCenter', 'uHoleR', 'uTime', 'uCamD', 'uCamH', 'uRoll',
      'uLensR', 'uMaxSteps', 'uBGMode', 'uDiskBright', 'uJets', 'uFlash',
      'uSpin', 'uRingGlow', 'uDebug', 'uDesktop'];
    this.u = {};
    for (const n of names) this.u[n] = gl.getUniformLocation(prog, n);
    return true;
  }

  _makeTexture() {
    const gl = this.gl;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.hasTex = false;
  }

  /** 接收主进程传来的桌面快照（HTMLImageElement） */
  setDesktop(img) {
    if (!this.ok || !img) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.hasTex = true;
  }

  clearDesktop() { this.hasTex = false; }

  /**
   * @param {object} p
   *   centerX/centerY  黑洞中心（CSS 像素）
   *   holeR            阴影半径（CSS 像素）
   *   time             秒
   *   lensRadius       透镜区域半径（单位：holeR）
   *   inclination      相机仰角（弧度）
   *   roll             画面内旋转（弧度）
   *   diskBright/jets/flash/ringGlow
   */
  render(p) {
    if (!this.ok) return;
    const gl = this.gl;
    const cvs = this.canvas;
    const w = Math.max(1, cvs.width);
    const h = Math.max(1, cvs.height);

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);

    const dpr = this.pixelRatio || 1;
    const camD = 30.0;
    const camH = camD * Math.tan(Math.max(0.02, Math.min(1.2, p.inclination)));

    this.lastUniforms = {
      res: [w, h], canvas: [cvs.width, cvs.height],
      center: [p.centerX * dpr, h - p.centerY * dpr],
      centerCSS: [p.centerX, p.centerY],
      holeR: Math.max(6, p.holeR * dpr), pixelRatio: dpr, lensR: p.lensRadius,
      maxSteps: this.maxSteps, hasTex: this.hasTex,
    };

    gl.uniform2f(this.u.uRes, w, h);
    gl.uniform2f(this.u.uCenter, p.centerX * dpr, h - p.centerY * dpr);
    gl.uniform1f(this.u.uHoleR, Math.max(6, p.holeR * dpr));
    gl.uniform1f(this.u.uTime, p.time);
    gl.uniform1f(this.u.uCamD, camD);
    gl.uniform1f(this.u.uCamH, camH);
    gl.uniform1f(this.u.uRoll, p.roll);
    gl.uniform1f(this.u.uLensR, p.lensRadius);
    gl.uniform1f(this.u.uMaxSteps, this.maxSteps);
    gl.uniform1f(this.u.uBGMode, this.hasTex ? 1.0 : 0.0);
    gl.uniform1f(this.u.uDiskBright, p.diskBright);
    gl.uniform1f(this.u.uJets, p.jets);
    gl.uniform1f(this.u.uFlash, p.flash);
    gl.uniform1f(this.u.uSpin, 1.0);
    gl.uniform1f(this.u.uRingGlow, p.ringGlow);
    gl.uniform1f(this.u.uDebug, p.debug || 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.uDesktop, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 诊断：整块读回并统计（比逐点 readPixels 快得多，也不容易卡管线）
    if (this._probeRegion) {
      const r = this._probeRegion;
      this._probeRegion = null;
      const n = r.w * r.h;
      const buf = new Uint8Array(n * 4);
      gl.readPixels(r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let sum = 0, max = 0, lit = 0;
      for (let i = 0; i < buf.length; i += 4) {
        // 输出是前乘 alpha 的，所以这里的 RGB 已经等于"看起来有多亮"
        const lum = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
        sum += lum;
        if (lum > max) max = lum;
        if (lum > 6) lit++;
      }
      this.probeRegionResult = {
        w: r.w, h: r.h,
        meanLum: +(sum / n).toFixed(2),
        maxLum: max,
        litRatio: +(lit / n).toFixed(4),
      };
    }

    // 诊断：在同一帧内直接读回帧缓冲像素（坐标同 gl_FragCoord，原点在左下）
    if (this._probe) {
      const pts = this._probe;
      this._probe = null;
      this.probeResult = pts.map(([x, y]) => {
        const px = new Uint8Array(4);
        gl.readPixels(Math.round(x), Math.round(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return { x, y, rgba: Array.from(px) };
      });
    }

    // 诊断：把 GPU 上真实生效的 uniform 值读回来
    const g = (loc) => {
      if (loc == null) return 'NULL-LOCATION';
      const v = gl.getUniform(this.prog, loc);
      return (v && v.length !== undefined) ? Array.from(v) : v;
    };
    this.gpuUniforms = {
      uRes: g(this.u.uRes), uCenter: g(this.u.uCenter), uHoleR: g(this.u.uHoleR),
      uLensR: g(this.u.uLensR), uMaxSteps: g(this.u.uMaxSteps), uDebug: g(this.u.uDebug),
      nulls: Object.keys(this.u).filter((k) => this.u[k] == null),
      glError: gl.getError(),
    };
  }

  /** 尺寸变化时重算后备缓冲区；renderScale 越小越省电 */
  resize(cssW, cssH, scale) {
    if (scale != null) this.renderScale = scale;
    const ratio = Math.max(0.5, Math.min(2.0, this.dpr * this.renderScale));
    this.pixelRatio = ratio;
    const w = Math.round(cssW * ratio);
    const h = Math.round(cssH * ratio);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.cssW = cssW;
    this.cssH = cssH;
  }

  /** 自动画质：按帧耗时在 0.45 ~ 1.0 之间调节分辨率 */
  autoTune(ms, target) {
    // 开场几秒有着色器编译 / 纹理上传的抖动，别让它把画质永久压下去
    if (this._warmup > 0) { this._warmup--; return; }
    this.frameMs = this.frameMs * 0.85 + ms * 0.15;
    const t = target || 22;
    if (this.frameMs > t * 1.5 && this.renderScale > 0.5) {
      this._slow = (this._slow || 0) + 1;
      if (this._slow < 4) return;
      this.renderScale = Math.max(0.45, this.renderScale - 0.07);
      this.maxSteps = Math.max(90, this.maxSteps - 10);
      this._needResize = true;
      this._slow = 0;
    } else if (this.frameMs < t * 0.7 && this.renderScale < 1.0) {
      this._slow = 0;
      this.renderScale = Math.min(1.0, this.renderScale + 0.05);
      this.maxSteps = Math.min(200, this.maxSteps + 8);
      this._needResize = true;
    } else {
      this._slow = 0;
    }
  }
}

window.BlackHoleGL = BlackHoleGL;
