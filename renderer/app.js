'use strict';

/**
 * 黑洞桌面宠物 · 渲染层主控
 * 位置、行为、交互、粒子、菜单都在这里串起来。
 */

const canvasGL = document.getElementById('gl');
const canvasFX = document.getElementById('fx');
const hudEl = document.getElementById('hud');
const menuEl = document.getElementById('menu');
const toastEl = document.getElementById('toast');
const feedHintEl = document.getElementById('feedHint');

const gl = new BlackHoleGL(canvasGL);
const overlay = new Overlay(canvasFX);

const PREVIEW = /[?&]preview/.test(location.search);
const ICON_MODE = /[?&]icon=1/.test(location.search);   // 生成应用图标用
const PREVIEW_HUD = /[?&]hud=1/.test(location.search);

// 阴影直径（CSS px）。真正常看的是外面那圈吸积盘，直径约是这里的 5.8 倍，
// 所以别把「阴影尺寸」当成它占屏幕的大小 —— 默认给得很小。
const SIZE_PX = { tiny: 22, small: 34, medium: 50, large: 74 };
const QUALITY = {
  low: { scale: 0.5, steps: 90 },
  medium: { scale: 0.7, steps: 140 },
  high: { scale: 1.0, steps: 200 },
  auto: { scale: 0.75, steps: 160 },
};
const GLOW_LEVELS = [0, 0.45, 1, 1.6];
const GLOW_LABEL = { 0: '关', 0.45: '弱', 1: '中', 1.6: '强' };
const DISK_LEVELS = [0.7, 1.35, 2.0, 2.8];
const DISK_LABEL = { 0.7: '弱', 1.35: '中', 2.0: '强', 2.8: '极强' };
const PARTICLE_LEVELS = [0, 0.5, 1, 2];
const PARTICLE_LABEL = { 0: '关', 0.5: '少', 1: '中', 2: '多' };

const FOLLOW_LABEL = { free: '自由漂浮', follow: '跟随鼠标', fixed: '固定在中央' };
const SIZE_LABEL = { tiny: '极小', small: '小', medium: '中', large: '大' };
const QUALITY_LABEL = { auto: '自动', high: '高', medium: '中', low: '低' };

const S = {
  settings: {
    size: 'small', quality: 'auto', lensRadius: 9, follow: 'free',
    interactive: true, glow: 0.45, particles: 0.5,
    bgCapture: true, autoRefreshBg: true, hud: true, jets: 0.65,
    diskBright: 1.35, eatMode: 'quarantine', feedMode: false,
    driftSpeed: 1.0, roll: -0.30, inclination: 0.30,
  },
  hole: { x: 0, y: 0, vx: 0, vy: 0, r: 42 },
  sizeBias: 1,
  grow: 0,
  flash: 0,
  time: 0,
  dragging: false,
  dragOff: { x: 0, y: 0 },
  menuOpen: false,
  cursor: { x: 0, y: 0, vx: 0, vy: 0, t: 0, seen: false },
  interactive: false,
  hoverSince: 0,
  stats: { eaten: 0, bytes: 0 },
  quarantine: '',
  permission: 'unknown',
  lastActivity: 0,
  movedAcc: 0,
  lastAck: 0,
  note: '',
};

const W = () => window.innerWidth;
const H = () => window.innerHeight;
const holeRadius = () => S.hole.r * (1 + S.grow);

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

async function boot() {
  resize();
  window.addEventListener('resize', resize);

  S.hole.x = W() * 0.62;
  S.hole.y = H() * 0.52;
  S.cursor.x = S.hole.x;
  S.cursor.y = S.hole.y;

  bindWindowEvents();
  overlay.onSwallow = handleSwallow;

  if (window.pet) {
    S.settings = { ...S.settings, ...(await window.pet.getSettings()) };
    window.pet.onSettings((s) => { applySettings(s); });
    window.pet.onCommand(handleCommand);
    window.pet.onCursor(onCursor);
    const st = await window.pet.getStats();
    S.stats = st.stats;
    S.quarantine = st.quarantine;
    makeTrayIcon();
    initDesktop();
  } else if (PREVIEW) {
    fakeDesktop();
  }

  applySettings(S.settings);
  requestAnimationFrame(loop);
}

