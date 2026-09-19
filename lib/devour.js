'use strict';

/**
 * 「吞噬」文件的安全核心。
 *
 * 单独成模块有两个原因：
 *   1. 删文件是这整个项目里唯一不可逆的操作，必须能脱离 Electron 单独跑回归测试
 *      （见 scripts/test-devour.js）；
 *   2. 主进程里那些目录解析、权限兜底的逻辑不该和文件安全策略搅在一起。
 *
 * 默认行为是「移进隔离区」而不是删除 —— 只有把 eatMode 切成 'delete' 才真删。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** 绝对禁止吞噬的系统路径 */
const SYSTEM_PREFIXES = [
  '/System', '/Library', '/Applications', '/usr', '/bin', '/sbin',
  '/private', '/etc', '/var', '/opt', '/Volumes', '/cores', '/dev',
];

/**
 * @param {object} opts
 *   petDir()           → 数据目录（隔离区、流水账都在这下面）
 *   quarantineDir()    → 隔离区目录
 *   journalFile()      → 流水账文件
 *   home               → 用户主目录（默认 os.homedir()）
 *   getMode()          → 'quarantine' | 'delete'
 *   extraForbidden     → 额外的受保护路径（字符串数组或函数）
 */
function createDevourer(opts) {
  const home = opts.home || os.homedir();
  const petDir = opts.petDir;
  const quarantineDir = opts.quarantineDir;
  const journalFile = opts.journalFile;
  const getMode = opts.getMode || (() => 'quarantine');

  const stats = { eaten: 0, bytes: 0, failed: 0 };

  function extraForbidden() {
    const e = opts.extraForbidden;
    if (!e) return [];
    return typeof e === 'function' ? e() : e;
  }

  function forbiddenPrefixes() {
    return [...SYSTEM_PREFIXES, petDir(), ...extraForbidden()].filter(Boolean);
  }

  /** 判断某个路径能不能吞；不能吞的话给出人话原因 */
  function isSafeToEat(p) {
    if (typeof p !== 'string' || !p) return { ok: false, why: '非法路径' };

    let abs;
    try { abs = fs.realpathSync(p); } catch { return { ok: false, why: '路径不存在' }; }

    if (abs === home) return { ok: false, why: '不能吞掉整个主目录' };

    for (const f of forbiddenPrefixes()) {
      if (abs === f || abs.startsWith(f + path.sep)) {
        return { ok: false, why: `受保护路径：${f}` };
      }
    }

    // 注意：必须用 lstat，realpath 已经把符号链接解开了
    let st;
    try { st = fs.lstatSync(p); } catch { return { ok: false, why: '无法读取' }; }
    if (st.isSymbolicLink()) return { ok: false, why: '符号链接不会被吞噬' };
    if (st.isDirectory()) return { ok: false, why: '目录不会被吞噬（避免一次删掉一堆东西）' };
    if (!st.isFile()) return { ok: false, why: '只吞噬普通文件' };

    if (abs.startsWith(quarantineDir() + path.sep)) {
      return { ok: false, why: '已经在隔离区里了' };
    }

    return { ok: true, abs, size: st.size, mtime: st.mtimeMs };
  }

  function uniqueDest(name) {
    const dir = quarantineDir();
    let dest = path.join(dir, name);
    if (!fs.existsSync(dest)) return dest;
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(dir, `${base}__${stamp}${ext}`);
  }

  function journal(entry) {
    try {
      fs.mkdirSync(petDir(), { recursive: true });
      fs.appendFileSync(journalFile(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    } catch { /* 流水账写不了也不能挡住吞噬本身 */ }
  }

  function devourPaths(paths) {
    const results = [];
    for (const p of paths || []) {
      const check = isSafeToEat(p);
      if (!check.ok) {
        stats.failed++;
        results.push({ path: p, ok: false, why: check.why });
        continue;
      }
      try {
        if (getMode() === 'delete') {
          fs.rmSync(check.abs, { force: true });
          journal({ action: 'delete', file: check.abs, size: check.size });
          results.push({ path: check.abs, ok: true, mode: 'delete', size: check.size });
        } else {
          fs.mkdirSync(quarantineDir(), { recursive: true });
          const dest = uniqueDest(path.basename(check.abs));
          try {
            fs.renameSync(check.abs, dest);
          } catch (e) {
            if (e && e.code === 'EXDEV') {
              fs.copyFileSync(check.abs, dest);
              fs.rmSync(check.abs, { force: true });
            } else throw e;
          }
          journal({ action: 'quarantine', file: check.abs, stored: dest, size: check.size });
          results.push({ path: check.abs, ok: true, mode: 'quarantine', stored: dest, size: check.size });
        }
        stats.eaten++;
        stats.bytes += check.size || 0;
      } catch (e) {
        stats.failed++;
        results.push({ path: check.abs, ok: false, why: String((e && e.message) || e) });
      }
    }
    return { results, stats, quarantine: quarantineDir() };
  }

  return { isSafeToEat, devourPaths, forbiddenPrefixes, stats };
}

module.exports = { createDevourer, SYSTEM_PREFIXES };
