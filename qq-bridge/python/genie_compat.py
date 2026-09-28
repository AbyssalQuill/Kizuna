#!/usr/bin/env python3
"""genie_tts 的导入期兼容垫 —— 2026-09-28 新增

为什么需要它：上游 genie-tts 的依赖里有一条 `jieba_fast`（jieba 的 C 加速分支），
它在 PyPI 上**只有源码包**，装它要现编译 —— 没有 C 编译器的机器（典型：Windows
只装了 Python、Linux 精简镜像）会卡在 `pip install genie-tts` 上，整个引擎装不下来。
而引擎里对它的用法就是 `import jieba_fast` / `import jieba_fast.posseg as psg`
（`G2P/Chinese/ChineseG2P.py`、`G2P/Chinese/ToneSandhi.py`、`Internal.py` 里的
warnings 过滤），API 与纯 Python 的 `jieba` **完全一致**（jieba_fast 就是 jieba 的
Cython 化分支，作者自述"接口相同，只是更快"）。

所以这里做一件事：**在导入 genie_tts 之前**，如果 `jieba_fast` 不可用但 `jieba` 可用，
就把 `jieba` 及其子模块（posseg / analyse / finalseg）注册成 `jieba_fast` 及其子模块。
分词质量完全一致，差别只在分词速度（对合成这种一次性几十字的前端处理没有感知）。

被谁用：
  · `genie_server.py` —— 导入 genie_tts 之前先调用 `install_jieba_fast_shim()`；
  · `qq-bridge/src/lib/genie-tts.js` 的环境探测 —— 同样先 import 本模块再 import genie_tts，
    否则"装没装引擎"会被 jieba_fast 这条无关紧要的缺口误判成"没装"。
  · `tools/genie-setup.mjs --install` 的降级路径 —— 装不上 jieba_fast 时补装纯 `jieba`。

这个垫子是**只读的行为改写**：它不下载、不写盘、不动 site-packages，装得上真
`jieba_fast` 时一行都不生效（原样直通）。
"""
from __future__ import annotations

import importlib
import importlib.util
import sys
import types

_SUBMODULES = ("posseg", "analyse", "finalseg")
_state = {"installed": False, "reason": "未探测"}


def jieba_fast_available() -> bool:
    """真 `jieba_fast`（C 加速版）在不在 —— 用 find_spec 判，不触发它的导入。"""
    mod = sys.modules.get("jieba_fast")
    if mod is not None:                    # 兼容垫注册过就是"没有真货"（见 __shim__ 标记）
        return not getattr(mod, "__shim__", False)
    try:
        return importlib.util.find_spec("jieba_fast") is not None
    except Exception:
        return False


def install_jieba_fast_shim() -> dict:
    """把 `jieba` 顶上 `jieba_fast` 的位置。返回 {installed, reason}（幂等，可重复调用）。"""
    if _state["installed"]:
        return dict(_state)
    if jieba_fast_available():
        _state.update(installed=False, reason="已有真正的 jieba_fast（C 加速版），无需兼容垫")
        return dict(_state)
    try:
        jieba = importlib.import_module("jieba")
    except Exception as exc:  # 连纯 jieba 都没有：如实说，让上层给出可执行的安装提示
        _state.update(installed=False, reason=f"jieba_fast 与 jieba 都不可用：{exc}")
        return dict(_state)

    # ① 顶层：把 jieba 的属性整套搬过来（jieba 与 jieba_fast 的公开 API 同名同签名）
    shim = types.ModuleType("jieba_fast")
    for name in dir(jieba):
        if not name.startswith("__"):
            setattr(shim, name, getattr(jieba, name))
    shim.__doc__ = "jieba_fast 的兼容垫：实际指向纯 Python 的 jieba（genie_compat 注册）"
    shim.__shim__ = True
    sys.modules["jieba_fast"] = shim
    # ② 子模块：`import jieba_fast.posseg as psg` 要求 sys.modules 里真有这两个名字
    for sub in _SUBMODULES:
        try:
            mod = importlib.import_module(f"jieba.{sub}")
        except Exception:
            continue
        sys.modules[f"jieba_fast.{sub}"] = mod
        setattr(shim, sub, mod)
    _state.update(installed=True, reason="jieba_fast 缺失，已用纯 Python 的 jieba 顶替（分词质量一致，速度略慢）")
    return dict(_state)


def shim_state() -> dict:
    return dict(_state)