function applySettings(s) {
  S.settings = { ...S.settings, ...s };
  const q = QUALITY[S.settings.quality] || QUALITY.auto;
  gl.maxSteps = q.steps;
  gl.renderScale = q.scale;
  if (gl.hasTex && !S.settings.bgCapture) { gl.clearDesktop(); }
  feedHintEl.classList.toggle('hidden', !S.settings.feedMode);
  if (!S.settings.hud) hudEl.classList.remove('show');
  if (S.settings.follow === 'fixed') { S.hole.vx = 0; S.hole.vy = 0; }
  if (S.settings.interactive === false) setInteractive(false);
  overlay.setDensity(S.settings.particles);
  if (S.settings.bgCapture && S.settings.autoRefreshBg && S.permission === 'granted' && !gl.hasTex) {
    grabDesktop();
  }
  if (S.menuOpen) closeMenu();
}

function resize() {
  const q = QUALITY[S.settings.quality] || QUALITY.auto;
  gl.resize(W(), H(), q.scale);
  gl._needResize = false;
  overlay.resize(W(), H(), Math.min(window.devicePixelRatio || 1, 2));
}

// ---------------------------------------------------------------------------
// 桌面快照 / 权限
// ---------------------------------------------------------------------------

async function initDesktop() {
  S.permission = await window.pet.screenPermission();
  updatePermHint();
  if (S.settings.bgCapture && S.permission === 'granted') grabDesktop();
}

async function grabDesktop() {
  const res = await window.pet.captureDesktop();
  if (res && res.ok) setDesktopImage(res.dataURL);
  else if (res && res.permission) { S.permission = res.permission; updatePermHint(); }
}

function setDesktopImage(dataURL) {
  const img = new Image();
  img.onload = () => { gl.setDesktop(img); };
  img.src = dataURL;
}

function updatePermHint() {
  const el = document.getElementById('hudPerm');
  const need = S.settings.bgCapture && S.permission !== 'granted';
  el.classList.toggle('hidden', !need);
}

/** 预览模式用的假桌面：有格子、有窗口，能清楚看出透镜畸变 */
function fakeDesktop() {
  const c = document.createElement('canvas');
  c.width = 1600; c.height = 1000;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 1600, 1000);
  g.addColorStop(0, '#101a3a');
  g.addColorStop(0.5, '#241a44');
  g.addColorStop(1, '#3a1830');
  x.fillStyle = g; x.fillRect(0, 0, 1600, 1000);

  x.strokeStyle = 'rgba(140,180,255,0.14)';
  x.lineWidth = 1;
  for (let i = 0; i <= 1600; i += 50) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 1000); x.stroke(); }
  for (let j = 0; j <= 1000; j += 50) { x.beginPath(); x.moveTo(0, j); x.lineTo(1600, j); x.stroke(); }

  const win = (wx, wy, ww, wh, tint) => {
    x.fillStyle = 'rgba(16,20,34,0.88)';
    x.strokeStyle = 'rgba(255,255,255,0.22)';
    x.lineWidth = 2;
    x.beginPath(); x.roundRect(wx, wy, ww, wh, 12); x.fill(); x.stroke();
    x.fillStyle = tint;
    x.beginPath(); x.roundRect(wx, wy, ww, 30, 12); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.30)';
    for (let i = 0; i < 3; i++) { x.beginPath(); x.arc(wx + ww - 22 - i * 20, wy + 15, 5, 0, 6.284); x.fill(); }
    x.fillStyle = 'rgba(190,210,255,0.20)';
    for (let i = 0; i < 7; i++) x.fillRect(wx + 22, wy + 52 + i * 20, (ww - 60) * (0.35 + 0.6 * Math.random()), 7);
  };
  win(90, 130, 430, 300, 'rgba(90,140,255,0.45)');
  win(600, 520, 520, 340, 'rgba(255,120,90,0.40)');
  win(1120, 90, 380, 260, 'rgba(120,255,200,0.32)');

  x.fillStyle = 'rgba(255,255,255,0.92)';
  x.font = '700 46px -apple-system, "PingFang SC", sans-serif';
  x.fillText('事件视界 · Event Horizon', 90, 520);
  x.font = '400 22px -apple-system, sans-serif';
  x.fillStyle = 'rgba(200,215,255,0.6)';
  x.fillText('引力透镜把这张桌面弯成爱因斯坦环', 92, 560);

  const img = new Image();
  img.onload = () => gl.setDesktop(img);
  const url = c.toDataURL();
  // 用 100% 100% 让背景与着色器里的纹理映射完全一致（着色器是把整张图铺满画布），
  // 这样截图中"没被着色器覆盖的区域"就是真实背景，正好验证透镜边缘是否无缝。
  document.body.style.background = `url(${url}) 0 0 / 100% 100% no-repeat`;
  window.__petBgUrl = url;      // 自检要用；body 背景中途会被调试流程清掉
  img.src = url;
}

