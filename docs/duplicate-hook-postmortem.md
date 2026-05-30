# SessionStart hook 双倍上报：根因分析与教训

**日期**：2026-05-30
**影响**：`ai-otel-setup` 安装的 Claude Code 用户中，部分人 SessionStart 事件会上报两次。
**触发概率**：使用过 Claude Code `/hooks` UI 或类似规整化工具的用户必然踩到。
**修复版本**：本文末尾给出兼容修复方案，可在下一版 installer 中落地。

---

## 1. 现象

线上某用户 `~/.claude/settings.json` 的 `SessionStart` 数组里有**两条命令完全相同的 hook**——一条带 `id: team:session-start`，另一条没有 `id` 也没有 `description`：

```json
"SessionStart": [
  {
    "matcher": "*",
    "hooks": [{ "type": "command", "command": "<launcher 调用>", "timeout": 3 }]
  },
  {
    "matcher": "*",
    "hooks": [{ "type": "command", "command": "<同样的 launcher 调用>", "timeout": 3 }],
    "description": "ai-otel-setup 注入：补采项目/git/hostname 维度，POST 到 OTLP/HTTP 4318",
    "id": "team:session-start"
  }
]
```

每次会话启动 Claude Code 会把数组里所有 hook 都触发一次 → SessionStart 上报数量是其他用户的 **2 倍**，下游聚合按会话去重前的口径会被污染。

---

## 2. 关键观察

| 事实 | 含义 |
|------|------|
| 两条 hook 的 `command` 字符串**逐字节一致** | 不是用户自定义 hook，是某次 installer 写出的 |
| 一条无 `id` / 无 `description`，其余字段完整 | 不是 installer 直接写的——installer 从第一版（commit `054ac40`）起就一直带 `id` 和 `description` |
| 孤儿在 installer dedup 列表的**前面** | 新条目被 append，旧条目残留 |
| 现象在多次重装后**稳定**为 2，不会继续翻倍 | dedup 仍按 id 工作，只是**漏识别**了孤儿这一条 |

结论：**孤儿不是 installer 写的，而是 installer 写完之后被某个外部进程"规整化"（normalize）改造过**——保留了它认识的 schema 字段（`matcher` / `hooks` / `type` / `command` / `timeout`），丢掉了它不认识的扩展字段（`id` / `description`）。

最可能的元凶：Claude Code 自身的 `/hooks` UI 或 `claude config` 子命令——任何会读取 `settings.json` 然后整体重写的工具，只要 schema 不包含 `id`/`description`，就会触发这个 bug。

---

## 3. 复现

完全确定性，三步触发：

```bash
SANDBOX=$(mktemp -d)
export GIT_CONFIG_GLOBAL="$HOME/.gitconfig"

# 1. 首次安装：1 条带 id 的 hook
HOME="$SANDBOX" node cli.js url=10.20.30.40
node -e "console.log(require('$SANDBOX/.claude/settings.json').hooks.SessionStart.length)"
# → 1

# 2. 模拟外部进程把 id/description 抹掉（保留 matcher/hooks）
node -e "
  const fs=require('fs'),p='$SANDBOX/.claude/settings.json';
  const s=JSON.parse(fs.readFileSync(p,'utf8'));
  s.hooks.SessionStart = s.hooks.SessionStart.map(h => ({matcher:h.matcher, hooks:h.hooks}));
  fs.writeFileSync(p, JSON.stringify(s,null,2));
"

# 3. 再次安装（用户重装 / 旧版自动更新）
HOME="$SANDBOX" node cli.js url=10.20.30.40
node -e "console.log(require('$SANDBOX/.claude/settings.json').hooks.SessionStart.length)"
# → 2  ← BUG
```

第 4 次起恒定 2 条：新条目按 id 覆盖自己，孤儿永远清不掉。

---

## 4. 代码层根因

`cli.js` 的 `mergeSettings` 用 `id` 作为唯一 dedup key：

```js
const idx = sessionStart.findIndex((h) => h && h.id === HOOK_ID);
if (idx >= 0) sessionStart[idx] = hookEntry;
else sessionStart.push(hookEntry);
```

这条契约暗含两个**未被验证**的假设：

1. **`id` 字段会被 settings.json 的所有读写方原样保留**——一旦任何工具规整化掉 `id`，dedup 就失效。
2. **没有内容相同的 hook 会出现两次**——但若上面假设 1 被违反，外加 installer 多次运行（旧的自动更新机制每 2 小时跑一次），则**每跑一次就 append 一条**，直到下一次规整化把 id 再抹掉。

两个假设都依赖外部不可控行为。

---

## 5. 为什么旧的"自动更新"放大了这个 bug

旧版 `launch-hook.js` 每次会话启动会做：

> 检查 npm 上 `ai-otel-setup` 是否有更新 → 若有，detached spawn `npx ai-otel-setup@latest url=...` 静默重装

这意味着只要用户碰过一次 `/hooks` UI，**接下来的每次自动更新都会再加一条**：

