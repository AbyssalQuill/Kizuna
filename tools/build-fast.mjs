import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

console.log('[1/2] 正在极速编译前端 (Vite Build)...');
const t0 = Date.now();

// 执行 vite build（关闭无用的 sourcemap，极速生成）
const res = spawnSync('npx.cmd', ['vite', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  windowsHide: true,
  env: { ...process.env, VITE_SOURCEMAP: 'false' },
});

if (res.status !== 0) {
  console.error('前端编译失败，退出码:', res.status);
  process.exit(res.status || 1);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[2/2] 编译完成，耗时 ${elapsed}s。正在同步产物到运行时...`);

const distSrc = path.join(root, 'dist');
const liveRuntimeDist = 'D:\\Kizuna\\resources\\runtime\\dist';

if (fs.existsSync(distSrc) && fs.existsSync(path.dirname(liveRuntimeDist))) {
  if (!fs.existsSync(liveRuntimeDist)) {
    fs.mkdirSync(liveRuntimeDist, { recursive: true });
  }
  fs.cpSync(distSrc, liveRuntimeDist, { recursive: true, force: true });
  console.log(`已成功同步产物至: ${liveRuntimeDist}`);
}

console.log('前端极速重建完毕！');