/** 预览脚本用来读取内部状态 */
window.__pet = { S, gl, overlay, get canvasGL() { return canvasGL; } };
window.__petdbg = () => ({
  cssW: W(),
  cssH: H(),
  hole: { x: S.hole.x, y: S.hole.y },
  holeR: holeRadius(),
  canvas: [canvasGL.width, canvasGL.height],
  pixelRatio: gl.pixelRatio,
  maxSteps: gl.maxSteps,
  renderScale: gl.renderScale,
  glOk: gl.ok,
  hasTex: gl.hasTex,
  frameMs: +gl.frameMs.toFixed(2),
  parts: overlay.parts.length,
  dpr: window.devicePixelRatio,
  uniforms: gl.lastUniforms,
  gpu: gl.gpuUniforms,
});

function makeTrayIcon() {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const x = c.getContext('2d');
  const cx = 16, cy = 16;
  const g = x.createRadialGradient(cx, cy, 4, cx, cy, 15);
  g.addColorStop(0.00, 'rgba(0,0,0,0)');
  g.addColorStop(0.42, 'rgba(0,0,0,0)');
  g.addColorStop(0.62, 'rgba(255,190,110,0.95)');
  g.addColorStop(0.78, 'rgba(255,120,40,0.55)');
  g.addColorStop(1.00, 'rgba(120,40,160,0)');
  x.fillStyle = g;
  x.beginPath(); x.arc(cx, cy, 16, 0, 6.284); x.fill();
  x.strokeStyle = 'rgba(255,220,180,0.95)';
  x.lineWidth = 1.6;
  x.beginPath(); x.arc(cx, cy, 7.4, 0, 6.284); x.stroke();
  if (window.pet) window.pet.setTrayIcon(c.toDataURL());
}

