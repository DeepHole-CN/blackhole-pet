'use strict';
// 最小化 Electron 冒烟测试：能不能起窗口 + 截图
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, '..', 'smoke.png');

app.whenReady().then(async () => {
  console.log('[smoke] ready, pid', process.pid);
  const w = new BrowserWindow({
    width: 400, height: 300, show: true, frame: false,
    transparent: true, hasShadow: false, focusable: false,
    backgroundColor: '#00000000',
  });
  w.setOpacity(0.02);
  console.log('[smoke] window created');
  await w.loadURL('data:text/html,<body style="background:#123"><h1 style="color:#fff">hi</h1></body>');
  console.log('[smoke] loaded');
  await new Promise((r) => setTimeout(r, 800));
  const img = await w.webContents.capturePage();
  console.log('[smoke] captured', JSON.stringify(img.getSize()));
  fs.writeFileSync(OUT, img.toPNG());
  console.log('[smoke] saved', OUT);
  app.exit(0);
});

setTimeout(() => { console.error('[smoke] 超时退出'); app.exit(3); }, 25000);
