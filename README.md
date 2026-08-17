# DeepSeek Anchor Gateway

在 API 层复刻 [dsh anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) 的简易 OpenAI 兼容网关。

**原理**：DeepSeek V4 对 API 可见的首轮工具目录高度敏感——Minimal 条件（`bash` + `str_replace_editor`）让模型进入 RL 高分区间（`We need...` 模式），标准目录（20+ 工具）则降级为 `Let me...` 工具轮换模式（Project2: 99/96 vs 91）。

网关对每个会话的**第一个请求**只暴露最小工具集（bash/editor 类，默认白名单正则），一旦会话出现首条 assistant 消息即「提升」，后续请求**原样透传**客户端的完整工具目录。等价于 dsh 的 `promoteOn: 'either'`。

## 运行

```bash
ANCHOR_UPSTREAM_KEY=sk-xxx node server.mjs
```

把客户端的 base URL 指向 `http://127.0.0.1:8787/v1`，其余配置不变（OpenAI 兼容）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ANCHOR_UPSTREAM_URL` | `https://api.deepseek.com` | 上游端点根（可带 `/v1`，自动去重） |
| `ANCHOR_UPSTREAM_KEY` | 空 | 上游 key；不设则透传客户端 `Authorization` |
| `ANCHOR_PORT` | `8787` | 监听端口 |
| `ANCHOR_HOST` | `127.0.0.1` | 监听地址 |
| `ANCHOR_KEEP` | 见下 | 首轮保留工具的白名单正则 |
| `ANCHOR_PROMOTE_AFTER_FIRST` | `0` | `1` = 首轮锚定后提升全量工具（经典模式）；`0` = 持续锚定（每轮裁剪） |

默认白名单正则（大小写不敏感）：

```
^(bash|shell|zsh|pwsh|str_replace_editor|.*edit.*|write)$
```

即保留 bash/编辑器/写文件类，裁掉 Read/Glob/Grep/WebFetch 等。

## 两种锚定模式

**持续锚定（默认，`ANCHOR_PROMOTE_AFTER_FIRST=0`）**：每轮 `tools` 都按白名单过滤，目录 = 白名单 ∪ 会话历史中模型已调用过的工具。防 post-promotion 全量 dump 拉回 standard 轨迹。

**首轮提升（`ANCHOR_PROMOTE_AFTER_FIRST=1`）**：开局轮（会话首轮 / 用户新消息后第一轮）裁剪工具 + persona；之后轮次**全量工具原样透传**，instructions 仍保持 persona + hint（对齐 opencode-anchored 的"system 全程 minimal"）。

两种模式下 instructions 都**不恢复完整版**：开局轮只发一句话 persona；工具 continuation 轮追加一句 hint 让模型按需读取 CLAUDE.md（dsh instruction-hint 做法）。bingo 行为契约靠 hint + 文件自读维持。

## 测试

```bash
node --test test/
```

## 限制

- 会话状态只按「请求体内 messages 是否含 assistant」判定——客户端必须自己把历史消息完整带回来（标准 OpenAI 用法，天然满足）
- 按会话 id/前缀分组做隔离暂未实现；不同会话并发各自带历史即可正确区分
- 非 chat/completions 路径（embeddings 等）原样透传