/** 主进程按 20Hz 轮询全局光标（比 forward 更可靠），换算成窗口本地坐标 */
function onCursor(p) {
  if (!p) return;
  const nx = p.x - window.screenX;
  const ny = p.y - window.screenY;
  const now = performance.now();
  const dt = Math.max(0.001, (now - (S.cursor.t || now - 50)) / 1000);
  S.cursor.vx = S.cursor.vx * 0.55 + ((nx - S.cursor.x) / dt) * 0.45;
  S.cursor.vy = S.cursor.vy * 0.55 + ((ny - S.cursor.y) / dt) * 0.45;
  S.cursor.x = nx;
  S.cursor.y = ny;
  S.cursor.t = now;
  S.cursor.seen = true;
  // 鼠标在动就算"活跃"，让它跑满 60fps
  if (Math.abs(S.cursor.vx) + Math.abs(S.cursor.vy) > 40) S.lastActivity = now;
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

function bindWindowEvents() {
  window.addEventListener('mousemove', (e) => {
    S.lastActivity = performance.now();
    S.cursor.x = e.clientX; S.cursor.y = e.clientY;
    S.cursor.seen = true;
  });

  window.addEventListener('mousedown', (e) => {
    S.lastActivity = performance.now();
    if (e.button === 2) { e.preventDefault(); return; }
    if (S.menuOpen) { closeMenu(); return; }
    const d = Math.hypot(e.clientX - S.hole.x, e.clientY - S.hole.y);
    if (d < holeRadius() * 2.0) {
      S.dragging = true;
      document.body.style.cursor = 'grabbing';
      S.dragOff.x = S.hole.x - e.clientX;
      S.dragOff.y = S.hole.y - e.clientY;
      document.body.classList.add('dragging');
      setInteractive(true);
    }
  });

  window.addEventListener('mouseup', () => {
    if (S.dragging) {
      S.dragging = false;
      document.body.classList.remove('dragging');
      document.body.style.cursor = S.interactive ? 'grab' : '';
    }
  });
  window.addEventListener('blur', () => { S.dragging = false; closeMenu(); });

  window.addEventListener('dblclick', (e) => {
    if (Math.hypot(e.clientX - S.hole.x, e.clientY - S.hole.y) < holeRadius() * 2.0) burp();
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    S.lastActivity = performance.now();
    openMenu(e.clientX, e.clientY);
  });

  // 滚轮只在按住 ⌥ 时缩放：裸滚轮会把底下应用的正常滚动吃掉
  window.addEventListener('wheel', (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    const fine = e.shiftKey ? 0.5 : 1;      // ⇧⌥ 滚 = 微调
    const k = 1 + (e.deltaY > 0 ? -0.06 : 0.06) * fine;
    S.sizeBias = Math.max(0.4, Math.min(2.5, S.sizeBias * k));
    S.lastActivity = performance.now();
  }, { passive: false });

  // 拖文件进来喂它
  window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    const paths = [];
    const metas = [];
    for (const f of files) {
      let p = '';
      try { p = window.pet && window.pet.pathForFile ? window.pet.pathForFile(f) : ''; } catch { p = ''; }
      if (p) paths.push(p);
      metas.push({ path: p, name: f.name, size: f.size });
    }
    feedVisual(metas);
    if (!paths.length) {
      toast('拖进来的文件拿不到路径，只吞了个影子 😅');
    }
  });

  document.getElementById('hudPerm').addEventListener('click', () => {
    if (window.pet) window.pet.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });
}

function setInteractive(on) {
  if (S.interactive === on) return;
  S.interactive = on;
  if (!S.dragging) document.body.style.cursor = on ? 'grab' : '';
  if (window.pet) window.pet.setInteractive(on);
}

function handleCommand(cmd) {
  if (!cmd) return;
  switch (cmd.type) {
    case 'desktop-snapshot':
      setDesktopImage(cmd.payload.dataURL);
      S.permission = 'granted';
      updatePermHint();
      break;
    case 'screen-permission':
      S.permission = cmd.status;
      updatePermHint();
      break;
    case 'feed-paths':
      feedVisual(cmd.paths.map((p) => ({ path: p, name: p.split('/').pop(), size: 0 })));
      break;
    case 'stats':
      S.stats = cmd.stats;
      break;
    case 'recheck-hover':
      break;
    default: break;
  }
}

function feedVisual(metas) {
  for (const m of metas) overlay.spawnFile(m.path, m.name, m.size, W(), H());
  toast(`投喂 ${metas.length} 个目标 · 正在撕碎`);
  S.lastActivity = performance.now();
}

function handleSwallow(part) {
  if (part.type === 'file' && part.path && window.pet) {
    window.pet.devour([part.path]).then((res) => {
      const r = res.results[0];
      S.stats = res.stats;
      if (r && r.ok) {
        S.flash = Math.min(1, S.flash + 0.30);
        S.grow = Math.min(0.5, S.grow + 0.05);
        toast(res.stats.eaten === 1
          ? `吞噬：${part.name}`
          : `吞噬：${part.name} · 累计 ${res.stats.eaten} 件`);
      } else {
        toast(`${part.name} 吞不下去：${(r && r.why) || '未知原因'}`);
      }
    });
  } else if (part.type === 'file') {
    S.flash = Math.min(1, S.flash + 0.5);
    S.stats.eaten++;
    toast(`吞噬：${part.name}`);
  }
}

