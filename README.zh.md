# dsh-llm-as-verifier

[English documentation](README.md)

这是 DeepSeek Harness 的独立 LLM-as-verifier 运行时包。一次安装提供三个 Cordis 插件：

- `dsh-llm-as-verifier/core`：与 provider 无关的 verifier runtime 和 Best-of-N 工具。
- `dsh-llm-as-verifier/provider`：基于 Python worker 的 DeepSeek/OpenAI-compatible provider。
- `dsh-llm-as-verifier/observer`：可选的会话生命周期评估和 JSONL 记录。

包内保留的 `cordis.patch.yml` 可用于没有预置 verifier 行的 composition。DeepSeek Harness rc.8 已占用三个 verifier 行 ID，并禁止后加载 bundle 修改包名，因此 rc.8 必须在 base composition 适配层替换对应包名。三个插件均保持默认关闭，只有在 `verifier` 设置中启用并选择 provider 后才会实际发起验证。每个会话默认跟随全局状态，也可以用 `/verifier on`、`/verifier off` 或 `/verifier default` 独立控制之后的 verifier 工作。

## 这个包能做什么

本包把验证策略、模型访问和旁路观测拆开，三个部分可以独立启用与测试：

```text
DSH 会话/轨迹
      |
      v
verifier core  --->  llm-as-a-verifier provider  --->  DeepSeek/OpenAI API
      |
      +------> observer（可选的 JSONL 评估记录）
```

- core 负责 provider 发现、评分、比较、候选选择和轨迹适配。
- provider 负责凭据、端点选择、受管 Python worker、能力探测、分数提取、
  重试和有界并发。
- observer 可在 turn/step 完成后进行评估并写入可选的本地记录，
  不修改 agent 的正常回答。

provider 默认使用 strict mode。只有调用方明确需要 fail-open 时，才设置
`strict: false`。在 fail-open 模式下，验证失败不会被伪装成正分；调用方会
收到失败元数据并保留配置的回退候选。

## 环境要求与本地构建

需要 Node.js 22.19 或更高版本，以及 pnpm 11。

```bash
pnpm install
pnpm check
pnpm pack:check
```

provider 还需要 Python 3.9 或更高版本。请在隔离环境中安装固定版本的运行依赖，
并让 DSH 使用该解释器：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

把 `verifier-llm-as-verifier.pythonExecutable` 设置为 `.venv/bin/python` 的
绝对路径。若指定解释器无法导入必需的 Python 包，provider 会返回稳定错误码
`PYTHON_DEPENDENCY_MISSING`，不会隐式依赖系统 Python 中偶然安装的包。

## DeepSeek Harness 集成

把 `dsh-llm-as-verifier` 加入 profile 依赖，再把 rc.8 base composition 中的 `verifier`、`verifier-provider` 和 `verifier-observer` 三行指向上面的包子路径。不要再把本包加入 rc.8 profile 的 bundle 列表，否则 rc.8 会拒绝后置的包名替换。当前 Web 设置页和 API 适配层仍保留在 DSH fork 中，后续会继续缩减为外部插件适配层。

仓库不保存任何凭据。provider 会在调用时通过 DSH credential reference 解析密钥。

## 快速开始

### 1. 构建发布产物

克隆仓库，并从准备部署的精确源码版本构建：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

通过测试的 tarball 会写入 `artifacts/dsh-llm-as-verifier-<version>.tgz`。

### 2. 安装到目标 profile

```bash
cd /目标/profile/的绝对路径
pnpm add --save-exact /产物的绝对路径/dsh-llm-as-verifier-<version>.tgz
```

把它保留为普通 profile dependency。使用下面的 rc.8 适配方式时，
**不要**把它加入 `dsh.profile.bundles`。

### 3. 接入三个 Cordis row

如果 composition 尚未占用 verifier row ID，可合并包内的
`cordis.patch.yml`。

对于 DeepSeek Harness rc.8，应修改 base composition 适配层：保留既有 row
ID，只把包名替换为独立仓库提供的子路径：