```
触发 0：  /hooks UI 抹掉 id        → 0 条带 id, 1 条孤儿
触发 1：  自动更新发现 → 重装       → 1 条带 id, 1 条孤儿  (= 双倍)
触发 2：  /hooks UI 又抹一次        → 0 条带 id, 2 条孤儿
触发 3：  自动更新重装               → 1 条带 id, 2 条孤儿  (= 三倍)
...
```

实际线上稳定在双倍（不是三倍/四倍），说明用户只触发过一次 UI 规整化，但**只要有自动更新存在，就会无限发散**。这是我们在 commit `77a6c88` 移除自动更新的另一个隐性收益。

---

## 6. 设计教训

### 6.1 自定义字段不能作为唯一 dedup key

**问题**：当 schema 由别人定义时（这里是 Claude Code 定义 `SessionStart` 数组的 shape），你写的扩展字段（`id`、`description`）随时可能被抹掉。

**对策（择一）**：

- **A. 用 schema 内字段作为指纹**：拼接 `matcher + command + type` 计算稳定 hash 来 dedup。即使 `id` 丢失，相同语义的条目仍能匹配。
- **B. 防御式 dedup**：除了按 id 匹配，再追加一次"按 command 字符串前缀匹配"的兜底扫描，识别包含 `cc-otel/launch-hook.js` 路径的条目，统一替换。
- **C. 写完之后回读校验**：写入后立刻 re-read，若 id 字段被改动则告警（但不能解决多进程并发场景）。

我们准备落地 A + B 的组合（见 §7）。

### 6.2 静默自动更新本身是个反模式

旧的 `runAutoUpdate` 把"用户没明确同意的、改 settings.json 的、可能失败的、有副作用的"操作藏在 hook 内部，每 2 小时跑一次。它放大了任何 dedup 漏洞，也让"为什么我配置又变了"这种问题极难溯源。

教训：**任何修改用户配置文件的操作，都应该是用户主动触发的**。需要"自动跟新"用 npm 自身的 `npx -y latest` 语义，不要在 hook 里偷偷做。

### 6.3 写入后没有回读验证

`writeJSONAtomic` 写完就返回，没有"回读 → 比对预期 schema"。如果首次安装后立刻被外部进程改写，installer 不会发现。下个版本可以加一个 `--verify` 模式做安装后 self-check。

### 6.4 缺少内容指纹型测试

整个 `mergeSettings` 的单元覆盖只测过"id 存在 → 覆盖"和"id 不存在 → 追加"两个分支，没测过"id 被外部抹掉 → 重复"这种实际线上场景。**测试用例要覆盖外部对 settings.json 的不友好改写**，不只是 installer 自己写出的输入。

---

## 7. 修复方案

兼容修复，下一版 `mergeSettings` 改成"id 优先 + command 指纹兜底"：

```js
function findExistingHookIdx(arr, hookId, ourCommand) {
  // 1. 先按 id 精确匹配（保留原行为）
  let idx = arr.findIndex((h) => h && h.id === hookId);
  if (idx >= 0) return idx;

  // 2. id 缺失（被外部抹掉）时按 command 兜底
  //    判断条件：command 字符串里含我们的 launcher 路径片段
  //    避免误伤用户自己写的、命令完全不同的 hook
  const sig = "/cc-otel/launch-hook.js";
  idx = arr.findIndex(
    (h) =>
      h &&
      Array.isArray(h.hooks) &&
      h.hooks.some((c) => typeof c.command === "string" && c.command.includes(sig))
  );
  return idx;
}
```

替换 `mergeSettings` 里两处 `findIndex(...id === HOOK_ID)` 调用即可。Codex / Gemini 的同类逻辑也按相同方式修。

**对存量孤儿的清理**：发新版时在 installer 启动时跑一次"扫描 + 合并孤儿"，识别 `command` 含 `/cc-otel/launch-hook.js` 但无 `id` 的条目，直接删除（因为它的功能与新写入条目完全等价）。这是一次**非破坏性**的迁移：删除的条目里不含任何用户自定义内容（用户自定义 hook 的 command 不会含我们的路径片段）。

---

## 8. 检查清单（送给后来人）

写"幂等修改用户共享配置文件"的工具时，逐条核对：

- [ ] dedup key 是不是 schema 内字段？（不要用注释字段、扩展字段）
- [ ] 如果必须用扩展字段，是否有"按内容指纹"的兜底匹配？
- [ ] 多次运行的稳态条目数有没有自动化测试覆盖？
- [ ] 测试用例是否模拟了"被外部进程改写过的 settings.json"作为输入？
- [ ] 是否有"安装后回读 → 比对预期"的 self-check 步骤？
- [ ] 静默后台修改用户配置的特性，是否真的有必要？大多数情况答案是否。

---

## 附：本次事件相关 commit

- `054ac40` 第一版 installer：dedup 用 id，奠定了这个 bug 的设计前提
- `5071442` 引入 `UserPromptSubmit` 兜底 hook：同样按 id dedup，**有同种潜在风险**
- `77a6c88` 移除 launch-hook 自更新：消除了"无限发散"的放大器，但孤儿仍需主动清理