function burp() {
  S.flash = 0.7;
  S.grow = Math.min(0.6, S.grow + 0.12);
  overlay.burst(S.hole.x, S.hole.y, 14, 1.0);
  overlay.spawnAmbient(W(), H(), 4);
  toast('嗝～');
}

let toastTimer = 0;
function toast(msg) {
  S.note = msg;
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.classList.remove('show'); }, 2600);
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------

// 按「当前值」找到对应的键再取下一个 —— 不能用 keys.indexOf(值)，
// 因为 Object.keys 返回的是字符串，数字值永远匹配不上（泛光菜单就这么跳过一次）。
function cycle(obj, current) {
  const keys = Object.keys(obj);
  const i = keys.findIndex((k) => obj[k] === current);
  return keys[(i + 1) % keys.length];
}

/** 数值档位用它，返回真正的数字而不是字符串 */
function cycleValue(list, current) {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length];
}

function openMenu(x, y) {
  S.menuOpen = true;
  const s = S.settings;
  menuEl.innerHTML = '';

  const row = (label, value, fn, cls) => {
    const d = document.createElement('div');
    d.className = 'mi' + (cls ? ' ' + cls : '');
    d.innerHTML = `<span>${label}</span><span class="mark">${value || ''}</span>`;
    d.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
    menuEl.appendChild(d);
  };
  const sep = () => { const d = document.createElement('div'); d.className = 'sep'; menuEl.appendChild(d); };

  row('跟随方式', FOLLOW_LABEL[s.follow], () => set({ follow: cycle(FOLLOW_LABEL, s.follow) }));
  row('体型', SIZE_LABEL[s.size], () => set({ size: cycle(SIZE_LABEL, s.size) }));
  row('画质', QUALITY_LABEL[s.quality], () => set({ quality: cycle(QUALITY_LABEL, s.quality) }));
  sep();
  row('投喂文件…', '›', () => { closeMenu(); pickAndFeed(); });
  row('喂食模式（可拖拽）', s.feedMode ? '开' : '关', () => set({ feedMode: !s.feedMode }), s.feedMode ? 'on' : '');
  sep();
  row('引力透镜背景', s.bgCapture ? '开' : '关', () => set({ bgCapture: !s.bgCapture }), s.bgCapture ? 'on' : '');
  row('自动刷新背景', s.autoRefreshBg ? '开' : '关', () => set({ autoRefreshBg: !s.autoRefreshBg }));
  row('允许鼠标拖动', s.interactive === false ? '关（穿透）' : '开',
    () => set({ interactive: s.interactive === false }), s.interactive === false ? 'on' : '');
  row('状态面板', s.hud ? '开' : '关', () => set({ hud: !s.hud }));
  row('极向喷流', s.jets > 0.01 ? '开' : '关', () => set({ jets: s.jets > 0.01 ? 0 : 0.65 }));
  row('吸积盘亮度', DISK_LABEL[s.diskBright] || '中',
    () => set({ diskBright: cycleValue(DISK_LEVELS, Number(s.diskBright) || 1.35) }));
  row('移动速度', ({ 0: '静', 0.5: '慢', 1: '中', 2: '快' })[s.driftSpeed] || '中',
    () => set({ driftSpeed: cycleValue([0, 0.5, 1, 2], Number(s.driftSpeed) || 0) }));
  row('泛光', GLOW_LABEL[s.glow] || '弱',
    () => set({ glow: cycleValue(GLOW_LEVELS, Number(s.glow) || 0) }));
  row('粒子数量', PARTICLE_LABEL[s.particles] || '少',
    () => set({ particles: cycleValue(PARTICLE_LEVELS, Number(s.particles) || 0) }));
  sep();
  row('吞噬方式', s.eatMode === 'quarantine' ? '隔离区' : '永久删除',
    () => set({ eatMode: s.eatMode === 'quarantine' ? 'delete' : 'quarantine' }),
    s.eatMode === 'delete' ? 'danger' : '');
  row('打开隔离区', '›', () => { closeMenu(); window.pet && window.pet.openQuarantine(); });
  sep();
  row('隐藏黑洞', '⌥⌘H', () => { closeMenu(); window.pet && window.pet.hide(); });
  row('退出', '⌘Q', () => { window.pet && window.pet.quit(); }, 'danger');

  menuEl.classList.remove('hidden');
  const r = menuEl.getBoundingClientRect();
  const px = Math.min(x, W() - r.width - 8);
  const py = Math.min(y, H() - r.height - 8);
  menuEl.style.left = Math.max(8, px) + 'px';
  menuEl.style.top = Math.max(8, py) + 'px';
  setInteractive(true);
}