```yaml
- id: verifier
  name: dsh-llm-as-verifier/core
  config:
    enabled: false
    plugin: null

- id: verifier-provider
  name: dsh-llm-as-verifier/provider

- id: verifier-observer
  name: dsh-llm-as-verifier/observer
```

三个 row 都应挂载，但在凭据配置和能力测试完成前，应保持验证功能关闭。

### 4. 配置 Python、凭据和 provider

为部署版本创建专用 Python 环境：

```bash
python3 -m venv /opt/dsh-runtime/llm-verifier
/opt/dsh-runtime/llm-verifier/bin/python -m pip install -r requirements.txt
```

在 DSH settings 文件中配置以下 namespace：

```yaml
verifier:
  enabled: true
  plugin: llm-as-a-verifier

verifier-llm-as-verifier:
  pythonExecutable: /opt/dsh-runtime/llm-verifier/bin/python
  baseURL: https://api.deepseek.com
  apiKeyEnv: DEEPSEEK_API_KEY
  transport: auto
  strict: true
  criteria:
    Overall: Is this trajectory correct, complete, and adequately verified?
  capabilityProbe:
    maxTokens: 1024
    retryMaxTokens: 2048
```

把引用的密钥写入 DSH credential store，不要写入本仓库：

```yaml
DEEPSEEK_API_KEY: "<你的密钥>"
```

请限制凭据文件权限。DSH 会在调用时解析引用，provider settings 中只保存凭据名。

### 5. 在 Web UI 中测试

1. 打开 **设置 → 验证**。
2. 确认 `llm-as-a-verifier` 显示为可用。
3. 确认凭据和 Python executable 均已配置。
4. 点击一次 **测试验证器能力**。

能力测试会发起真实模型请求，并检查响应 logprobs、分数 token 提取和输出预算，
因此会消耗 token，也可能产生 provider 费用。

测试成功后可保持 core 启用。只有确实需要本地评估记录时，才启用 observer
logging。

## 配置参考

### `verifier` core

| 字段 | 作用 |
| --- | --- |
| `enabled` | 总开关。provider 能力测试成功前应保持 `false`。 |
| `plugin` | provider directory ID。使用 `llm-as-a-verifier`；关闭时使用 `null`。 |

core 与具体 provider 解耦。选择 provider 不会自动启用 observer logging，
也不会自动改变 agent 的正常回答路径。会话默认跟随主开关；`/verifier on`、
`/verifier off` 和 `/verifier default` 只改变该会话之后的调用，并从其持久命令
生命周期恢复。

### `verifier-llm-as-verifier` provider

| 字段 | 作用 |
| --- | --- |
| `pythonExecutable` | 受管 Python 解释器的绝对路径。 |
| `model` | 固定 verifier 模型；唯一允许值为 `deepseek-v4-flash`。 |
| `baseURL` | verifier API 根地址；默认使用官方 DeepSeek endpoint。 |
| `apiKeyEnv` | DSH credential reference 名称；默认为 `DEEPSEEK_API_KEY`。 |
| `transport` | `auto`、`deepseek-native` 或 `openai-compatible`。 |
| `criteria` | 评分标准名称及其自然语言说明。 |
| `strict` | 抛出验证失败，而不是返回 fail-open 元数据。默认 `true`。 |
| `nEvaluations` | 单次分数使用的重复评估次数。 |
| `pivots` | 多候选选择使用的 pivot 数量。 |
| `maxWorkers` | worker 侧并发评估上限。 |
| `timeoutMs` | 单个 worker 请求的截止时间。 |
| `capabilityProbe.maxTokens` / `retryMaxTokens` | 首次与一次重试的输出预算；重试值必须更大。 |
| `progressTracking.enabled` | 启用轨迹中间进度测量。 |
| `confidence` | 分数差阈值和目标选择置信度。 |
| `adaptive` | 可选的 staged 或 top-two 自适应升级策略；默认关闭。 |
| `budget` | verifier 专用的调用、延迟、token 和比较次数上限。 |

