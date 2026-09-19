'use strict';

/**
 * 设置迁移的回归测试（纯 Node）：
 *
 *     node --test scripts/
 *
 * 守的是这类事故：改了默认值 → 老存档把新默认值压回去 → 用户以为没生效。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { migrateSettings, SETTINGS_VERSION } = require('../lib/settings');

const DEFAULTS = {
  size: 'small',
  lensRadius: 9,
  glow: 0.45,
  interactive: true,
  eatMode: 'quarantine',
  hud: true,
};

test('没有存档 → 全用当前默认值，并写入版本号', () => {
  const s = migrateSettings(null, DEFAULTS);
  assert.equal(s.size, 'small');
  assert.equal(s.glow, 0.45);
  assert.equal(s.v, SETTINGS_VERSION);
});

test('空对象存档 → 同上', () => {
  const s = migrateSettings({}, DEFAULTS);
  assert.equal(s.size, 'small');
  assert.equal(s.v, SETTINGS_VERSION);
});

test('v1 老存档里的旧默认体型/泛光会被拉回新默认值', () => {
  // 这是真实踩过的坑：老存档写着 medium，改了默认值也不生效
  const old = { size: 'medium', lensRadius: 12, glow: 1, interactive: true, v: 1 };
  const s = migrateSettings(old, DEFAULTS);
  assert.equal(s.size, 'small', '体型必须被迁移到新默认值');
  assert.equal(s.lensRadius, 9);
  assert.equal(s.glow, 0.45);
  assert.equal(s.v, SETTINGS_VERSION);
});

test('迁移不会碰用户明确选过的偏好', () => {
  const old = { size: 'large', eatMode: 'delete', hud: false, v: 1 };
  const s = migrateSettings(old, DEFAULTS);
  assert.equal(s.size, 'small', 'size 在迁移名单里，会被重置');
  assert.equal(s.eatMode, 'delete', 'eatMode 不在迁移名单里，必须保留');
  assert.equal(s.hud, false, 'hud 不在迁移名单里，必须保留');
});

test('已经是当前版本的存档原样保留（用户后来自己改的尺寸不能再被重置）', () => {
  const cur = { size: 'large', lensRadius: 12, glow: 1.6, interactive: false, v: SETTINGS_VERSION };
  const s = migrateSettings(cur, DEFAULTS);
  assert.equal(s.size, 'large');
  assert.equal(s.lensRadius, 12);
  assert.equal(s.glow, 1.6);
  assert.equal(s.interactive, false);
});

test('缺 v 字段的老存档按 v1 处理', () => {
  const s = migrateSettings({ size: 'medium', glow: 1 }, DEFAULTS);
  assert.equal(s.size, 'small');
  assert.equal(s.glow, 0.45);
});

test('未知字段原样带过，不会被吃掉', () => {
  const s = migrateSettings({ size: 'small', myCustomThing: 42, v: SETTINGS_VERSION }, DEFAULTS);
  assert.equal(s.myCustomThing, 42);
});

test('迁移是幂等的', () => {
  const once = migrateSettings({ size: 'medium', glow: 1, v: 1 }, DEFAULTS);
  const twice = migrateSettings(once, DEFAULTS);
  assert.deepEqual(twice, once);
});

test('目标版本高于当前时不会误伤（未来版本回滚的场景）', () => {
  const future = { size: 'tiny', v: SETTINGS_VERSION + 5 };
  const s = migrateSettings(future, DEFAULTS);
  assert.equal(s.size, 'tiny', '未来存档不该被当老存档重置');
  assert.equal(s.v, SETTINGS_VERSION, '但版本号会被写回当前值');
});