function closeMenu() {
  if (!S.menuOpen) return;
  S.menuOpen = false;
  menuEl.classList.add('hidden');
  if (!S.settings.feedMode) checkHover(true);
}

async function set(patch) {
  if (window.pet) S.settings = { ...S.settings, ...(await window.pet.setSettings(patch)) };
  else applySettings(patch);
  closeMenu();
}

async function pickAndFeed() {
  if (!window.pet) return;
  const paths = await window.pet.pickFiles();
  if (!paths || !paths.length) return;
  feedVisual(paths.map((p) => ({ path: p, name: p.split('/').pop(), size: 0 })));
}

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

const HOVER_DWELL_MS = 150;   // 悬停多久才接管鼠标

function checkHover(force) {
  // 喂食模式 / 开着菜单 / 正在拖 —— 这些必须接管鼠标，优先级高于"鼠标穿透"开关
  if (S.settings.feedMode || S.menuOpen || S.dragging) { setInteractive(true); return; }
  // 「允许鼠标拖动」关掉，就永远不接管，纯粹当个装饰
  if (S.settings.interactive === false) { setInteractive(false); return; }
  // 光标位置还没收到过（启动瞬间）就先别抓
  if (!S.cursor.seen) { setInteractive(false); return; }

  const R = holeRadius();
  const d = Math.hypot(S.cursor.x - S.hole.x, S.cursor.y - S.hole.y);
  // 进入热区要落在视界本体（黑影）上；已经在热区里则用一个稍大的边界退出，
  // 避免光标在边缘抖动时反复夺还鼠标。
  const inside = d < (S.interactive ? R * 1.25 : R * 1.0);

  if (inside) {
    if (!S.hoverSince) S.hoverSince = performance.now();
  } else {
    S.hoverSince = 0;
  }
  // 只是快速划过不该被抓走，必须真的停一下
  const held = inside && S.hoverSince > 0 && (performance.now() - S.hoverSince) >= HOVER_DWELL_MS;
  setInteractive(force ? inside : held);
}

