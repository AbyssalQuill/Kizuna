#!/usr/bin/env python3
"""本地语音合成 sidecar（Genie / GPT-SoVITS ONNX 引擎）—— 2026-09-28 新增

它是什么：把上游 High-Logic/Genie-TTS（MIT，CPU-only 的 GPT-SoVITS ONNX 推理引擎）
包成桥能用的一个本地 HTTP 服务，只监听 127.0.0.1，不做任何鉴权以外的事。

为什么是 sidecar 而不是把 Python 塞进 Node：
  · 引擎的文本前端全在 Python 生态里（pyopenjtalk-plus / pypinyin / g2pM / jieba_fast / g2pk2），
    移植到 Node 等于重写整个 G2P，不划算；
  · 独立进程能被桥随时拉起/关掉（空闲回收内存），崩了也不影响桥；
  · 模型常驻在同一个进程里，第二次之后的合成就没有加载开销。

接口（全部 127.0.0.1）：
  GET  /health      → {ok, rssMb, genieVersion, dataDir, modelsDir, characters, loaded, language}
  GET  /characters  → {ok, characters:[{name, label, language, loaded}]}（label 来自角色目录里的
                      character.json，可选；界面下拉用它显示中文名）
  POST /load        → {character, model_dir?, language?}  加载角色（幂等）
  POST /tts         → {character, text, language?, reference_audio?, reference_text?, format?}
                      返回音频字节（默认 audio/wav，32kHz 单声道 16bit —— 引擎原生输出）
  POST /unload      → {character?}  卸载角色并 gc
  POST /shutdown    → 进程退出（桥空闲回收时用）

被谁启动：`qq-bridge/src/lib/genie-tts.js`（ensureServer），参数见 `--help`。
装引擎/下模型用 `node tools/genie-setup.mjs`，本文件自己不做安装。
"""
from __future__ import annotations

import argparse
import ctypes
import gc
import io
import json
import os
import sys
import tempfile
import threading
import time

# ── 依赖：只用 genie-tts 自带的 fastapi/uvicorn，不引入额外包 ──────────────────
try:
    import uvicorn
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import JSONResponse, Response
except Exception as exc:  # pragma: no cover - 装错环境时给人话
    sys.stderr.write(
        "缺少 fastapi/uvicorn —— 请先在 venv 里 `pip install genie-tts`（或用 node tools/genie-setup.mjs --install）\n"
        f"原始错误：{exc}\n"
    )
    raise SystemExit(3)

ARGS = None
STATE = {
    "loaded": {},          # character -> {"language": str, "modelDir": str, "reference": str}
    "lock": threading.Lock(),
    "lastUse": time.time(),
    "bootMs": None,
    "genie": None,
    "genieError": None,
    "jiebaShim": None,
}


# ── 内存读数（回答"到底吃多少内存"这个问题，健康检查里直接透出） ───────────────
class _PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def _win_mem_prototypes():
    """Windows 下把 psapi 的函数原型焊死（理由见 rss_mb）。非 Windows 返回 (None, None)。"""
    if not sys.platform.startswith("win"):
        return None, None
    try:
        import ctypes.wintypes as wt
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.GetCurrentProcess.argtypes = []
        k32.GetCurrentProcess.restype = wt.HANDLE
        psapi = ctypes.WinDLL("psapi", use_last_error=True).GetProcessMemoryInfo
        psapi.argtypes = [wt.HANDLE, ctypes.POINTER(_PROCESS_MEMORY_COUNTERS), wt.DWORD]
        psapi.restype = wt.BOOL
        return k32, psapi
    except Exception:
        return None, None


_K32, _PSAPI = _win_mem_prototypes()


