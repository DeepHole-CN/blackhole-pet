'use strict';

/**
 * 生成应用图标 —— 直接用黑洞自己的渲染结果，不另外画一个。
 *
 *   ./start.sh --entry scripts/make-icon.js --no-sandbox
 *   # → build/icon-1024.png  以及 build/icon.icns
 *
 * 「换一台电脑也能装」这件事上图标不是小事：macOS 上没图标的 app
 * 在访达里就是一个白板，很难认。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const SIZE = 1024;
const PLATE = 824;          // macOS Big Sur 之后的图标规范：圆角方板约占 824/1024
const RADIUS = 185;

app.whenReady().then(async () => {
  fs.mkdirSync(BUILD, { recursive: true });

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
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
  win.setOpacity(0.03);
  win.setIgnoreMouseEvents(true);

  win.webContents.on('console-message', (e) => {
    const level = (e && e.level) || 'info';
    if (level === 'error' || level === 3) {
      console.error('[icon] 渲染层报错:', (e && e.message) || '');
    }
  });

  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'), { query: { icon: '1' } });

  const ready = await win.webContents.executeJavaScript(`new Promise((res) => {
    const t0 = Date.now();
    (function poll() {
      if (window.__previewReady) return res('ok');
      if (Date.now() - t0 > 20000) return res('timeout');
      setTimeout(poll, 100);
    })();
  })`);
  if (ready !== 'ok') { console.error('[icon] 渲染超时'); app.exit(2); return; }

  // 固定成一张"标准像"：居中、不动、不要桌面背景、不要粒子
  await win.webContents.executeJavaScript(`(() => {
    const p = window.__pet, S = p.S;
    window.__petFreezeCursor = true;
    S.cursor.seen = false;
    S.settings.hud = false;
    S.settings.follow = 'fixed';
    S.settings.jets = 0.55;
    S.settings.diskBright = 1.5;
    S.settings.glow = 0.75;
    S.sizeBias = 4.1;                       // 阴影半径 ≈ 70px，盘直径 ≈ 660px
    S.settings.roll = -0.30;
    S.settings.inclination = 0.34;
    S.hole.x = window.innerWidth / 2;
    S.hole.y = window.innerHeight / 2;
    p.overlay.setDensity(0);                // 图标里不要飘尘
    p.gl.clearDesktop();                    // 不要桌面纹理，背景由下面的圆角方板提供

    const plate = document.createElement('div');
    plate.style.cssText = [
      'position:fixed', 'left:50%', 'top:50%',
      'width:${PLATE}px', 'height:${PLATE}px',
      'margin-left:${-PLATE / 2}px', 'margin-top:${-PLATE / 2}px',
      'border-radius:${RADIUS}px',
      'z-index:0',
      'background:radial-gradient(circle at 50% 46%, #2a1f4a 0%, #171029 42%, #0a0714 72%, #050409 100%)',
      'box-shadow:inset 0 0 90px rgba(120,90,255,0.20), inset 0 0 0 1px rgba(255,255,255,0.06)',
    ].join(';');
    document.body.appendChild(plate);
  })()`);

  await new Promise((r) => setTimeout(r, 2600));   // 等盘转到好看的角度

  const img = await win.webContents.capturePage();
  const size = img.getSize();
  if (!size.width) { console.error('[icon] 截图失败'); app.exit(2); return; }

  const master = path.join(BUILD, 'icon-1024.png');
  fs.writeFileSync(master, img.toPNG());
  console.log(`[icon] 已保存 ${master} (${size.width}×${size.height})`);

  win.destroy();
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
