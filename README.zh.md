# dsh-llm-as-verifier

这是 DeepSeek Harness 的独立 LLM-as-verifier 运行时包。一次安装提供三个 Cordis 插件：

- `dsh-llm-as-verifier/core`：与 provider 无关的 verifier runtime 和 Best-of-N 工具。
- `dsh-llm-as-verifier/provider`：基于 Python worker 的 DeepSeek/OpenAI-compatible provider。
- `dsh-llm-as-verifier/observer`：可选的会话生命周期评估和 JSONL 记录。

包内保留的 `cordis.patch.yml` 可用于没有预置 verifier 行的 composition。DeepSeek Harness rc.8 已占用三个 verifier 行 ID，并禁止后加载 bundle 修改包名，因此 rc.8 必须在 base composition 适配层替换对应包名。三个插件均保持默认关闭，只有在 `verifier` 设置中启用并选择 provider 后才会实际发起验证。

## 开发

需要 Node.js 22.19 或更高版本，以及 pnpm 11。

```bash
pnpm install
pnpm check
pnpm pack:check
```

## DeepSeek Harness 集成

把 `dsh-llm-as-verifier` 加入 profile 依赖，再把 rc.8 base composition 中的 `verifier`、`verifier-provider` 和 `verifier-observer` 三行指向上面的包子路径。不要再把本包加入 rc.8 profile 的 bundle 列表，否则 rc.8 会拒绝后置的包名替换。当前 Web 设置页和 API 接线记录在 `integration/deepseek-harness/`，后续会继续缩减为外部插件适配层。

仓库不保存任何凭据。provider 会在调用时通过 DSH credential reference 解析密钥。
