'use strict';

/**
 * 2D 叠加层：被吞噬的物质。
 *
 * 尘埃/文件从屏幕边缘或鼠标轨迹上生成，被黑洞的平方反比引力捕获，
 * 先绕着转，再因为"粘滞耗散"损失角动量而螺旋坠入；越靠近越亮、越长
 * （潮汐拉伸 = 意大利面化），越过视界时炸成一片火花。
 */

const TAU = Math.PI * 2;

function rand(a, b) { return a + Math.random() * (b - a); }

const EXT_COLOR = {
  js: '#f7df1e', ts: '#3178c6', jsx: '#61dafb', tsx: '#3178c6',
  py: '#3776ab', rb: '#cc342d', go: '#00add8', rs: '#dea584', java: '#e76f00',
  c: '#555555', cpp: '#00599c', h: '#555555', cs: '#68217a', php: '#777bb4',
  swift: '#fa7343', kt: '#a97bff', sh: '#4eaa25', lua: '#000080', dart: '#00b4ab',
  html: '#e34f26', css: '#1572b6', scss: '#c6538c', vue: '#41b883', svelte: '#ff3e00',
  json: '#cbcb41', yml: '#cb171e', yaml: '#cb171e', toml: '#9c4221', xml: '#8a8a8a',
  md: '#519aba', txt: '#9aa0a6', pdf: '#e5252a', doc: '#2b579a', docx: '#2b579a',
  xls: '#217346', xlsx: '#217346', ppt: '#d24726', pptx: '#d24726',
  png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', gif: '#a074c4', webp: '#a074c4',
  svg: '#ffb13b', mp3: '#1db954', wav: '#1db954', mp4: '#e2523a', mov: '#e2523a',
  zip: '#b8860b', gz: '#b8860b', tar: '#b8860b', dmg: '#7f8c8d', app: '#7f8c8d',
};

function colorForName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return EXT_COLOR[ext] || '#8ab4f8';
}

