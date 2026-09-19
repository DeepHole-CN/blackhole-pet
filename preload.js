'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 渲染进程 ⇄ 主进程 的唯一通道。
 * 渲染层不接触任何 Node / fs 能力，所有文件操作都发生在主进程并经过安全校验。
 */
contextBridge.exposeInMainWorld('pet', {
  // —— 窗口 ——
  setInteractive: (on) => ipcRenderer.send('pet:set-interactive', !!on),
  quit: () => ipcRenderer.send('pet:quit'),
  hide: () => ipcRenderer.send('pet:hide'),
  openExternal: (url) => ipcRenderer.send('pet:open-external', String(url)),

  // —— 设置 ——
  getSettings: () => ipcRenderer.invoke('pet:settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('pet:settings:set', patch),
  onSettings: (cb) => ipcRenderer.on('pet:settings', (_e, s) => cb(s)),

  // —— 桌面捕获（引力透镜背景）——
  screenPermission: () => ipcRenderer.invoke('pet:screen-permission'),
  captureDesktop: () => ipcRenderer.invoke('pet:capture-desktop'),

  // —— 吞噬文件 ——
  pickFiles: () => ipcRenderer.invoke('pet:pick-files'),
  devour: (paths) => ipcRenderer.invoke('pet:devour', paths),
  openQuarantine: () => ipcRenderer.send('pet:open-quarantine'),
  getStats: () => ipcRenderer.invoke('pet:stats'),

  // 把拖入的 File 对象换成真实路径（Electron 32+ 的正确姿势）
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  // —— 主进程 → 渲染进程 指令 ——
  onCommand: (cb) => ipcRenderer.on('pet:command', (_e, cmd) => cb(cmd)),
  onCursor: (cb) => ipcRenderer.on('pet:cursor', (_e, p) => cb(p)),
  holeMoved: (d) => ipcRenderer.send('pet:hole-moved', d),
  setTrayIcon: (dataURL) => ipcRenderer.send('pet:tray-icon', dataURL),

  platform: process.platform,
});
