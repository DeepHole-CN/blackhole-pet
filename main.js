'use strict';

/**
 * 黑洞桌面宠物 · 主进程
 *
 * 职责：
 *  1. 创建一个全屏、透明、无边框、永远置顶的覆盖窗口；
 *  2. 默认鼠标穿透，仅当光标落在黑洞本体上时临时接管鼠标（可拖拽）；
 *  3. 定时抓取桌面快照，交给渲染层做引力透镜（需要 macOS 录屏权限）；
 *  4. 安全地"吞噬"文件：默认移入隔离区（可恢复），永不触碰系统目录。
 */

const {
  app, BrowserWindow, ipcMain, screen, desktopCapturer, Tray, Menu,
  nativeImage, dialog, globalShortcut, shell, systemPreferences,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createDevourer } = require('./lib/devour');
const { migrateSettings, SETTINGS_VERSION } = require('./lib/settings');

// ---------------------------------------------------------------------------
// 常量 & 设置
// ---------------------------------------------------------------------------

const HOME = os.homedir();
// 阴影直径（CSS px）。吸积盘直径约是它的 5.8 倍，所以这些数字看着小，实际不小。
const HOLE_DIAMETER = { tiny: 22, small: 34, medium: 50, large: 74 };

/**
 * 目录一律惰性解析 + 兜底。
 * 在某些受限环境里（被别的沙箱包着、自建的 userData 目录不可写）
 * `app.getPath('userData')` 会直接抛 "Failed to get 'userData' path"。
 * 这些调用又发生在模块加载期，一抛就是整个应用起不来 —— 所以绝不能裸调。
 */
function resolveUserData() {
  if (process.env.PET_USER_DATA) return process.env.PET_USER_DATA;
  try {
    const p = app.getPath('userData');
    if (p) { fs.mkdirSync(p, { recursive: true }); return p; }
  } catch { /* 落到临时目录 */ }
  const fb = path.join(os.tmpdir(), 'blackhole-pet');
  try { fs.mkdirSync(fb, { recursive: true }); } catch { /* ignore */ }
  console.warn('[pet] 标准 userData 目录不可用，改用：' + fb);
  return fb;
}

let _petDir = null;
function petDir() {
  if (_petDir) return _petDir;
  const preferred = path.join(HOME, 'BlackHolePet');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const probe = path.join(preferred, '.write-test');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    _petDir = preferred;
  } catch {
    _petDir = path.join(resolveUserData(), 'BlackHolePet');
    try { fs.mkdirSync(_petDir, { recursive: true }); } catch { /* ignore */ }
  }
  return _petDir;
}
const quarantineDir = () => path.join(petDir(), 'eaten');
const journalFile = () => path.join(petDir(), 'journal.jsonl');

/** 绝对禁止吞噬的路径前缀（系统 / 应用 / 挂载点） */
function forbiddenPrefixes() {
  return [
    '/System', '/Library', '/Applications', '/usr', '/bin', '/sbin',
    '/private', '/etc', '/var', '/opt', '/Volumes', '/cores', '/dev',
    petDir(), app.getAppPath(),
  ];
}

const DEFAULT_SETTINGS = {
  size: 'small',
  quality: 'auto',          // auto | high | medium | low
  lensRadius: 9,
  follow: 'free',           // free | follow | fixed
  bgCapture: true,
  autoRefreshBg: true,
  interactive: true,   // false = 永远鼠标穿透，纯装饰
  glow: 0.45,          // 泛光强度倍率，0 = 关
  particles: 0.5,      // 粒子密度倍率，0 = 关
  hud: true,
  jets: 0.65,
  diskBright: 1.35,
  eatMode: 'quarantine',    // quarantine | delete
  feedMode: false,
  driftSpeed: 1.0,
  roll: -0.30,
  inclination: 0.30,
};

let _settingsFile = null;
function settingsPath() {
  if (!_settingsFile) _settingsFile = path.join(resolveUserData(), 'settings.json');
  return _settingsFile;
}

