#!/usr/bin/env node
// 人设剪枝体检（2026-10-28）：扫 DSH 会话日志，数「【persona_load】原始副本」与「ephemeral_turn_pruned 占位」。
// 为什么要它：旧 turn-pruner 走的是 DSH 0.1.x 的 session_*.json，0.2.x 永远 resolve 不到，
// 剪枝静默失效、零日志，直到翻日志才发现整张角色卡被复制了一百多份。
// 用法：node tools/check-persona-bloat.mjs [--home /root/.dsh] [--json]
// 退出码：0 正常；1 有会话出现「多份原始人设、零占位」（剪枝没跑）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const argOf = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : def; };
const HOME = argOf('--home', process.env.QQB_DSH_HOME || (process.platform === 'win32' ? 'C:/Users/17367/.dsh' : '/root/.dsh'));
const asJson = argv.includes('--json');
const SESS = path.join(HOME, 'sessions');

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p);
  }
  return out;
}

const files = walk(SESS);
const rows = [];
let totalCopies = 0;
let totalStubs = 0;
for (const f of files) {
  let txt = '';
  try { txt = execFileSync('zstd', ['-dc', f], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8'); } catch { continue; }
  const copies = (txt.match(/【persona_load】/g) || []).length;
  const stubs = (txt.match(/ephemeral_turn_pruned/g) || []).length;
  if (!copies && !stubs) continue;
  totalCopies += copies;
  totalStubs += stubs;
  rows.push({ session: path.basename(path.dirname(f)), copies, stubs, bytes: txt.length });
}

const bad = rows.filter((r) => r.copies > 2 && r.stubs === 0);
if (asJson) {
  console.log(JSON.stringify({ home: HOME, sessions: rows.length, totalCopies, totalStubs, bad: bad.map((b) => b.session) }, null, 2));
} else {
  console.log('人设剪枝体检  home=' + HOME);
  console.log('有记录的会话: ' + rows.length + '  原始人设副本: ' + totalCopies + '  已剪占位: ' + totalStubs);
  for (const r of rows.slice().sort((a, b) => b.copies - a.copies).slice(0, 8)) {
    console.log('  ' + r.session.slice(0, 20) + '… copies=' + r.copies + ' stubs=' + r.stubs + ' bytes=' + r.bytes);
  }
  console.log(bad.length ? '!! 剪枝可能没跑：' + bad.length + ' 个会话多份人设却零占位' : 'OK：没有「多份人设、零占位」的会话');
}
process.exitCode = bad.length ? 1 : 0;
