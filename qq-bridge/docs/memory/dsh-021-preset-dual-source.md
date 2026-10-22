# DSH 0.2.1 预设双源：改仓库源不生效

## 现象
改 `dsh/agent-presets/qq-chat/agent.cordis.yml` 或 `persona.md`、重启桥，行为不变，也不报错。

## 根因
0.2.1 不再扫描 `$DSH_HOME/.agent-presets/<id>/` 目录。预设变成 profile 的 `cordis.patch.yml` 里一条 `@deepseek-ai/dsh-agent-preset` 声明行，plugins 内联。

于是有三份东西：
1. 仓库源 `dsh/agent-presets/qq-chat/`
2. `~/.dsh/.agent-presets/qq-chat/`（桥启动时 cpSync + 合成 persona）
3. profile patch 里的内联声明 ← **只有这份生效**

## 修法
`src/lib/dsh-side.js` 的 `syncPresetDeclaration21(target)`，接在 `installPresets` 尾部（必须在 `syncPresetOverrides` 之后，那步才把 persona 合进 agent.cordis.yml）。

每次桥启动自动重新编译声明并收敛成唯一一份。幂等验证：连跑 4 次 → `true, false, false, false`。

## 踩过的坑
第一版用 `new RegExp` 拼转义串做块替换，转义层数算错，匹配不到旧块 —— 连跑几次把 patch 从 62KB 撑到 316KB、堆了 5 份同 id 的 insert 行。多份同 id 会被 Loader 当成重复插件 id。已改成纯字符串切片（`replaceDeclBlock`），并加了历史遗留块收敛。
