'use strict';

/**
 * 吞噬安全逻辑的回归测试 —— 纯 Node，不需要 Electron：
 *
 *     node --test scripts/
 *     node scripts/test-devour.js
 *
 * 这是全项目唯一会把用户文件搬走/删掉的地方，必须每次都跑一遍。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createDevourer } = require('../lib/devour');

/**
 * 造一个完全隔离的沙盒：临时根目录 + 假主目录 + 假数据目录
 *
 * 注意不能直接用 os.tmpdir()：macOS 上它在 /private/var 下面，
 * 而 /private 属于受保护路径，所有用例都会因为「受保护路径」被拒，
 * 测的就变成黑名单而不是吞噬逻辑了。
 */
const TEST_ROOT = path.join(__dirname, '..', '.test-tmp');

function sandbox(mode = 'quarantine') {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(TEST_ROOT, 'bh-'));
  const home = path.join(root, 'home');
  const petDir = path.join(home, 'BlackHolePet');
  const quarantine = path.join(petDir, 'eaten');
  const journal = path.join(petDir, 'journal.jsonl');
  fs.mkdirSync(home, { recursive: true });

  const d = createDevourer({
    home,
    petDir: () => petDir,
    quarantineDir: () => quarantine,
    journalFile: () => journal,
    getMode: () => mode,
  });
  const file = (name, body = 'x') => {
    const p = path.join(root, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  return { root, home, petDir, quarantine, journal, d, file, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('普通文件 → 移入隔离区，原文件消失、内容完好', () => {
  const s = sandbox();
  try {
    const f = s.file('docs/report.md', 'hello black hole');
    const res = s.d.results === undefined ? s.d.devourPaths([f]) : null;

    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].ok, true, JSON.stringify(res.results[0]));
    assert.equal(res.results[0].mode, 'quarantine');
    assert.equal(fs.existsSync(f), false, '原文件应该已被移走');
    assert.ok(fs.existsSync(res.results[0].stored), '隔离区里应该有它');
    assert.equal(fs.readFileSync(res.results[0].stored, 'utf8'), 'hello black hole');
    assert.equal(res.stats.eaten, 1);
    assert.equal(res.stats.bytes, 'hello black hole'.length);
  } finally { s.cleanup(); }
});

test('永久删除模式 → 文件真的没了', () => {
  const s = sandbox('delete');
  try {
    const f = s.file('trash.txt');
    const res = s.d.devourPaths([f]);
    assert.equal(res.results[0].ok, true);
    assert.equal(res.results[0].mode, 'delete');
    assert.equal(fs.existsSync(f), false);
    assert.equal(fs.existsSync(s.quarantine), false, '删除模式不该建隔离区');
  } finally { s.cleanup(); }
});

test('拒绝：目录', () => {
  const s = sandbox();
  try {
    const dir = path.join(s.root, 'a-folder');
    fs.mkdirSync(dir);
    const res = s.d.devourPaths([dir]);
    assert.equal(res.results[0].ok, false);
    assert.match(res.results[0].why, /目录/);
    assert.ok(fs.existsSync(dir), '目录必须原地不动');
    assert.equal(res.stats.failed, 1);
  } finally { s.cleanup(); }
});

test('拒绝：符号链接（而且不能顺着链接删掉目标）', () => {
  const s = sandbox();
  try {
    const target = s.file('real.txt', 'precious');
    const link = path.join(s.root, 'link.txt');
    fs.symlinkSync(target, link);
    const res = s.d.devourPaths([link]);
    assert.equal(res.results[0].ok, false);
    assert.match(res.results[0].why, /符号链接/);
    assert.ok(fs.existsSync(link), '链接本身要还在');
    assert.ok(fs.existsSync(target), '链接指向的文件更不能被删');
  } finally { s.cleanup(); }
});

test('拒绝：系统路径 /System/...', () => {
  const s = sandbox();
  try {
    const target = '/System/Library/CoreServices/SystemVersion.plist';
    if (!fs.existsSync(target)) return;         // 非 macOS 就跳过
    const res = s.d.devourPaths([target]);
    assert.equal(res.results[0].ok, false);
    assert.match(res.results[0].why, /受保护路径/);
    assert.ok(fs.existsSync(target));
  } finally { s.cleanup(); }
});

test('拒绝：主目录本身 / 数据目录本身', () => {
  const s = sandbox();
  try {
    for (const p of [s.home, s.petDir]) {
      const res = s.d.devourPaths([p]);
      assert.equal(res.results[0].ok, false, `${p} 不该被吞`);
    }
    assert.ok(fs.existsSync(s.home));
  } finally { s.cleanup(); }
});

test('拒绝：不存在的路径 / 空路径 / 非字符串', () => {
  const s = sandbox();
  try {
    const res = s.d.devourPaths([path.join(s.root, 'nope.txt'), '', null, 42]);
    assert.equal(res.results.length, 4);
    for (const r of res.results) assert.equal(r.ok, false);
    assert.equal(res.stats.eaten, 0);
    assert.equal(res.stats.failed, 4);
  } finally { s.cleanup(); }
});

test('拒绝：不能自己吃自己（隔离区 / 数据目录里的文件）', () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.quarantine, { recursive: true });
    const inside = path.join(s.quarantine, 'already.txt');
    fs.writeFileSync(inside, 'x');
    const res = s.d.devourPaths([inside]);
    assert.equal(res.results[0].ok, false);
    // petDir() 的黑名单会先命中，所以理由可能是「受保护路径」或「隔离区」
    assert.match(res.results[0].why, /隔离区|受保护路径/);
    assert.ok(fs.existsSync(inside), '隔离区里的文件必须原地不动');
  } finally { s.cleanup(); }
});