初次启用时应保守设置并发、重复评估和 adaptive stages；三者都可能成倍增加
API 请求数和 token 成本。

### `verifier-observer`

| 字段 | 作用 |
| --- | --- |
| `evaluationLogging.enabled` | 在本地持久化 observer 评估记录。默认 `false`。 |
| `evaluationLogging.path` | JSONL 输出目录。默认 `.verifier-runs`。 |
| `evaluationLogging.adaptiveShadow.enabled` | 记录自适应策略的 shadow 结果，但不改变选择。默认 `false`。 |
| `evaluationLogging.adaptiveShadow.top2GapThreshold` | shadow escalation gap。默认 `0.08`。 |

observer 记录可能包含由任务或轨迹派生的内容，应把输出目录视为敏感运维数据，
并应用正常的数据保留规则。

## 故障排查

| UI 原因码 | 含义与处理 |
| --- | --- |
| `MISSING_CREDENTIAL` | 配置的 DSH credential reference 无法解析。请把密钥加入 credential store 后重试。 |
| `PYTHON_DEPENDENCY_MISSING` | 所选解释器无法导入 `llm_verifier` 或传递依赖。请用该解释器重新安装 `requirements.txt`。 |
| `REQUEST_FAILED` | worker 遇到通用的本地或 HTTP 错误。检查 endpoint、TLS/proxy 和已脱敏的 Host 日志。 |
| `LOGPROBS_UNAVAILABLE` | endpoint/model 未返回可用的 token logprobs。请选择兼容模型或 transport。 |
| `NO_SCORE_TOKEN` | 响应中没有可恢复的分数标记。检查模型兼容性和 criteria。 |
| `OUTPUT_BUDGET_EXHAUSTED` | 模型耗尽两次 probe 输出预算。应谨慎提高有界预算。 |
| `PROBE_INCONCLUSIVE` | 响应有效，但不足以证明所需能力。重试一次，再核对模型/endpoint contract。 |

### 安全的本地检查

以下命令只构造客户端，不会发起模型请求：

```bash
VERIFIER_PYTHON=/受管环境的绝对路径/bin/python
VERIFIER_PACKAGE_ROOT=/dsh-llm-as-verifier/的绝对路径

"$VERIFIER_PYTHON" -c 'import llm_verifier, openai; print("python runtime ok")'

env -u PYTHONPATH VERIFIER_BASE_URL=http://127.0.0.1:9 VERIFIER_API_KEY=validation-only \
  "$VERIFIER_PYTHON" -c 'import sys; sys.path.insert(0, sys.argv[1]); import worker; print(type(worker._client()).__name__)' \
  "$VERIFIER_PACKAGE_ROOT"
```

第二项检查应输出 `_VerifierClient`。不要打印真实 API key，也不要把凭据文件复制到
bug report 中。

Host 升级后若 UI 仍显示旧状态，先硬刷新页面，再考虑修改凭据或重装插件。

## 运维建议

- 在 profile 副本或 staging 目录中测试新包和 Python runtime。
- 修改凭据或 endpoint 时保持验证功能关闭。
- 密钥只存入 DSH credential store，并限制文件权限。
- 把能力测试按钮视为真实、可能计费的外部请求。
- Host 支持 live settings revision 时，设置可热应用；判断是否重启前先核对 active
  revision。
- 包代码升级通常需要批准后的维护 reload；不要在进程运行时替换 profile dependency。
- 只有制定了明确的保留与隐私策略后，才启用 observer records。

## 开发与发布门禁

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

部署前还应验证实际 tarball，而不只是源码目录：

1. 把生成的 `.tgz` 解包到空临时目录。
2. 确认包含 `requirements.txt`、`worker.py`、`LICENSE` 和 `NOTICE`。
3. 导入 `core`、`provider` 和 `observer` 三个 Node 入口。
4. 对解包目录运行上面的安全 Python 检查。
5. 在 staged profile 中物理安装 tarball 并检查 composition。

工作区自动更新器会执行这些 package/Python runtime 门禁；受管解释器缺失或版本过期
时，会在部署前 fail closed。