let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  // 版本迁移在 lib/settings.js 里，有独立回归测试（scripts/test-settings.js）
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    settings = migrateSettings(raw, DEFAULT_SETTINGS, SETTINGS_VERSION);
  } catch {
    settings = { ...DEFAULT_SETTINGS, v: SETTINGS_VERSION };
  }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ ...settings, v: SETTINGS_VERSION }, null, 2));
  } catch (e) { console.error('[pet] 保存设置失败', e); }
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let win = null;
let tray = null;
let interactive = false;
let quitting = false;
let bgTimer = null;
let lastCaptureAt = 0;
let holeMovedSinceCapture = 1e9;

function display() { return screen.getPrimaryDisplay(); }

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow() {
  const { bounds } = display();

  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    acceptFirstMouse: true,
    title: '黑洞宠物',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 让本窗口不被自己（以及其他录屏）抓进去，避免引力透镜出现无限递归
  win.setContentProtection(true);
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', async () => {
    win.showInactive();
    // 首次抓取发生在窗口显示之前，保证是干净的桌面
    await refreshDesktopSnapshot('boot');
  });

  win.on('closed', () => { win = null; });

  // PET_DEBUG=1 时把渲染层的日志转发到终端，方便排查
  if (process.env.PET_DEBUG) {
    win.webContents.on('console-message', (e, level, message, line, sourceId) => {
      const msg = (e && e.message !== undefined) ? e.message : message;
      console.log(`[渲染层] ${msg}`);
    });
  }
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[pet] 渲染进程退出：', details);
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[pet] preload 出错：', preloadPath, error);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[pet] 页面加载失败：', code, desc);
  });

  return win;
}

function setInteractive(on) {
  if (!win || interactive === on) return;
  interactive = on;
  win.setIgnoreMouseEvents(!on, { forward: true });
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function applySettings(patch = {}) {
  const before = { ...settings };
  settings = { ...settings, ...patch };
  saveSettings();
  send('pet:settings', settings);

  if (win) {
    if (before.feedMode !== settings.feedMode) {
      if (settings.feedMode) setInteractive(true);
      // 退出喂食模式时交还给渲染层的光标命中检测
      else send('pet:command', { type: 'recheck-hover' });
    }
    if (before.showOnAllWorkspaces !== settings.showOnAllWorkspaces ||
        before.alwaysOnTop !== settings.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(settings.showOnAllWorkspaces !== false, { visibleOnFullScreen: true });
    }
  }
  buildTrayMenu();
  return settings;
}

// ---------------------------------------------------------------------------
// 桌面快照（引力透镜用）
// ---------------------------------------------------------------------------

function screenPermission() {
  try { return systemPreferences.getMediaAccessStatus('screen'); }
  catch { return 'unknown'; }
}

async function captureDesktop() {
  const disp = display();
  const sf = disp.scaleFactor || 1;
  const capW = 2400;
  let tw = Math.round(disp.bounds.width * sf);
  let th = Math.round(disp.bounds.height * sf);
  if (tw > capW) { const k = capW / tw; tw = Math.round(tw * k); th = Math.round(th * k); }

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: tw, height: th },
    });
  } catch (e) {
    return { ok: false, reason: 'capture-failed', message: String(e && e.message || e) };
  }

  if (!sources || !sources.length) return { ok: false, reason: 'no-source' };

  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return { ok: false, reason: 'empty', permission: screenPermission() };

  return {
    ok: true,
    dataURL: img.toDataURL(),
    width: img.getSize().width,
    height: img.getSize().height,
    at: Date.now(),
  };
}

async function refreshDesktopSnapshot(reason) {
  if (!settings.bgCapture) return;
  const perm = screenPermission();
  if (perm !== 'granted' && reason !== 'manual') {
    send('pet:command', { type: 'screen-permission', status: perm });
    return;
  }
  const res = await captureDesktop();
  if (res.ok) {
    lastCaptureAt = Date.now();
    holeMovedSinceCapture = 0;
    send('pet:command', { type: 'desktop-snapshot', payload: res, reason });
  } else {
    send('pet:command', { type: 'screen-permission', status: res.permission || screenPermission() });
  }
}