class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.parts = [];
    this.flashes = [];
    this.maxBase = 200;        // 基准上限，实际用 maxBase × density
    this.density = 0.5;        // 粒子密度倍率，由设置驱动
    this.max = Math.round(this.maxBase * this.density);

    // 爆炸/火光的所有强度常量集中在这里，别散落在绘制代码里当魔数。
    // 调这一组就等于调「吞噬那一下有多炸」。
    this.tuning = {
      sparkSpeed: [26, 130],
      sparkSize: [0.6, 1.5],
      sparkLife: [0.35, 1.0],
      flashAlpha: 0.20,
      flashRadius: 2.2,
      sparkDim: 0.30,     // 火花头部亮度相对尘埃的倍率
      sparkScale: 0.55,   // 火花头部半径相对尘埃的倍率
    };
    this.roll = -0.3;
    this.glow = 0.45;   // 泛光倍率，由设置驱动
    this.onSwallow = null;
    this.hole = { x: 0, y: 0, r: 40 };
    this.k = 1.3e6;             // G·M（像素³/秒²）
    this.enabled = true;
    this.spawnAccum = 0;
  }

  setHole(x, y, r) { this.hole.x = x; this.hole.y = y; this.hole.r = r; }

  setMassScale(s) { this.k = 1.3e6 * s; }

  /** 粒子密度倍率：0 = 完全不生成（连爆炸火花也不放） */
  setDensity(d) {
    this.density = Math.max(0, Number(d) || 0);
    this.max = Math.round(this.maxBase * this.density);

    // 爆炸/火光的所有强度常量集中在这里，别散落在绘制代码里当魔数。
    // 调这一组就等于调「吞噬那一下有多炸」。
    this.tuning = {
      sparkSpeed: [26, 130],
      sparkSize: [0.6, 1.5],
      sparkLife: [0.35, 1.0],
      flashAlpha: 0.20,
      flashRadius: 2.2,
      sparkDim: 0.30,     // 火花头部亮度相对尘埃的倍率
      sparkScale: 0.55,   // 火花头部半径相对尘埃的倍率
    };
    if (this.density <= 0) { this.parts.length = 0; this.flashes.length = 0; }
  }

  get densityScale() { return this.density <= 0 ? 0 : Math.max(0.25, this.density); }

  clear() { this.parts.length = 0; this.flashes.length = 0; }

  _push(p) {
    if (this.parts.length >= this.max) {
      // 优先淘汰普通尘埃，文件粒子永远保留
      let idx = -1;
      for (let i = 0; i < this.parts.length; i++) {
        if (this.parts[i].type !== 'file') { idx = i; break; }
      }
      if (idx < 0) return;
      this.parts.splice(idx, 1);
    }
    this.parts.push(p);
  }

  /** 屏幕边缘飘进来的环境尘埃 */
  spawnAmbient(w, h, count) {
    if (this.density <= 0) return;
    const n = Math.max(1, Math.round((count == null ? 1 : count) * this.densityScale));
    for (let i = 0; i < n; i++) {
      const side = Math.floor(Math.random() * 4);
      let x, y;
      if (side === 0) { x = rand(0, w); y = rand(-40, 10); }
      else if (side === 1) { x = rand(0, w); y = rand(h - 10, h + 40); }
      else if (side === 2) { x = rand(-40, 10); y = rand(0, h); }
      else { x = rand(w - 10, w + 40); y = rand(0, h); }
      const ang = Math.atan2(this.hole.y - y, this.hole.x - x) + rand(-0.9, 0.9);
      const sp = rand(10, 45);
      this._push({
        type: 'dust', x, y,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        size: rand(0.7, 2.4), seed: Math.random() * 1000,
        trail: [], life: 0, max: rand(9, 20),
      });
    }
  }

  /** 鼠标划过时掉落的碎屑（桌面宠物会"吃"你的鼠标轨迹） */
  spawnCursorDust(x, y, vx, vy, n) {
    if (this.density <= 0) return;
    for (let i = 0; i < Math.max(1, Math.round((n || 1) * this.densityScale)); i++) {
      this._push({
        type: 'dust',
        x: x + rand(-3, 3), y: y + rand(-3, 3),
        vx: vx * rand(0.1, 0.4) + rand(-18, 18),
        vy: vy * rand(0.1, 0.4) + rand(-18, 18),
        size: rand(0.8, 2.6), seed: Math.random() * 1000,
        trail: [], life: 0, max: rand(8, 18),
      });
    }
  }

  /** 一个被投喂的文件 */
  spawnFile(path, name, size, screenW, screenH) {
    // 从屏幕外/边缘飞入
    const side = Math.floor(Math.random() * 4);
    let x, y;
    if (side === 0) { x = rand(screenW * 0.2, screenW * 0.8); y = -30; }
    else if (side === 1) { x = rand(screenW * 0.2, screenW * 0.8); y = screenH + 30; }
    else if (side === 2) { x = -30; y = rand(screenH * 0.2, screenH * 0.8); }
    else { x = screenW + 30; y = rand(screenH * 0.2, screenH * 0.8); }
    const ang = Math.atan2(this.hole.y - y, this.hole.x - x) + rand(-0.5, 0.5);
    const sp = rand(30, 70);
    this._push({
      type: 'file', path, name, fsize: size,
      color: colorForName(name),
      x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      size: 3.2, trail: [], life: 0, max: 60, spin: rand(-1, 1),
      angle: rand(-0.4, 0.4),
    });
  }

  burst(x, y, n, power) {
    if (this.density <= 0) return;
    // 火花不计入 _push 的上限，必须自己按密度砍，否则一次投喂就能糊满屏
    const t = this.tuning;
    const count = Math.max(2, Math.round(n * this.densityScale));
    for (let i = 0; i < count; i++) {
      const a = rand(0, TAU);
      const sp = rand(t.sparkSpeed[0], t.sparkSpeed[1]) * (power || 1);
      this.parts.push({
        type: 'spark', x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        size: rand(t.sparkSize[0], t.sparkSize[1]), seed: Math.random() * 1000,
        trail: [], life: 0, max: rand(t.sparkLife[0], t.sparkLife[1]), decay: true,
      });
    }
    this.flashes.push({ x, y, t: 0, max: rand(0.4, 0.7), power: power || 1 });
  }

  update(dt, w, h) {
    if (!this.enabled) return;
    const hx = this.hole.x, hy = this.hole.y, hr = this.hole.r;
    const k = this.k;
    const drag = 0.42;

    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life += dt;

      const dx = hx - p.x, dy = hy - p.y;
      const r2 = dx * dx + dy * dy;
      const r = Math.sqrt(r2) || 1e-3;

      if (p.decay) {
        // 火花：只受阻尼
        const d = Math.exp(-2.6 * dt);
        p.vx *= d; p.vy *= d;
      } else {
        // 引力 + 粘滞耗散（损失切向速度 → 螺旋内落）
        const a = k / Math.max(r2, 1);
        p.vx += (dx / r) * a * dt;
        p.vy += (dy / r) * a * dt;
        const ux = dx / r, uy = dy / r;
        const vr = p.vx * ux + p.vy * uy;
        let tx = p.vx - ux * vr, ty = p.vy - uy * vr;
        const decay = Math.exp(-drag * dt * (1 + 260 / Math.max(r, 60)));
        tx *= decay; ty *= decay;
        p.vx = ux * vr + tx;
        p.vy = uy * vr + ty;
      }

      p.trail.push(p.x, p.y);
      if (p.trail.length > 16) p.trail.splice(0, 2);

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const dead = p.life > p.max;
      const swallowed = !p.decay && r < hr * 1.02;

      if (swallowed || dead) {
        if (swallowed) {
          this.burst(p.x, p.y, p.type === 'file' ? 11 : 4, p.type === 'file' ? 1.0 : 0.7);
          if (this.onSwallow) this.onSwallow(p);
        }
        this.parts.splice(i, 1);
      }
    }

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      if (f.t > f.max) this.flashes.splice(i, 1);
    }
  }

  /** 把一个点压进吸积盘平面（与着色器里的 roll / 倾角保持一致） */
  _squash(dx, dy, r) {
    const cs = Math.cos(this.roll), sn = Math.sin(this.roll);
    const lx = dx * cs - dy * sn;
    let ly = dx * sn + dy * cs;
    const near = Math.max(0, Math.min(1, 1 - r / (this.hole.r * 16)));
    ly *= 1 - 0.62 * near * near;
    return [lx * cs + ly * sn, -lx * sn + ly * cs];
  }

  draw(time) {
    const ctx = this.ctx;
    const w = this.canvas.width / (this.pixelRatio || 1);
    const h = this.canvas.height / (this.pixelRatio || 1);
    const hx = this.hole.x, hy = this.hole.y, hr = this.hole.r;

    ctx.setTransform(this.pixelRatio || 1, 0, 0, this.pixelRatio || 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.enabled) return;

    ctx.globalCompositeOperation = 'lighter';

    // —— 黑洞外泛光（伪 bloom）——
    // 从视界外侧才开始，别把纯黑的阴影糊成褐色
    const glow = this.glow == null ? 0.45 : this.glow;
    if (glow > 0.001) {
      const pulse = 1 + 0.06 * Math.sin(time * 1.7);
      const glowR = hr * 5.2 * pulse;
      const k = glow * 0.42;          // 基准值再乘一个系数，整体先降一半
      const g = ctx.createRadialGradient(hx, hy, hr * 1.25, hx, hy, glowR);
      g.addColorStop(0.00, `rgba(255,170,86,${(0.16 * k).toFixed(4)})`);
      g.addColorStop(0.12, `rgba(255,126,48,${(0.085 * k).toFixed(4)})`);
      g.addColorStop(0.34, `rgba(255,92,36,${(0.032 * k).toFixed(4)})`);
      g.addColorStop(0.64, `rgba(88,58,160,${(0.016 * k).toFixed(4)})`);
      g.addColorStop(1.00, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(hx, hy, glowR, 0, TAU);
      ctx.fill();
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // —— 物质 ——
    for (const p of this.parts) {
      const dx = p.x - hx, dy = p.y - hy;
      const r = Math.hypot(dx, dy);
      const closeness = Math.max(0, Math.min(1, 1 - (r - hr) / (hr * 13)));
      const heat = closeness * closeness;

      // 颜色：冷灰蓝 → 金 → 白热
      const hue = 215 - 195 * heat;
      const sat = 55 + 40 * heat;
      const lum = (p.type === 'file' ? 62 : 46) + 40 * heat;

      const [sx, sy] = this._squash(dx, dy, r);
      const px = hx + sx, py = hy + sy;

      // 潮汐拉伸：越近越长
      const stretch = 1 + heat * 7;
      const tx = p.trail;
      if (tx.length >= 6) {
        ctx.beginPath();
        const steps = Math.min(7, tx.length / 2);
        for (let i = 0; i < steps; i++) {
          const t = i / (steps - 1 || 1);
          const o = tx.length - 2 * (steps - i);
          if (o < 0) continue;
          const qx = tx[o] - hx, qy = tx[o + 1] - hy;
          const [ax, ay] = this._squash(qx, qy, Math.hypot(qx, qy));
          const bx = hx + ax, by = hy + ay;
          if (i === 0) ctx.moveTo(bx, by);
          else ctx.lineTo(bx, by);
        }
        ctx.lineTo(px, py);
        ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${lum}%, ${0.16 + 0.35 * heat})`;
        ctx.lineWidth = Math.max(0.5, p.size * (0.5 + 0.7 * heat));
        ctx.stroke();
      }

      // 爆炸火花是几十个叠在一起的，单个必须又小又暗，否则中心一片死白
      const spark = p.type === 'spark';
      const rad = Math.max(1.2, p.size * (1 + stretch * 0.22)) * (spark ? this.tuning.sparkScale : 1);
      const headA = (0.55 + 0.4 * heat) * (spark ? this.tuning.sparkDim : 1);
      const pg = ctx.createRadialGradient(px, py, 0, px, py, rad * 3.2);
      pg.addColorStop(0, `hsla(${hue}, ${sat}%, ${Math.min(96, lum + 26)}%, ${headA})`);
      pg.addColorStop(0.35, `hsla(${hue}, ${sat}%, ${lum}%, ${headA * 0.4})`);
      pg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(px, py, rad * 3.2, 0, TAU);
      ctx.fill();

      // 文件：画出来，看得见你在喂什么
      if (p.type === 'file') {
        const ang = Math.atan2(dy, dx);
        const pull = 1 + heat * 2.4;
        const bw = 54 / pull, bh = 34 / pull;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang * 0.15 + (p.angle || 0) * (1 - heat));
        ctx.globalAlpha = 0.55 + 0.45 * (1 - heat);
        ctx.fillStyle = 'rgba(12,10,20,0.72)';
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.4;
        const rr = Math.min(6, bh / 2);
        ctx.beginPath();
        ctx.roundRect(-bw / 2, -bh / 2, bw, bh, rr);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = p.color;
        ctx.fillRect(-bw / 2 + 5, -bh / 2 + 5, 3, bh - 10);
        ctx.fillStyle = 'rgba(240,244,255,0.94)';
        ctx.font = '600 9px -apple-system, "PingFang SC", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        let nm = p.name || '';
        if (nm.length > 13) nm = nm.slice(0, 6) + '…' + nm.slice(-5);
        ctx.fillText(nm, -bw / 2 + 12, 0);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }

    // —— 吞噬闪光 ——
    for (const f of this.flashes) {
      const t = f.t / f.max;
      const rad = hr * (0.9 + this.tuning.flashRadius * t) * (1 + f.power * 0.25);
      const a = (1 - t) * (1 - t) * this.tuning.flashAlpha * Math.min(f.power, 1.2);
      const fg = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, rad);
      fg.addColorStop(0, `rgba(255,238,208,${a})`);
      fg.addColorStop(0.35, `rgba(255,164,78,${a * 0.5})`);
      fg.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(f.x, f.y, rad, 0, TAU);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  resize(cssW, cssH, ratio) {
    this.pixelRatio = ratio;
    this.canvas.width = Math.round(cssW * ratio);
    this.canvas.height = Math.round(cssH * ratio);
    this.cssW = cssW;
    this.cssH = cssH;
  }
}

window.Overlay = Overlay;
