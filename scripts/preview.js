'use strict';

/**
 * 离屏预览：把黑洞渲染几帧后截一张 PNG，用来肉眼检查着色器效果。
 *   npx electron scripts/preview.js
 *   PET_PREVIEW_OUT=xx.png PET_PREVIEW_SIZE=900 npx electron scripts/preview.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.PET_PREVIEW_OUT || path.join(ROOT, 'preview.png');
const SIZE = Number(process.env.PET_PREVIEW_SIZE || 900);
const WIDTH = Number(process.env.PET_PREVIEW_W || SIZE);
const HEIGHT = Number(process.env.PET_PREVIEW_H || SIZE);
const SETTLE = Number(process.env.PET_PREVIEW_SETTLE || 2200);
const HUD = process.env.PET_PREVIEW_HUD || '0';

app.commandLine.appendSwitch('enable-gpu-rasterization');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // 几乎看不见，但仍是正常的 GPU 合成路径
  win.setOpacity(0.03);
  win.setIgnoreMouseEvents(true);

  // 渲染层的报错必须被看见：之前正是这里静默吞掉了一个每帧抛出的 TypeError，
  // 结果 2D 叠加层整块空白，光看截图还以为只是"泛光调暗了"。
  const rendererErrors = [];
  win.webContents.on('console-message', (e) => {
    const level = (e && e.level !== undefined) ? e.level : 'info';
    const message = (e && e.message) || '';
    const source = (e && e.sourceId) || '';
    const line = (e && e.lineNumber) || 0;
    const isError = level === 'error' || level === 3;
    const tag = isError ? 'error' : level;
    console.log(`[renderer:${tag}] ${message}${source ? ` (${path.basename(source)}:${line})` : ''}`);
    if (isError && !/Security Warning/.test(message)) {
      rendererErrors.push(`${message} (${path.basename(source)}:${line})`);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('[preview] 渲染进程挂了', d);
    app.exit(1);
  });

  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'), {
    query: { preview: '1', hud: HUD },
  });

  const info = await win.webContents.executeJavaScript(`(() => {
    try {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl');
      if (!g) return 'no-webgl';
      const d = g.getExtension('WEBGL_debug_renderer_info');
      const r = d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
      const u = d ? g.getParameter(d.UNMASKED_VENDOR_WEBGL) : '';
      return r + ' | ' + u;
    } catch (e) { return 'err:' + e.message; }
  })()`);
  console.log('[preview] GPU:', info);

  const ready = await win.webContents.executeJavaScript(`new Promise((res) => {
    const t0 = Date.now();
    (function poll() {
      if (window.__previewReady) return res('ok');
      if (Date.now() - t0 > 20000) return res('timeout');
      setTimeout(poll, 100);
    })();
  })`);
  console.log('[preview] ready:', ready);

  // 冻结黑洞位置：否则自由漂浮会让"截图"和"取状态"落在不同帧上，裁剪和探针全对不上
  await win.webContents.executeJavaScript(`(() => {
    const p = window.__pet;
    if (p && p.S) {
      p.S.settings.follow = 'fixed';
      p.S.hole.x = window.innerWidth / 2;
      p.S.hole.y = window.innerHeight / 2;
      p.S.hole.vx = 0; p.S.hole.vy = 0;
      p.S.cursor.seen = false;
      p.overlay.clear();
    }
  })()`);
  await new Promise((r) => setTimeout(r, 1200));

  const glOk = await win.webContents.executeJavaScript(
    'document.getElementById("gl").width + "x" + document.getElementById("gl").height');
  console.log('[preview] canvas:', glOk);

  await new Promise((r) => setTimeout(r, 3200));
  // 截图时保持"活跃"，走满 60fps 分支
  await win.webContents.executeJavaScript('window.__pet.S.lastActivity = performance.now()');
  await new Promise((r) => setTimeout(r, 250));

  const img = await win.webContents.capturePage();
  const size = img.getSize();
  if (!size.width || !size.height) {
    console.error('[preview] 截图失败：空图像');
    app.exit(2);
    return;
  }
  fs.writeFileSync(OUT, img.toPNG());
  console.log(`[preview] 已保存 ${OUT} (${size.width}×${size.height}, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);

  // 黑洞特写：从截图里裁一块放大，方便肉眼确认视界/吸光光环/吸积盘
  const dbg = await win.webContents.executeJavaScript('window.__petdbg ? window.__petdbg() : null');
  if (dbg) {
    console.log('[preview] 状态:', JSON.stringify(dbg));
    const k = size.width / dbg.cssW;
    const cx = Math.round(dbg.hole.x * k);
    const cy = Math.round(dbg.hole.y * k);
    const half = Math.round(Math.max(120, dbg.holeR * k * 5.5));
    const rect = {
      x: Math.max(0, Math.min(size.width - 2, cx - half)),
      y: Math.max(0, Math.min(size.height - 2, cy - half)),
      width: Math.min(half * 2, size.width),
      height: Math.min(half * 2, size.height),
    };
    rect.width = Math.min(rect.width, size.width - rect.x);
    rect.height = Math.min(rect.height, size.height - rect.y);
    try {
      const crop = img.crop(rect).resize({ width: 720, quality: 'best' });
      const holeOut = OUT.replace(/\.png$/, '-hole.png');
      fs.writeFileSync(holeOut, crop.toPNG());
      console.log(`[preview] 特写已保存 ${holeOut}  裁剪区域 ${JSON.stringify(rect)}`);
    } catch (e) {
      console.error('[preview] 特写失败', e.message);
    }

    // 可选：抓一帧「刚吞噬完」的样子，用来目视确认爆炸不过曝
    if (process.env.PET_PREVIEW_FEED) {
      await win.webContents.executeJavaScript(`(() => {
        const p = window.__pet, S = p.S;
        p.overlay.parts.length = 0;
        p.overlay.flashes.length = 0;
        p.overlay.burst(S.hole.x, S.hole.y, 11, 1.0);
        S.flash = 0.30;
      })()`);
      await new Promise((r) => setTimeout(r, 90));
      const bimg = await win.webContents.capturePage();
      const bOut = OUT.replace(/\.png$/, '-burst.png');
      fs.writeFileSync(bOut, bimg.toPNG());
      try {
        fs.writeFileSync(bOut.replace(/\.png$/, '-hole.png'),
          bimg.crop(rect).resize({ width: 720, quality: 'best' }).toPNG());
      } catch { /* ignore */ }
      console.log(`[preview] 爆炸帧已保存 ${bOut}`);
    }

    // 调试通道：红=被视界捕获，绿=吸积盘，条纹=每 1 个阴影半径的等高线
    await win.webContents.executeJavaScript(`(() => {
      window.__petDebug = 1;
      if (window.__pet && window.__pet.overlay) window.__pet.overlay.enabled = false;
      document.body.style.background = '#0a0a0a';
    })()`);
    await new Promise((r) => setTimeout(r, 450));
    const dimg = await win.webContents.capturePage();
    const dOut = OUT.replace(/\.png$/, '-debug.png');
    fs.writeFileSync(dOut, dimg.toPNG());
    try {
      fs.writeFileSync(dOut.replace(/\.png$/, '-hole.png'),
        dimg.crop(rect).resize({ width: 720, quality: 'best' }).toPNG());
    } catch { /* ignore */ }
    console.log(`[preview] 调试图已保存 ${dOut}`);
    await win.webContents.executeJavaScript('window.__petDebug = 2');
    await new Promise((r) => setTimeout(r, 400));
    const cimg = await win.webContents.capturePage();
    fs.writeFileSync(OUT.replace(/\.png$/, '-coords.png'), cimg.toPNG());
    console.log('[preview] 坐标场图已保存');

    // 数值探针：直接读回帧缓冲
    await win.webContents.executeJavaScript(`(() => {
      const p = window.__pet;
      p.gl._probe = [[1303,777],[0,0],[1799,1799],[900,900],[1303,0],[650,1770]];
    })()`);
    await new Promise((r) => setTimeout(r, 350));
    const probe = await win.webContents.executeJavaScript(
      'JSON.stringify(window.__pet.gl.probeResult)');
    console.log('[preview] 探针(debug=2):', probe);

    // 正常模式下沿半径采样，看视界/吸积盘到底有没有画出来
    await win.webContents.executeJavaScript(`(() => {
      window.__petDebug = 0;
      const p = window.__pet.gl;
      const c = p.lastUniforms.center;
      p._probe = [0, 10, 30, 60, 84, 110, 150, 220, 320, 500, 700, 1000]
        .map((d) => [c[0] + d, c[1]]);
    })()`);
    await new Promise((r) => setTimeout(r, 350));
    const probe2 = await win.webContents.executeJavaScript(
      'JSON.stringify(window.__pet.gl.probeResult)');
    console.log('[preview] 探针(正常, 沿+x):', probe2);

    // 调试通道会关掉叠加层、换成纯色背景 —— 必须还原，否则后面的自检全测在空画布上
    await win.webContents.executeJavaScript(`(() => {
      window.__petDebug = 0;
      if (window.__pet && window.__pet.overlay) window.__pet.overlay.enabled = true;
      document.body.style.background = '';
    })()`);
    await new Promise((r) => setTimeout(r, 200));
  }

  // 顺手统计一下帧率，确认性能是否可接受
  const fps = await win.webContents.executeJavaScript(`new Promise((res) => {
    let n = 0; const t0 = performance.now();
    (function tick(){ n++; if (performance.now() - t0 > 1500) return res(Math.round(n / ((performance.now()-t0)/1000))); requestAnimationFrame(tick); })();
  })`);
  console.log('[preview] ~fps:', fps);

  if (process.env.PET_PREVIEW_CHECK) {
    const evalWithTimeout = (code, ms) => Promise.race([
      win.webContents.executeJavaScript(code),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`自检超时（${ms}ms）`)), ms)),
    ]);
    const checks = await evalWithTimeout(`(async () => {
      const p = window.__pet, S = p.S;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__petFreezeCursor = true;
      const out = {};
      const place = (k) => { S.cursor.x = S.hole.x + S.hole.r * k; S.cursor.y = S.hole.y; };
      const ctx = p.overlay.ctx;
      const ratio = p.overlay.pixelRatio || 1;

      S.settings.follow = 'fixed';
      S.settings.interactive = true;
      S.settings.size = 'small';
      S.sizeBias = 1;
      S.cursor.seen = true;
      await sleep(400);

      const R = S.hole.r;
      out.holeR = +R.toFixed(1);
      out.sizeBias = S.sizeBias;
      out.glow = S.settings.glow;
      out.diskDiameterApprox = +(R * 2 * 5.8).toFixed(0);

      // --- 热区：入口 1.0R，出口 1.25R（迟滞） ---
      place(1.6); await sleep(250);
      out['1.6R_interactive'] = S.interactive;          // 期望 false
      place(1.2); await sleep(250);
      out['1.2R_interactive'] = S.interactive;          // 期望 false（在入口之外）
      place(0.9); await sleep(20);
      out['0.9R_immediately'] = S.interactive;          // 期望 false（驻留还没到）
      await sleep(250);
      out['0.9R_afterDwell'] = S.interactive;           // 期望 true
      place(1.2); await sleep(250);
      out['1.2R_whileInside_hysteresis'] = S.interactive; // 期望 true（还没越过 1.25R）
      place(1.5); await sleep(250);
      out['1.5R_afterLeaving'] = S.interactive;         // 期望 false

      // --- 鼠标穿透开关 ---
      S.settings.interactive = false;
      place(0.5); await sleep(250);
      out['disabled_never_takes_mouse'] = S.interactive; // 期望 false
      S.settings.interactive = true; await sleep(250);

      // --- 滚轮：裸滚轮不能改尺寸，⌥+滚轮才行 ---
      const before = S.sizeBias;
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
      await sleep(80);
      out.plainWheelKeepsSize = (S.sizeBias === before);
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, altKey: true, bubbles: true, cancelable: true }));
      await sleep(80);
      out.altWheelChangesSize = (S.sizeBias !== before);
      S.sizeBias = 1;

      // --- 吞噬爆炸：新旧参数对比（绘制代码是同一份，所以这里只体现参数差异）---
      const region = (k) => {
        const r = Math.round(R * k * ratio);
        const cx = Math.round(S.hole.x * ratio), cy = Math.round(S.hole.y * ratio);
        const img = ctx.getImageData(cx - r, cy - r, r * 2, r * 2).data;
        let maxA = 0, sum = 0;
        for (let i = 0; i < img.length; i += 4) {
          maxA = Math.max(maxA, img[i + 3]);
          sum += (img[i + 3] / 255) * (0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2]);
        }
        return { peakAlpha: maxA, addedLight: Math.round(sum) };
      };
      const NEW_TUNE = JSON.parse(JSON.stringify(p.overlay.tuning));
      const OLD_TUNE = {
        sparkSpeed: [40, 260], sparkSize: [0.8, 2.6], sparkLife: [0.4, 1.4],
        flashAlpha: 0.50, flashRadius: 3.4, sparkDim: 1.00, sparkScale: 1.00,
      };
      const measureBurst = async (tune, n, power, flash) => {
        Object.assign(p.overlay.tuning, tune);
        p.overlay.parts.length = 0;
        p.overlay.flashes.length = 0;
        S.flash = 0;
        await sleep(60);
        p.overlay.burst(S.hole.x, S.hole.y, n, power);
        S.flash = flash;
        await sleep(70);
        const m = region(6);
        return { peakAlpha: m.peakAlpha, addedLight: m.addedLight, sparks: p.overlay.parts.length };
      };
      out.burst = {
        '旧(34颗,1.5倍,闪光0.75)': await measureBurst(OLD_TUNE, 34, 1.5, 0.75),
        '新(11颗,1.0倍,闪光0.30)': await measureBurst(NEW_TUNE, 11, 1.0, 0.30),
      };
      Object.assign(p.overlay.tuning, NEW_TUNE);
      p.overlay.parts.length = 0;
      p.overlay.flashes.length = 0;
      S.flash = 0;
      await sleep(80);

      // --- 自由漂浮的实际速度（关掉好奇心，只测纯漂移）---
      window.__petFreezeCursor = true;
      S.settings.follow = 'free';
      S.settings.driftSpeed = 1;
      S.settings.diskBright = 1.35;
      S.cursor.seen = false;
      S.hole.x = window.innerWidth / 2;
      S.hole.y = window.innerHeight / 2;
      S.hole.vx = 0; S.hole.vy = 0;
      await sleep(200);
      {
        const speeds = [];
        let last = performance.now(), px = S.hole.x, py = S.hole.y;
        await new Promise((res) => {
          const iv = setInterval(() => {
            const now = performance.now();
            const dt = Math.max(0.001, (now - last) / 1000);
            last = now;
            speeds.push(Math.hypot(S.hole.x - px, S.hole.y - py) / dt);
            px = S.hole.x; py = S.hole.y;
            if (speeds.length >= 60) { clearInterval(iv); res(); }
          }, 100);
        });
        const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
        out.freeSpeedPxPerSec = { avg: +avg.toFixed(1), max: +Math.max(...speeds).toFixed(1) };
      }
      S.settings.follow = 'fixed';
      S.hole.x = window.innerWidth / 2; S.hole.y = window.innerHeight / 2;
      await sleep(300);

      // --- 吸积盘 ---
      const glc0 = p.gl;
      const bgUrl = window.__petBgUrl
        || (document.body.style.background.match(/url\("?([^")]+)"?\)/) || [])[1];
      const setBg = async (on) => {
        if (on) {
          if (!bgUrl) return;
          const im = new Image();
          im.onload = () => p.gl.setDesktop(im);
          im.src = bgUrl;
        } else {
          p.gl.clearDesktop();
        }
        await sleep(320);
      };
      const probeBox = async (radiusInR) => {
        const c = p.gl.lastUniforms.center;
        const pr = p.gl.pixelRatio || 1;
        const half = Math.round(S.hole.r * pr * radiusInR);
        p.gl._probeRegion = {
          x: Math.max(0, Math.round(c[0] - half)),
          y: Math.max(0, Math.round(c[1] - half)),
          w: half * 2, h: half * 2,
        };
        await sleep(180);
        return p.gl.probeRegionResult;
      };
      const diskStat = async (bright, withBg) => {
        S.settings.diskBright = bright;
        await setBg(withBg);
        return probeBox(6.5);
      };

      // 盘本身有多亮（关掉桌面纹理，隔离出来）
      out.disk = {
        '弱0.7': await diskStat(0.7, false),
        '中1.35(默认)': await diskStat(1.35, false),
        '强2.0': await diskStat(2.0, false),
        '极强2.8': await diskStat(2.8, false),
      };

      // 盘有多"透"：在盘面上取小方块，开/关桌面纹理各测一次。
      // 必须沿着盘的长轴取点 —— 拿一个大方框去量，大部分像素其实在盘外面。
      const probeAtCss = async (cssX, cssY, half) => {
        const pr = p.gl.pixelRatio || 1;
        const H = p.gl.canvas.height;
        const x = Math.round(cssX * pr);
        const y = Math.round(H - cssY * pr);      // 帧缓冲原点在左下
        p.gl._probeRegion = {
          x: Math.max(0, x - half), y: Math.max(0, y - half), w: half * 2, h: half * 2,
        };
        await sleep(170);
        return p.gl.probeRegionResult;
      };
      const diskPoints = () => {
        const roll = S.settings.roll;
        const ux = Math.cos(roll), uy = Math.sin(roll);   // CSS 坐标下的长轴方向
        const R = S.hole.r;
        const pts = [];
        for (const k of [2.6, 3.6, 4.6]) {
          pts.push([S.hole.x + ux * R * k, S.hole.y + uy * R * k]);
          pts.push([S.hole.x - ux * R * k, S.hole.y - uy * R * k]);
        }
        return pts;
      };
      // 按半径分开量：平均值会把"外圈透明"这种分布问题盖掉
      const diskPerK = async () => {
        const roll = S.settings.roll;
        const ux = Math.cos(roll), uy = Math.sin(roll);
        const R = S.hole.r;
        const acc = {};
        for (const k of [1.6, 2.4, 3.2, 4.0, 4.6]) {
          let sum = 0;
          for (const sgn of [1, -1]) {
            sum += (await probeAtCss(
              S.hole.x + sgn * ux * R * k, S.hole.y + sgn * uy * R * k, 8)).meanLum;
          }
          acc[k + 'R'] = +(sum / 2).toFixed(1);
        }
        return acc;
      };
      S.settings.diskBright = 1.35;
      await setBg(false);
      const diskNoBg = await diskPerK();
      await setBg(true);
      const diskWithBg = await diskPerK();
      out.diskOpacityByRadius = {};
      for (const k of Object.keys(diskNoBg)) {
        out.diskOpacityByRadius[k] = {
          盘面: diskNoBg[k],
          背景: diskWithBg[k],
          透出比例: +(diskWithBg[k] / Math.max(0.01, diskNoBg[k])).toFixed(2),
        };
      }

      // 视界还是不是一个"完美的圆"：看阴影内部有多少像素被前景盘点亮
      S.settings.diskBright = 1.35;
      await setBg(true);
      await sleep(300);
      const shadow = await probeBox(0.92);
      out.shadowCover = {
        阴影内部被点亮的像素比例: shadow.litRatio,
        阴影内部平均亮度: shadow.meanLum,
        阴影内部峰值: shadow.maxLum,
      };
      S.settings.diskBright = 1.35;
      await sleep(200);

      // --- 粒子数量上限 ---
      out.particleCap = {};
      for (const d of [0, 0.5, 1, 2]) {
        p.overlay.setDensity(d);
        out.particleCap[String(d)] = p.overlay.max;
      }
      p.overlay.setDensity(0);
      await sleep(120);
      out.densityZeroClearsParticles = (p.overlay.parts.length === 0);
      p.overlay.setDensity(0.5);
      out.particleDensity = S.settings.particles;

      // --- 泛光到底有多亮：直接量叠加层像素 ---
      // 必须先把粒子停掉，否则同一个坐标每次采到的是随机飞过的尘埃，数字毫无意义
      p.overlay.spawnAmbient = () => {};
      p.overlay.spawnCursorDust = () => {};
      p.overlay.parts.length = 0;
      p.overlay.flashes.length = 0;

      // 直接取该点的 RGBA。粒子已停，画布上只剩泛光
      const sampleGlow = (k) => {
        const cx = Math.round((S.hole.x + R * k) * ratio);
        const cy = Math.round(S.hole.y * ratio);
        const d = ctx.getImageData(cx, cy, 1, 1).data;
        const a = d[3] / 255;
        const lum = 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
        // alpha 才是泛光强度；added = 真正叠加到桌面上的光（0-255 标度）
        return { alpha: d[3], added: +(a * lum).toFixed(1) };
      };
      const measure = async (g) => {
        S.settings.glow = g;
        await sleep(300);
        p.overlay.parts.length = 0;
        await sleep(60);
        return { at1_5R: sampleGlow(1.5), at3R: sampleGlow(3) };
      };
      // 0.45 = 新默认；1.0 = 上一版的行为。对比这两行就是「泛光收了多少」
      out.glowLum = {
        '关(0)': await measure(0),
        '弱(0.45)=新默认': await measure(0.45),
        '旧默认(1.0)': await measure(1.0),
        '强(1.6)': await measure(1.6),
      };
      S.settings.glow = 0.45;
      await sleep(200);
      return out;
    })()`, 90000).catch((e) => ({ __error: String(e && e.message || e) }));
    console.log('[preview] 交互自检:', JSON.stringify(checks, null, 2));
  }

  win.destroy();

  if (rendererErrors.length) {
    console.error(`\n[preview] ✗ 渲染层有 ${rendererErrors.length} 条报错，预览结果不可信：`);
    for (const m of rendererErrors.slice(0, 10)) console.error('    ' + m);
    app.exit(4);
    return;
  }
  console.log('[preview] ✓ 渲染层无报错');
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