// 黑洞移动较远时，过一会儿悄悄换一张新背景
ipcMain.on('pet:hole-moved', (_e, dist) => {
  holeMovedSinceCapture += Math.abs(dist || 0);
});

function startBgLoop() {
  clearInterval(bgTimer);
  bgTimer = setInterval(() => {
    if (!settings.bgCapture || !settings.autoRefreshBg) return;
    if (Date.now() - lastCaptureAt < 8000) return;
    if (holeMovedSinceCapture < 160) return;          // 没怎么动就不刷新
    refreshDesktopSnapshot('auto');
  }, 4000);
}

// ---------------------------------------------------------------------------
// 吞噬文件（安全策略在 lib/devour.js，可脱离 Electron 单独测试）
// ---------------------------------------------------------------------------

const devourer = createDevourer({
  home: HOME,
  petDir,
  quarantineDir,
  journalFile,
  extraForbidden: () => [app.getAppPath()],
  getMode: () => settings.eatMode,
});
const stats = devourer.stats;
const isSafeToEat = devourer.isSafeToEat;

function devourPaths(paths) {
  const res = devourer.devourPaths(paths);
  send('pet:command', { type: 'stats', stats });
  return res;
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

/** 用渲染层画好的 32×32 PNG 做托盘图标（避免打包二进制资源） */
function makeTray(dataURL) {
  try {
    const img = nativeImage.createFromDataURL(dataURL);
    if (img.isEmpty()) return;
    if (!tray) {
      tray = new Tray(img);
      tray.setToolTip('黑洞宠物');
      tray.on('click', () => { if (win) { win.isVisible() ? win.hide() : win.showInactive(); } });
    } else {
      tray.setImage(img);
    }
    buildTrayMenu();
  } catch (e) { console.error('[pet] tray', e); }
}

function buildTrayMenu() {
  if (!tray) return;
  const perm = screenPermission();
  const menu = Menu.buildFromTemplate([
    { label: `已吞噬 ${stats.eaten} 个文件 · ${(stats.bytes / 1048576).toFixed(1)} MB`, enabled: false },
    { type: 'separator' },
    { label: '投喂文件…（选择要吞噬的文件）', click: pickAndFeed },
    { label: settings.feedMode ? '退出喂食模式（可拖拽）' : '进入喂食模式（可拖拽文件）',
      type: 'checkbox', checked: !!settings.feedMode,
      click: (mi) => applySettings({ feedMode: mi.checked }) },
    { type: 'separator' },
    {
      label: '引力透镜（捕捉桌面）',
      type: 'checkbox', checked: !!settings.bgCapture,
      sublabel: perm === 'granted' ? '已授权录屏' : '需要「屏幕录制」权限',
      click: (mi) => {
        applySettings({ bgCapture: mi.checked });
        if (mi.checked) refreshDesktopSnapshot('manual');
      },
    },
    { label: '立即刷新桌面快照', enabled: !!settings.bgCapture, click: () => refreshDesktopSnapshot('manual') },
    { label: '打开屏幕录制权限设置', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') },
    { type: 'separator' },
    {
      label: '行为',
      submenu: [
        { label: '自由漂浮', type: 'radio', checked: settings.follow === 'free', click: () => applySettings({ follow: 'free' }) },
        { label: '跟随鼠标', type: 'radio', checked: settings.follow === 'follow', click: () => applySettings({ follow: 'follow' }) },
        { label: '固定在屏幕中央', type: 'radio', checked: settings.follow === 'fixed', click: () => applySettings({ follow: 'fixed' }) },
      ],
    },
    {
      label: '体型',
      submenu: [
        { label: `极小（阴影 ${HOLE_DIAMETER.tiny}px）`, type: 'radio', checked: settings.size === 'tiny', click: () => applySettings({ size: 'tiny' }) },
        { label: `小（阴影 ${HOLE_DIAMETER.small}px）`, type: 'radio', checked: settings.size === 'small', click: () => applySettings({ size: 'small' }) },
        { label: `中（阴影 ${HOLE_DIAMETER.medium}px）`, type: 'radio', checked: settings.size === 'medium', click: () => applySettings({ size: 'medium' }) },
        { label: `大（阴影 ${HOLE_DIAMETER.large}px）`, type: 'radio', checked: settings.size === 'large', click: () => applySettings({ size: 'large' }) },
      ],
    },
    {
      label: '吸积盘亮度',
      submenu: [
        { label: '弱', type: 'radio', checked: settings.diskBright === 0.7, click: () => applySettings({ diskBright: 0.7 }) },
        { label: '中', type: 'radio', checked: settings.diskBright === 1.35, click: () => applySettings({ diskBright: 1.35 }) },
        { label: '强', type: 'radio', checked: settings.diskBright === 2.0, click: () => applySettings({ diskBright: 2.0 }) },
        { label: '极强', type: 'radio', checked: settings.diskBright === 2.8, click: () => applySettings({ diskBright: 2.8 }) },
      ],
    },
    {
      label: '移动速度',
      submenu: [
        { label: '静止', type: 'radio', checked: settings.driftSpeed === 0, click: () => applySettings({ driftSpeed: 0 }) },
        { label: '慢', type: 'radio', checked: settings.driftSpeed === 0.5, click: () => applySettings({ driftSpeed: 0.5 }) },
        { label: '中', type: 'radio', checked: settings.driftSpeed === 1, click: () => applySettings({ driftSpeed: 1 }) },
        { label: '快', type: 'radio', checked: settings.driftSpeed === 2, click: () => applySettings({ driftSpeed: 2 }) },
      ],
    },
    {
      label: '粒子数量',
      submenu: [
        { label: '关', type: 'radio', checked: settings.particles === 0, click: () => applySettings({ particles: 0 }) },
        { label: '少', type: 'radio', checked: settings.particles === 0.5, click: () => applySettings({ particles: 0.5 }) },
        { label: '中', type: 'radio', checked: settings.particles === 1, click: () => applySettings({ particles: 1 }) },
        { label: '多', type: 'radio', checked: settings.particles === 2, click: () => applySettings({ particles: 2 }) },
      ],
    },
    {
      label: '泛光',
      submenu: [
        { label: '关', type: 'radio', checked: settings.glow === 0, click: () => applySettings({ glow: 0 }) },
        { label: '弱', type: 'radio', checked: settings.glow === 0.45, click: () => applySettings({ glow: 0.45 }) },
        { label: '中', type: 'radio', checked: settings.glow === 1, click: () => applySettings({ glow: 1 }) },
        { label: '强', type: 'radio', checked: settings.glow === 1.6, click: () => applySettings({ glow: 1.6 }) },
      ],
    },
    {
      label: '画质',
      submenu: ['auto', 'high', 'medium', 'low'].map((q) => ({
        label: { auto: '自动', high: '高', medium: '中', low: '低' }[q],
        type: 'radio', checked: settings.quality === q, click: () => applySettings({ quality: q }),
      })),
    },
    { label: '显示状态面板', type: 'checkbox', checked: !!settings.hud, click: (mi) => applySettings({ hud: mi.checked }) },
    { label: '允许鼠标拖动（关掉则完全穿透）', type: 'checkbox', checked: settings.interactive !== false, click: (mi) => applySettings({ interactive: mi.checked }) },
    { type: 'separator' },
    {
      label: '吞噬方式',
      submenu: [
        { label: '移入隔离区（可恢复）', type: 'radio', checked: settings.eatMode === 'quarantine', click: () => applySettings({ eatMode: 'quarantine' }) },
        { label: '永久删除（危险）', type: 'radio', checked: settings.eatMode === 'delete', click: () => applySettings({ eatMode: 'delete' }) },
      ],
    },
    { label: '打开隔离区文件夹', click: () => { fs.mkdirSync(quarantineDir(), { recursive: true }); shell.openPath(quarantineDir()); } },
    { type: 'separator' },
    { label: '隐藏黑洞（⌥⌘H）', click: () => win && win.hide() },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

async function pickAndFeed() {
  const res = await dialog.showOpenDialog(win, {
    title: '选择要投喂给黑洞的东西',
    buttonLabel: '吞噬',
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled || !res.filePaths.length) return;
  // 先让渲染层播动画，主进程负责真正的文件操作
  send('pet:command', { type: 'feed-paths', paths: res.filePaths });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.on('pet:set-interactive', (_e, on) => {
  if (settings.feedMode && !on) return;   // 喂食模式下保持可交互
  setInteractive(on);
});
ipcMain.on('pet:quit', () => { quitting = true; app.quit(); });
ipcMain.on('pet:hide', () => win && win.hide());
ipcMain.on('pet:open-external', (_e, url) => { if (/^https?:|^x-apple\./.test(url)) shell.openExternal(url); });
ipcMain.on('pet:open-quarantine', () => { fs.mkdirSync(quarantineDir(), { recursive: true }); shell.openPath(quarantineDir()); });

ipcMain.handle('pet:settings:get', () => settings);
ipcMain.handle('pet:settings:set', (_e, patch) => applySettings(patch || {}));
ipcMain.handle('pet:screen-permission', () => screenPermission());
ipcMain.handle('pet:capture-desktop', () => captureDesktop());
ipcMain.handle('pet:pick-files', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择要投喂给黑洞的东西', buttonLabel: '吞噬',
    properties: ['openFile', 'multiSelections'],
  });
  return res.canceled ? [] : res.filePaths;
});
ipcMain.handle('pet:devour', (_e, paths) => devourPaths(paths));
ipcMain.handle('pet:stats', () => ({ stats, quarantine: quarantineDir() }));
ipcMain.on('pet:tray-icon', (_e, dataURL) => makeTray(dataURL));

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) win.showInactive(); });

  app.whenReady().then(() => {
    loadSettings();
    petDir();   // 预热并确认可写
    createWindow();
    startBgLoop();

    globalShortcut.register('Control+Alt+Command+B', () => applySettings({ feedMode: !settings.feedMode }));
    globalShortcut.register('Control+Alt+Command+H', () => { if (win) win.isVisible() ? win.hide() : win.showInactive(); });

    // 全局光标轮询：比 ignoreMouseEvents 的 forward 在各种 macOS 版本上都更可靠，
    // 渲染层据此判断"光标是否落在黑洞上"，从而决定要不要接管鼠标。
    let lastCursor = { x: -1, y: -1 };
    setInterval(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      const p = screen.getCursorScreenPoint();
      if (p.x === lastCursor.x && p.y === lastCursor.y) return;
      lastCursor = p;
      send('pet:cursor', p);
    }, 50);

    // 屏幕权限变化时重新尝试
    setInterval(() => {
      if (!settings.bgCapture) return;
      if (lastCaptureAt) return;
      if (screenPermission() === 'granted') refreshDesktopSnapshot('perm-granted');
    }, 5000);

    // 自检：PET_SELFTEST="/path/a:/path/b" 会走一遍真实的吞噬流程、打印结果然后退出。
    // 用来验证安全白名单/黑名单，避免在真人使用时误删东西。
    if (process.env.PET_SELFTEST) {
      const targets = process.env.PET_SELFTEST.split(':').filter(Boolean);
      console.log('[selftest] 目标：', targets);
      const res = devourPaths(targets);
      console.log('[selftest] 结果：' + JSON.stringify(res, null, 2));
      setTimeout(() => app.exit(0), 200);
    }
  });

  app.on('before-quit', () => { quitting = true; clearInterval(bgTimer); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { if (!quitting) app.quit(); });
  app.on('activate', () => { if (win) win.showInactive(); });
}
