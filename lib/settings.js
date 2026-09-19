'use strict';

/**
 * 设置存档的版本与迁移。
 *
 * 为什么需要：`settings.json` 会覆盖代码里的默认值。
 * 一旦改了某个默认值（比如把默认体型从「中」改成「小」），
 * 老用户机器上的存档会把它原样压回去 —— 改了半天没生效，还以为改错了。
 * 所以每次动默认值都要 +1 版本，并在这里声明哪些键强制拉回新默认。
 */

const SETTINGS_VERSION = 2;

/**
 * 每个版本「强制拉回默认值」的键。
 * 只用于那些「老存档里的值多半只是当年的默认值、不是用户刻意挑的」的项。
 * 用户明确选过的偏好（比如 eatMode）不要放进来。
 */
const MIGRATIONS = {
  // v1 → v2：默认体型 中→小，泛光整体收了一半，新增鼠标穿透开关
  2: ['size', 'lensRadius', 'glow', 'interactive'],
};

/**
 * @param {object} raw       磁盘上读到的原始设置（可能为 null / 缺 v）
 * @param {object} defaults  当前默认值
 * @param {number} version   目标版本
 */
function migrateSettings(raw, defaults, version = SETTINGS_VERSION) {
  const from = Number(raw && raw.v) || 1;
  const out = { ...defaults, ...(raw || {}) };

  for (let v = from + 1; v <= version; v++) {
    for (const key of MIGRATIONS[v] || []) {
      if (key in defaults) out[key] = defaults[key];
    }
  }

  out.v = version;
  return out;
}

module.exports = { migrateSettings, SETTINGS_VERSION, MIGRATIONS };