function update(dt) {
  S.time += dt;
  const s = S.settings;
  const ox = S.hole.x, oy = S.hole.y;

  // 尺寸
  const base = (SIZE_PX[s.size] || SIZE_PX.small) / 2;
  S.hole.r = base * S.sizeBias;
  S.grow *= Math.exp(-1.6 * dt);
  S.flash *= Math.exp(-2.4 * dt);

  const W_ = W(), H_ = H();
  const margin = S.hole.r * 6.2;

  if (S.dragging && S.cursor.seen) {
    const tx = S.cursor.x + S.dragOff.x;
    const ty = S.cursor.y + S.dragOff.y;
    S.hole.x += (tx - S.hole.x) * Math.min(1, dt * 16);
    S.hole.y += (ty - S.hole.y) * Math.min(1, dt * 16);
  } else if (s.follow === 'follow' && S.cursor.seen) {
    const dx = S.cursor.x - S.hole.x, dy = S.cursor.y - S.hole.y;
    const d = Math.hypot(dx, dy) || 1;
    const sp = Math.min(130, Math.max(0, (d - 26) * 1.6));
    const ease = Math.min(1, dt * 2.4);
    S.hole.vx += ((dx / d) * sp - S.hole.vx) * ease;
    S.hole.vy += ((dy / d) * sp - S.hole.vy) * ease;
    S.hole.x += S.hole.vx * dt;
    S.hole.y += S.hole.vy * dt;
  } else if (s.follow === 'fixed') {
    const ease = Math.min(1, dt * 1.4);
    S.hole.x += (W_ / 2 - S.hole.x) * ease;
    S.hole.y += (H_ / 2 - S.hole.y) * ease;
  } else {
    // 自由漂浮：两层正弦叠加出平滑游走。
    // driftSpeed 现在调的是「速度」本身（原来调的是相位频率，越调越快得离谱）。
    const speedMul = s.driftSpeed == null ? 1 : s.driftSpeed;
    const t = S.time * 0.09;
    let vx = (Math.sin(t * 1.13) + 0.55 * Math.sin(t * 2.71 + 1.3)) * 9 * speedMul;
    let vy = (Math.cos(t * 0.94 + 2.1) + 0.55 * Math.sin(t * 3.07 + 0.4)) * 9 * speedMul;
    // 对鼠标的好奇心（原来半径 340px、力度 46，整个屏幕都在它的追逐范围里）
    if (S.cursor.seen) {
      const dx = S.cursor.x - S.hole.x, dy = S.cursor.y - S.hole.y;
      const d = Math.hypot(dx, dy);
      if (d < 200 && d > 1) {
        const w = (1 - d / 200) * 9 * speedMul;
        vx += (dx / d) * w;
        vy += (dy / d) * w;
      }
    }
    S.hole.x += vx * dt;
    S.hole.y += vy * dt;
  }

  // 软墙
  if (S.hole.x < margin) S.hole.x += (margin - S.hole.x) * Math.min(1, dt * 3);
  if (S.hole.x > W_ - margin) S.hole.x -= (S.hole.x - (W_ - margin)) * Math.min(1, dt * 3);
  if (S.hole.y < margin) S.hole.y += (margin - S.hole.y) * Math.min(1, dt * 3);
  if (S.hole.y > H_ - margin) S.hole.y -= (S.hole.y - (H_ - margin)) * Math.min(1, dt * 3);

  // 鼠标轨迹掉屑，被它吃掉（原来每帧 60% 概率，等于每秒几十颗，太糊了）
  if (S.cursor.seen && S.settings.particles > 0 && Math.random() < 0.10) {
    const sp = Math.hypot(S.cursor.vx || 0, S.cursor.vy || 0);
    if (sp > 30) overlay.spawnCursorDust(S.cursor.x, S.cursor.y, S.cursor.vx, S.cursor.vy, sp > 150 ? 2 : 1);
  }

  // 环境尘埃
  overlay.spawnAccum += dt * (0.8 + S.flash * 4);
  while (overlay.spawnAccum > 1) { overlay.spawnAccum -= 1; overlay.spawnAmbient(W_, H_, 1); }

  overlay.update(dt, W_, H_);
  checkHover(false);

  // 通知主进程黑洞移动了多少（决定要不要换一张新的桌面快照）
  S.movedAcc += Math.hypot(S.hole.x - ox, S.hole.y - oy);
  if (performance.now() - S.lastAck > 1500) {
    if (window.pet && S.movedAcc > 1) window.pet.holeMoved(S.movedAcc);
    S.movedAcc = 0;
    S.lastAck = performance.now();
  }
}