test('隔离区若被放到数据目录之外，单独的隔离区检查仍然生效', () => {
  // 覆盖 isSafeToEat 里那条「已经躺在隔离区里」的分支
  const root = fs.mkdtempSync(path.join(TEST_ROOT, 'bh-outside-'));
  try {
    const outside = path.join(root, 'quarantine');
    fs.mkdirSync(outside, { recursive: true });
    const f = path.join(outside, 'x.txt');
    fs.writeFileSync(f, 'x');

    const d = createDevourer({
      home: path.join(root, 'home'),
      petDir: () => path.join(root, 'data'),
      quarantineDir: () => outside,
      journalFile: () => path.join(root, 'data', 'journal.jsonl'),
      getMode: () => 'quarantine',
    });
    const res = d.devourPaths([f]);
    assert.equal(res.results[0].ok, false);
    assert.match(res.results[0].why, /已经在隔离区里了/);
    assert.ok(fs.existsSync(f));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('重名文件不会互相覆盖', () => {
  const s = sandbox();
  try {
    const a = s.file('one/same.txt', 'first');
    const res1 = s.d.devourPaths([a]);
    const b = s.file('two/same.txt', 'second');
    const res2 = s.d.devourPaths([b]);

    assert.notEqual(res1.results[0].stored, res2.results[0].stored, '两个目标路径必须不同');
    assert.equal(fs.readFileSync(res1.results[0].stored, 'utf8'), 'first');
    assert.equal(fs.readFileSync(res2.results[0].stored, 'utf8'), 'second');
    assert.equal(fs.readdirSync(s.quarantine).length, 2);
  } finally { s.cleanup(); }
});

test('流水账 journal.jsonl 记下了每一次动作', () => {
  const s = sandbox();
  try {
    const f = s.file('notes.txt', 'abcd');
    s.d.devourPaths([f]);
    const lines = fs.readFileSync(s.journal, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.file, f);
    assert.equal(entry.size, 4);
    assert.ok(entry.at);
  } finally { s.cleanup(); }
});

test('一次投喂多个：好的进去、坏的留下，互不影响', () => {
  const s = sandbox();
  try {
    const good1 = s.file('g1.txt');
    const good2 = s.file('g2.txt');
    const bad = path.join(s.root, 'dir');
    fs.mkdirSync(bad);

    const res = s.d.devourPaths([good1, bad, good2]);
    assert.deepEqual(res.results.map((r) => r.ok), [true, false, true]);
    assert.equal(fs.existsSync(good1), false);
    assert.equal(fs.existsSync(good2), false);
    assert.ok(fs.existsSync(bad));
    assert.equal(res.stats.eaten, 2);
    assert.equal(res.stats.failed, 1);
  } finally { s.cleanup(); }
});

test('返回的隔离区路径就是实际用的那个', () => {
  const s = sandbox();
  try {
    const res = s.d.devourPaths([s.file('x.txt')]);
    assert.equal(res.quarantine, s.quarantine);
  } finally { s.cleanup(); }
});
