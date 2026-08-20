# dsh-llm-as-verifier

这是 DeepSeek Harness 的独立 LLM-as-verifier bundle。一次安装提供三个 Cordis 插件：

- `dsh-llm-as-verifier/core`：与 provider 无关的 verifier runtime 和 Best-of-N 工具。
- `dsh-llm-as-verifier/provider`：基于 Python worker 的 DeepSeek/OpenAI-compatible provider。
- `dsh-llm-as-verifier/observer`：可选的会话生命周期评估和 JSONL 记录。

自带的 `cordis.patch.yml` 默认以关闭状态挂载三个插件。只有在 `verifier` 设置中启用并选择 provider 后才会实际发起验证。

## 开发

需要 Node.js 22.19 或更高版本，以及 pnpm 11。

```bash
pnpm install
pnpm check
pnpm pack:check
```

## DeepSeek Harness 集成

把 `dsh-llm-as-verifier` 加入 profile 依赖即可。DSH 会通过包内的 `dsh.bundle.patch` 元数据加载 bundle patch。当前 rc.8 的 Web 设置页和 API 接线记录在 `integration/deepseek-harness/`，后续会继续缩减为外部插件适配层。

仓库不保存任何凭据。provider 会在调用时通过 DSH credential reference 解析密钥。