function draw() {
  const s = S.settings;
  const hr = holeRadius();
  gl.render({
    centerX: S.hole.x,
    centerY: S.hole.y,
    holeR: hr,
    time: S.time,
    lensRadius: s.lensRadius,
    inclination: s.inclination,
    roll: s.roll,
    diskBright: s.diskBright * (1 + S.flash * 0.9),
    jets: s.jets,
    flash: S.flash,
    // 光子环独立于「泛光」设置：泛光管的是外围那圈大范围光晕，
    // 光子环是视界边缘本身，之前跟着一起被砍掉导致盘看着发淡
    ringGlow: 0.30 + S.flash * 0.50,
    debug: window.__petDebug || 0,
  });
  overlay.roll = s.roll;
  overlay.glow = s.glow;   // 注意：draw() 里 s 就是 S.settings 本身
  overlay.setHole(S.hole.x, S.hole.y, hr);
  overlay.draw(S.time);
  layoutHUD(hr);
}

let hudAcc = 0;
let hudPosAcc = 0;
let hudShown = false;
function layoutHUD(hr) {
  if (!S.settings.hud) { hudEl.classList.remove('show'); hudShown = false; return; }
  const dist = Math.hypot(S.cursor.x - S.hole.x, S.cursor.y - S.hole.y);
  const show = dist < hr * 9 || S.dragging || S.menuOpen;
  if (show !== hudShown) { hudEl.classList.toggle('show', show); hudShown = show; }
  if (!show) return;
  hudPosAcc += 1;
  if (hudPosAcc % 12 !== 0) return;      // 每 12 帧才重排一次，避免频繁触发 layout

  const r = hudEl.getBoundingClientRect();
  let x = S.hole.x + hr * 2.1;
  let y = S.hole.y + hr * 0.55;
  if (x + r.width > W() - 10) x = S.hole.x - hr * 2.1 - r.width;
  if (y + r.height > H() - 10) y = H() - r.height - 10;
  hudEl.style.left = Math.max(10, x) + 'px';
  hudEl.style.top = Math.max(10, y) + 'px';
}

function refreshHUDText() {
  const mass = 1.0e3 + S.stats.eaten * 3.6e2;
  document.getElementById('hudMass').textContent = `${mass.toExponential(1).replace('e+', '×10^')} M☉`;
  document.getElementById('hudEaten').textContent = `${S.stats.eaten} 件`;
  document.getElementById('hudBytes').textContent = fmtBytes(S.stats.bytes);
}

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

let lastT = performance.now();
let lastDraw = 0;
let frames = 0;

function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (!(dt > 0)) return;
  dt = Math.min(dt, 0.05);

  update(dt);

  const active = now - S.lastActivity < 2500 || S.dragging || S.menuOpen;
  const minInterval = 1000 / (active ? 60 : 30);
  if (now - lastDraw < minInterval) return;
  const interval = lastDraw ? now - lastDraw : minInterval;
  lastDraw = now;
  draw();

  // 用真实帧间隔（而不是 CPU 提交耗时）来调画质，否则 GPU 再慢也不会降档
  if (S.settings.quality === 'auto' && active && interval < 200) {
    gl.autoTune(interval, 16.7);
    if (gl._needResize) { gl._needResize = false; gl.resize(W(), H(), gl.renderScale); }
  }

  hudAcc += dt;
  if (hudAcc > 0.25) { hudAcc = 0; refreshHUDText(); }

  frames++;
  if ((PREVIEW || ICON_MODE) && frames === 45) window.__previewReady = true;
}

// 预览/无 Electron 环境下的时钟兜底
if (!window.pet && PREVIEW) {
  S.cursor.seen = false;
  setInterval(() => {
    if (window.__petFreezeCursor) return;   // 交互自检时把模拟光标停掉
    const t = performance.now() / 1000;
    S.cursor.x = W() * (0.5 + 0.34 * Math.sin(t * 0.28));
    S.cursor.y = H() * (0.5 + 0.30 * Math.cos(t * 0.21));
    S.cursor.seen = true;
    S.cursor.vx = Math.cos(t * 0.28) * 60;
    S.cursor.vy = -Math.sin(t * 0.21) * 60;
  }, 60);
  if (!PREVIEW_HUD) hudEl.classList.add('hidden');
}

boot();