def rss_mb():
    """当前进程常驻内存（MB）。Linux 读 /proc，Windows 读 psapi；读不到就回 None。"""
    try:
        if sys.platform.startswith("linux"):
            with open("/proc/self/status", "r", encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith("VmRSS:"):
                        return round(int(line.split()[1]) / 1024.0, 1)
            return None
        if sys.platform.startswith("win"):
            # 必须显式给 argtypes/restype 并 use_last_error：ctypes 默认把返回值当 c_int，
            # 64 位下 HANDLE 会被截断、结构体指针也会按错误原型传递 —— 表现是
            # `GetProcessMemoryInfo` 返回 0（失败），于是内存读数静默变成 None（2026-09-28 实测踩到）。
            if _PSAPI is None:
                return None
            handle = _K32.GetCurrentProcess()
            counters = _PROCESS_MEMORY_COUNTERS()
            counters.cb = ctypes.sizeof(_PROCESS_MEMORY_COUNTERS)
            if _PSAPI(handle, ctypes.byref(counters), counters.cb):
                return round(counters.WorkingSetSize / 1048576.0, 1)
        return None
    except Exception:
        return None


# ── 引擎 ─────────────────────────────────────────────────────────────────────
def genie_module():
    """惰性导入 genie_tts：装错环境时服务仍能起来并如实报告原因。"""
    if STATE["genie"] is not None:
        return STATE["genie"]
    if STATE["genieError"]:
        raise RuntimeError(STATE["genieError"])
    try:
        if ARGS.data_dir:
            os.environ["GENIE_DATA_DIR"] = ARGS.data_dir
        # 数据目录必须先存在再 import：上游 Core/Resources.py 在目录不存在时会 `input()` 问
        # "要不要自动下载"，而 sidecar 的 stdin 是空管道 —— 那里会炸成 EOFError，把一个
        # "还没下载数据"的普通状态报成莫名其妙的导入失败。这里提前给一句能照做的人话。
        if ARGS.data_dir and not os.path.isdir(ARGS.data_dir):
            raise RuntimeError(
                f"引擎公共数据不在：{ARGS.data_dir}（先跑 node tools/genie-setup.mjs --download，约 391MB）"
            )
        # 先上兼容垫：上游硬依赖 jieba_fast（PyPI 上只有源码包，没 C 编译器就装不上），
        # 而它只是 jieba 的加速分支、API 完全一致 —— 缺了就顶上纯 jieba，别让整个引擎装不下去。
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            from genie_compat import install_jieba_fast_shim, shim_state  # noqa: WPS433
            install_jieba_fast_shim()
            STATE["jiebaShim"] = shim_state()
        except Exception as exc:  # 垫子本身出问题也不能挡住引擎
            STATE["jiebaShim"] = {"installed": False, "reason": f"兼容垫加载失败：{exc}"}
        import genie_tts  # noqa: WPS433  必须在设置 GENIE_DATA_DIR 之后导入
        STATE["genie"] = genie_tts
        return genie_tts
    except Exception as exc:
        STATE["genieError"] = f"导入 genie_tts 失败：{exc}"
        raise RuntimeError(STATE["genieError"])


def list_characters():
    out = []
    models_dir = ARGS.models_dir
    if models_dir and os.path.isdir(models_dir):
        for entry in sorted(os.listdir(models_dir)):
            full = os.path.join(models_dir, entry)
            if not os.path.isdir(full):
                continue
            has_onnx = any(name.endswith(".onnx") for name in os.listdir(full))
            if not has_onnx:
                # 允许 角色/tts_models/*.onnx 这种两级布局（Genie 上游整合包就是这结构）
                sub = os.path.join(full, "tts_models")
                has_onnx = os.path.isdir(sub) and any(n.endswith(".onnx") for n in os.listdir(sub))
            if not has_onnx:
                continue
            rec = STATE["loaded"].get(entry)
            meta = character_meta(full)
            out.append({
                "name": entry,
                "label": meta.get("label") or "",
                "language": (rec or {}).get("language") or guess_language(entry),
                "loaded": entry in STATE["loaded"],
                "loadedFrom": (rec or {}).get("modelDir") or full,
            })
    return out


def character_meta(model_dir):
    """角色目录里可选的 character.json：{"label": "未花（日语）", "language": "jp", "source": "..."}。
    为什么需要它：语言必须准（未花是日语角色，而 guess_language 从目录名 'mika' 里读不出任何线索，
    会退回默认的 zh，合成出来是错的），但目录名要出现在界面下拉里，写成 jp_mika 又难看 ——
    所以语言/显示名放在目录里的一个 json 里，目录名保持干净。装角色时由 tools/genie-setup.mjs 写入。"""
    try:
        with open(os.path.join(model_dir, "character.json"), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def guess_language(name):
    """语言线索：先看角色目录里的 character.json，再看目录名（上游整合包会写 zh_/jp_/en_/kr_）—— 猜不到就回默认值。"""
    meta = character_meta(os.path.join(ARGS.models_dir or "", str(name)))
    if meta.get("language") in ("zh", "jp", "en", "kr"):
        return meta["language"]
    low = str(name).lower()
    for key, lang in (("zh", "zh"), ("cn", "zh"), ("jp", "jp"), ("ja", "jp"), ("en", "en"), ("kr", "kr"), ("ko", "kr")):
        if key in low:
            return lang
    return ARGS.language or "zh"


def model_dir_of(character):
    if os.path.isabs(character) and os.path.isdir(character):
        return character
    base = os.path.join(ARGS.models_dir or "", character)
    if os.path.isdir(os.path.join(base, "tts_models")):
        return os.path.join(base, "tts_models")
    if os.path.isdir(base):
        return base
    return None


def do_load(character, language=None, model_dir=None):
    genie = genie_module()
    rec = STATE["loaded"].get(character)
    if rec:
        return rec
    resolved = model_dir or model_dir_of(character)
    if not resolved:
        raise FileNotFoundError(
            f"找不到角色模型目录：{character}（在 {ARGS.models_dir} 下没有这个角色，也没有 tts_models 子目录）"
        )
    # 角色自带的语言声明优先于请求里的默认语言：桥那边每条 /tts 都会带上配置里的默认语言（通常是 zh），
    # 要是照单全收，日语角色（未花）就会被按中文合成 —— 文本前端走错语言，出来是废音。
    # 所以只认角色目录里 character.json 声明的语言，没有声明才用请求里的。
    meta_lang = character_meta(os.path.join(ARGS.models_dir or "", character)).get("language")
    lang = meta_lang if meta_lang in ("zh", "jp", "en", "kr") else (language or guess_language(character))
    t0 = time.time()
    genie.load_character(character_name=character, onnx_model_dir=resolved, language=lang)
    # 判据不能用返回值：上游这次调用**成功也返回 None**（2026-09-28 实测：加载成功、日志里明写
    # "Character Feibi loaded successfully / Model Type: V2ProPlus"，返回值是 None），老代码
    # `if not ok: raise` 于是把每一次成功都报成"load_character 返回 False"——引擎一个角色都合不出来。
    # 反过来，真正的失败（onnxruntime 建会话炸了）会被上游**吞掉**成一行 logger.error，不抛异常，
    # 所以也不能只看有没有抛。可靠判据只有一个：模型有没有进 manager 的注册表。
    try:
        from genie_tts.ModelManager import model_manager as _mm
        registered = character.lower() in getattr(_mm, "character_to_model", {})
    except Exception:
        registered = True   # 拿不到注册表就不拦（宁可放过，别把能用的引擎挡在门外）
    if not registered:
        raise RuntimeError(
            f"角色 {character} 的模型没能加载（目录={resolved}）——看引擎日志里 genie_tts.ModelManager 的 Error 行"
        )
    rec = {"language": lang, "modelDir": resolved, "reference": "", "loadMs": round((time.time() - t0) * 1000)}
    STATE["loaded"][character] = rec
    # 角色自带的参考音频先挂上：不挂的话纯内置角色一句都合不出来（原因见 default_reference 的注释）。
    # 挂失败不拦（还能走 clone：桥传样本时会用样本覆盖掉它）。
    ref = default_reference(character)
    if ref:
        try:
            do_reference(character, ref[0], ref[1])
        except Exception as exc:
            sys.stderr.write(f"[genie] 角色 {character} 的默认参考音频没挂上：{exc}\n")
    return rec


def default_reference(character):
    """角色自带的默认参考音频（上游预置角色目录里的 prompt_wav.json + prompt_wav/*.wav）。
    为什么必须有这一段：GPT-SoVITS 合成**必须挂一段参考音频**，没挂时上游 `tts()` 取
    `_reference_audios[character_name]` 会直接 KeyError，而那个异常被吞在回调里 —— 现象是
    "引擎没有产出音频文件"（2026-09-28 实测：角色能加载、能报 loaded successfully，一句也合不出来）。
    以前只有 clone 模式（桥传了样本）才设参考音频，纯内置角色因此从没成功过一次。"""
    base = os.path.join(ARGS.models_dir or "", character)
    try:
        with open(os.path.join(base, "prompt_wav.json"), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return None
        item = data.get("Normal") or next(iter(data.values()), {})
        wav = str((item or {}).get("wav") or "").strip()
        text = str((item or {}).get("text") or "")
        if not wav:
            return None
        for cand in (os.path.join(base, "prompt_wav", wav), os.path.join(base, wav)):
            if os.path.isfile(cand):
                return cand, text
    except Exception:
        return None
    return None


def do_reference(character, reference_audio, reference_text=""):
    """参考音频 = 情感/语调锚点（桥那边「音色复刻」的样本就走这里）。"""
    rec = STATE["loaded"].get(character)
    if not rec:
        raise RuntimeError(f"角色 {character} 还没加载")
    if not reference_audio:
        return rec
    if rec.get("reference") == reference_audio:
        return rec
    genie = genie_module()
    if not os.path.isfile(reference_audio):
        raise FileNotFoundError(f"参考音频不存在：{reference_audio}")
    t0 = time.time()
    genie.set_reference_audio(character_name=character, audio_path=reference_audio, audio_text=reference_text or "")
    rec["reference"] = reference_audio
    rec["referenceMs"] = round((time.time() - t0) * 1000)
    return rec


app = FastAPI(title="kizuna-genie-tts", docs_url=None, redoc_url=None)


@app.get("/health")
def health():
    # 先把引擎拉起来再报：这个端点是"引擎到底能不能用"的答案，顺带让内存读数包含
    # onnxruntime / tokenizers / 文本前端这些真实占用（否则第一个数只有十几 MB，没意义）。
    version = None
    try:
        genie = genie_module()
        version = getattr(genie, "__version__", None)
        if not version:
            try:
                from importlib.metadata import version as _pkg_version
                version = _pkg_version("genie-tts")
            except Exception:
                version = "unknown"
    except Exception as exc:
        STATE["genieError"] = str(exc)
    info = {
        # 身份标识：外部进程（比如上一次桥崩了留下的引擎、或别人手工拉起的）在接受
        # `/shutdown` 之前必须先证明"这个端口上确实是本引擎"，不能见 /health 就关。
        "service": "kizuna-genie-tts",
        "ok": version is not None,
        "rssMb": rss_mb(),
        "pid": os.getpid(),
        "dataDir": ARGS.data_dir,
        "modelsDir": ARGS.models_dir,
        "defaultLanguage": ARGS.language,
        "seedCharacter": ARGS.character or "",
        "bootMs": STATE["bootMs"],
        "uptimeSec": round(time.time() - STATE["lastUse"], 1),
        "loaded": [{"name": k, **v} for k, v in STATE["loaded"].items()],
        "characters": list_characters(),
        "genieVersion": version,
        "genieError": STATE["genieError"],
        "jiebaShim": STATE.get("jiebaShim"),
        # 已加载角色模型的缓存上限（上游默认 3）：想知道"内存为什么涨"时先看这个。
        "maxCachedModels": os.environ.get("Max_Cached_Character_Models", "3"),
    }
    return JSONResponse(info)


@app.get("/characters")
def characters():
    return {"ok": True, "characters": list_characters()}


@app.post("/load")
def load(payload: dict):
    character = str(payload.get("character") or "").strip()
    if not character:
        raise HTTPException(status_code=400, detail="character 不能为空")
    try:
        with STATE["lock"]:
            rec = do_load(character, payload.get("language"), payload.get("model_dir"))
        return {"ok": True, "character": character, **rec, "rssMb": rss_mb()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


@app.post("/tts")
def tts(payload: dict):
    character = str(payload.get("character") or "").strip()
    text = str(payload.get("text") or "").strip()
    if not character:
        raise HTTPException(status_code=400, detail="character 不能为空")
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")
    reference_audio = str(payload.get("reference_audio") or "").strip()
    reference_text = str(payload.get("reference_text") or "")
    fmt = str(payload.get("format") or "wav").lower()
    if fmt not in ("wav", "mp3", "ogg", "flac", "aac"):
        fmt = "wav"
    t0 = time.time()
    try:
        with STATE["lock"]:
            do_load(character, payload.get("language"))
            do_reference(character, reference_audio, reference_text)
            genie = genie_module()
            tmp_dir = tempfile.mkdtemp(prefix="genie-tts-")
            out_path = os.path.join(tmp_dir, f"out.{fmt}")
            genie.tts(character_name=character, text=text, save_path=out_path, play=False)
            if not os.path.isfile(out_path):
                raise RuntimeError(f"引擎没有产出音频文件：{out_path}")
            with open(out_path, "rb") as fh:
                data = fh.read()
            try:
                for name in os.listdir(tmp_dir):
                    os.remove(os.path.join(tmp_dir, name))
                os.rmdir(tmp_dir)
            except Exception:
                pass
            STATE["lastUse"] = time.time()
        mime = {"wav": "audio/wav", "mp3": "audio/mpeg", "ogg": "audio/ogg", "flac": "audio/flac", "aac": "audio/aac"}[fmt]
        return Response(
            content=data,
            media_type=mime,
            headers={
                "x-genie-ms": str(int((time.time() - t0) * 1000)),
                "x-genie-rss-mb": str(rss_mb()),
                "x-genie-chars": str(len(text)),
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


@app.post("/unload")
def unload(payload: dict | None = None):
    payload = payload or {}
    character = str(payload.get("character") or "").strip()
    try:
        genie = genie_module()
        with STATE["lock"]:
            if character:
                genie.ModelManager().remove_character(character) if hasattr(genie, "ModelManager") else None
                STATE["loaded"].pop(character, None)
            else:
                for name in list(STATE["loaded"]):
                    STATE["loaded"].pop(name, None)
        gc.collect()
        return {"ok": True, "rssMb": rss_mb(), "loaded": list(STATE["loaded"])}
    except Exception as exc:
        return JSONResponse(status_code=500, content={"ok": False, "error": f"{type(exc).__name__}: {exc}"})


@app.post("/shutdown")
def shutdown():
    threading.Timer(0.2, lambda: os._exit(0)).start()
    return {"ok": True, "bye": io.StringIO("").getvalue() or True}


def main():
    global ARGS
    ap = argparse.ArgumentParser(description="Kizuna 本地语音合成 sidecar（Genie / GPT-SoVITS ONNX）")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址，固定本机（默认 127.0.0.1）")
    ap.add_argument("--port", type=int, default=4610)
    ap.add_argument("--data-dir", default=os.environ.get("GENIE_DATA_DIR", ""), help="GenieData 目录（hubert/speaker_encoder/G2P）")
    ap.add_argument("--models-dir", default="", help="角色模型目录（每个角色一个子目录，内含 *.onnx）")
    ap.add_argument("--character", default="", help="启动时预加载的角色（可留空，等 /load）")
    ap.add_argument("--language", default="zh", help="默认语言 zh/jp/en/kr")
    ARGS = ap.parse_args()
    t0 = time.time()
    if ARGS.character:
        try:
            do_load(ARGS.character)
        except Exception as exc:
            sys.stderr.write(f"[genie] 预加载角色失败（服务照常启动，等 /load 再试）：{exc}\n")
    STATE["bootMs"] = round((time.time() - t0) * 1000)
    sys.stderr.write(
        f"[genie] 就绪 http://{ARGS.host}:{ARGS.port} 启动耗时={STATE['bootMs']}ms 内存={rss_mb()}MB "
        f"data={ARGS.data_dir} models={ARGS.models_dir}\n"
    )
    uvicorn.run(app, host=ARGS.host, port=ARGS.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
