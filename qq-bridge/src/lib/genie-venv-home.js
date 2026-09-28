/**
 * venv 的 pyvenv.cfg 运行期纠正 —— 配合"包里自带 Python 运行时"。
 *
 * 【2026-09-28 使用方决定】安装包自带一份 Python 运行时（`<引擎根>\runtime\`），于是引擎的 venv
 * 指向它，而不是目标机上有没有 Python。但 venv 有个天生的问题：`pyvenv.cfg` 里的 `home`
 * **必须是绝对路径**（`Scripts\python.exe` 是 base 解释器的副本，要靠 `home` 找到 `python313.dll`
 * 与 stdlib）。实测两条：① 把 `home` 改成一个不存在的目录，解释器直接 `exit=103`
 * （`did not find executable at '<home>\python.exe'`）；② 写成相对路径（`..\runtime`）同样不行
 * —— CPython 按**当前工作目录**解析它，不是按 pyvenv.cfg 所在目录。
 *
 * 而绝对路径又必然是"构建机/安装机"的路径。于是口径定成：
 *   · 包里带的是**相对占位**（`home = ..\runtime`）—— 这样安装包里**一个字都不含构建机用户名路径**；
 *   · 任何要使用这个解释器的地方，**用之前**先调 `ensureVenvHome()` 按当前引擎根把它纠正成绝对路径。
 * 纠正本身是幂等的（已经是正确绝对路径就一个字节都不写），并且**只在 `<引擎根>\runtime\python.exe`
 * 存在时**才动手 —— 使用方本机现网那份没有 runtime 目录的老 venv 因此完全不受影响（向后兼容）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 包里带出去的占位值（相对 `.venv` 目录，但 CPython 不认，只作"待纠正"标记）。 */
export const VENV_HOME_PLACEHOLDER = '..\\runtime';

/** 内置运行时的解释器（存在才说明这是"自带运行时"的新布局）。 */
export function runtimePythonOf(rootDir) {
  return path.join(rootDir, 'runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python');
}

/**
 * 确保 `<rootDir>\.venv\pyvenv.cfg` 的 `home` / `executable` 指向 `<rootDir>\runtime`。
 * @returns {{changed:boolean, skipped?:string, home?:string, error?:string}}
 *   skipped: 'no-runtime'（老布局，不动）| 'no-cfg'（没有 venv）| 'read-failed' | 'write-failed'
 */
export function ensureVenvHome(rootDir, { log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  const runtimeExe = runtimePythonOf(rootDir);
  if (!fs.existsSync(runtimeExe)) return { changed: false, skipped: 'no-runtime' };
  const cfgFile = path.join(rootDir, '.venv', 'pyvenv.cfg');
  if (!fs.existsSync(cfgFile)) return { changed: false, skipped: 'no-cfg' };

  let text = '';
  try { text = fs.readFileSync(cfgFile, 'utf8'); } catch (e) {
    const error = e?.message ?? String(e);
    say(`venv 的 pyvenv.cfg 读不出来（引擎可能起不来）：${cfgFile} → ${error}`);
    return { changed: false, skipped: 'read-failed', error };
  }

  const want = path.resolve(rootDir, 'runtime');
  const venvDir = path.join(rootDir, '.venv');
  const readKey = (k) => {
    const m = new RegExp(`^${k}\\s*=\\s*(.*)$`, 'm').exec(text);
    return m ? m[1].trim() : '';
  };
  const home = readKey('home');
  const exe = readKey('executable');
  const wantExe = path.join(want, path.basename(runtimeExe));
  /* 判据必须排除**相对**值：`..\runtime`（包里带出去的占位）解析出来虽然是同一个目录，
   * 但 CPython 是按**当前工作目录**解析它的（实测 `exit=103 did not find executable at 'runtime\python.exe'`），
   * 所以"相对 → 目录对"照样要改写成绝对路径。 */
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const homeOk = home !== '' && path.isAbsolute(home) && same(path.resolve(home), want);
  const exeOk = exe !== '' && path.isAbsolute(exe) && same(path.resolve(exe), wantExe);
  if (homeOk && exeOk) return { changed: false, home: want };

  const keep = {
    include: readKey('include-system-site-packages') || 'false',
    version: readKey('version'),
  };
  const body = [
    `home = ${want}`,
    `include-system-site-packages = ${keep.include}`,
    ...(keep.version ? [`version = ${keep.version}`] : []),
    `executable = ${wantExe}`,
    /* 不保留 `command`：那是 venv 创建时的命令行，天生带"创建者的绝对路径"，
     * 对运行毫无用处，留着只是把构建机的用户名路径又带回去。 */
  ].join('\r\n') + '\r\n';
  try {
    fs.writeFileSync(cfgFile, body, 'utf8');
  } catch (e) {
    const error = e?.message ?? String(e);
    say(`venv 的 pyvenv.cfg 写不进去（引擎可能起不来）：${cfgFile} → ${error}`);
    return { changed: false, skipped: 'write-failed', error };
  }
  return { changed: true, home: want };
}

export default { ensureVenvHome, runtimePythonOf, VENV_HOME_PLACEHOLDER };
