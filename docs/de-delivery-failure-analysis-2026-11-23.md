# DE 服务器跨环境迁移失败分析报告（2026-11-23）

- **排障包来源**：`/Users/achen/Downloads/diagnostic-ced6df2c-7681-4bfb-8977-c25107f9ed1c-2026-11-23.zip`
- **排障导出标识**：`ced6df2c-7681-4bfb-8977-c25107f9ed1c`
- **目标站点**：`huisartspraktijk_jwa_van_willigen`

---

## 一、概述与核心结论

本次从香港 Kooboo 环境向德国（DE）环境自动跨环境迁移失败，**问题不在本地 Automation Lab 超时或请求参数错误**，而是 **DE 侧迁移接口 `https://launch.kooboo.nl/api/sitemigrate` 在运行 47.1 秒后抛出服务端脚本异常（HTTP 500）**：

```text
Script error on 'sitemigrate' at line:4 colum:4 Unexpected token 'T' in JSON at position 0
```

结合排障包数据与 Kooboo 源码对照，导致失败的完整链路如下：

1. **直接崩溃点**：DE 端名为 `sitemigrate` 的 Kooboo KScript 脚本在第 4 行第 4 列对下游返回结果做 JSON 解析时，拿到了以字母 `'T'` 开头的纯文本而非 JSON，抛出未捕获异常导致接口返回 HTTP 500。
2. **高置信度技术根因**：Kooboo KScript 常用的 `k.net.url.*` 底层复用全局静态 `HttpClient`，其超时被**硬编码为 45 秒**，且捕获超时异常后不会抛出错误，而是将异常信息字符串（`.NET HttpClient` 超时消息以 `"The request was canceled due to the configured HttpClient.Timeout of 45 seconds elapsing."` 开头，首字符为 `'T'`）直接作为文本返回；`sitemigrate` 未校验状态与返回格式即解析 JSON，从而在约 **47.1 秒** 时触发 `Unexpected token 'T'`。
3. **关键触发诱因**：本次待迁移站点导出包 `kooboo-site.zip` 体积高达 **23.13 MB**（解压后 **28.31 MB**），远超此前正常迁移的 8.05 MiB 站点。主要原因是资料包中的 4 张 2.2–2.98 MB 原始大图既保存在 `CmsFile`（11.63 MB），又在生成阶段被 AI 批量复制进了媒体库 `Image`（11.57 MB），造成**双份冗余**，使跨洲导出/传输/导入耗时突破 45 秒上限。

---

## 二、故障现场与时间线

### 2.1 任务与交付上下文

| 字段 | 观测值 |
| --- | --- |
| 源环境 | `香港 kooboo`（`e5766299-db0f-4716-80c7-857a05fcde22`，`https://shawnchen-hk.kooboo.io`） |
| 源生成站 | `huisartspraktijk_jwa_van_willigen`（`siteId: 272f2287-b174-1562-2c31-f9197a20a0b5`，`generatedSiteId: 51655175-9e8f-4bc5-abcc-59772989d68f`） |
| 源站公开地址 | `https://huisartspraktijk_jwa_362b-shawnchen-hk.kooboo.io/` |
| 生成任务 ID | `172bd810-5d46-4ed2-a354-95f600f355dc`（范围：`upgrade` / `homepage`，状态：`completed`） |
| 评测任务 ID | `4fca1630-a11c-464c-8358-f0c268ece92c`（状态：`completed`，报告：`failed`，desktop 84.4 / mobile 76.8） |
| 交付记录 ID | `b57d7b33-d249-4b34-b3fe-3125b28b291f` |
| 迁移接口与策略 | `POST https://launch.kooboo.nl/api/sitemigrate`，`auto: true`，`requirePassed: false`，`timeoutSeconds: 180` |
| 交付最终状态 | `status: "uncertain"`，`stopped: true`，`attempts: 1`（按设计禁止自动重发） |

### 2.2 事件时间线（北京时间 `Asia/Shanghai`）

| 时间 | 事件序号 | 任务 | 事件详情 |
| --- | --- | --- | --- |
| `2026-11-22 22:29:22.903` | `seq=20426` | `172bd810` | 任务入队，固定输入版本与评测规则 |
| `2026-11-22 22:31:05.040` | `seq=20541` | `172bd810` | 在香港环境准备新站 `huisartspraktijk_jwa_van_willigen` |
| `2026-11-22 22:48:16.166` | `seq=21065` | `172bd810` | 生成阶段结束，交接独立评测任务 `4fca1630-a11c-464c-8358-f0c268ece92c` |
| `2026-11-22 23:26:05.990` | `seq=21880` | `4fca1630` | 独立评测完成 |
| `2026-11-22 23:26:06.264` | `seq=21881` | `4fca1630` | 已排队跨环境交付；源站和评测报告保留不变 |
| `2026-11-22 23:54:42.920` | `seq=22477` | `4fca1630` | 开始调用 `POST https://launch.kooboo.nl/api/sitemigrate`（`attemptedAt: 1795362882919`） |
| `2026-11-22 23:55:30.050` | `seq=22490` | `4fca1630` | 迁移接口返回 `HTTP 500 Internal Server Error`；耗时 `47.1s`（精确 `47130 ms`）；`content-type=text/html`；响应摘要：`Script error on 'sitemigrate' at line:4 colum:4 Unexpected token 'T' in JSON at position 0`；标记为 `uncertain` 并禁止自动重发 |

---

## 三、根因逐层分析（附源码依据与证据边界）

### 3.1 已确认事实：本地发送正常，异常抛出自 DE 端 `sitemigrate` 脚本

1. **本地请求未超时且合约完整**：Automation Lab 客户端在 [delivery.ts](file:///Users/achen/Priv/Yardi/AI-App/Kooboo-AI-Automation-Lab/server/automation/delivery.ts#L336-L375) 发起 `POST https://launch.kooboo.nl/api/sitemigrate`，携带 `{ siteUrl: "https://huisartspraktijk_jwa_362b-shawnchen-hk.kooboo.io", token }`，本地超时设置为 `180s`（`delivery.policy.timeoutSeconds`）。接口在 `47.1s` 即返回了 HTTP 500 HTML 错误页，远未到达本地 `180s` 上限。
2. **错误格式为 Kooboo Jint 引擎原生异常**：返回的摘要：
   ```text
   Script error on 'sitemigrate' at line:4 colum:4 Unexpected token 'T' in JSON at position 0
   ```
   与 Kooboo 引擎 [JsEngineExtensions.cs](file:///Users/achen/Priv/Yardi/Kooboo/Kooboo.Sites/Scripting/JsEngineExtensions.cs#L103-L117) 中的异常拼装逻辑逐字匹配（包括 `colum:` 拼写）：
   ```csharp
   errorMessageBuilder.Append("Script error");
   errorMessageBuilder.Append($" on '{source}'");
   errorMessageBuilder.Append($" at line:{mappingEntry.OriginalSourcePosition.ZeroBasedLineNumber + 1} colum:{mappingEntry.OriginalSourcePosition.ZeroBasedColumnNumber}");
   errorMessageBuilder.Append($" {ex.Message}");
   ```
   这直接证明错误发生在 DE 端 `launch.kooboo.nl` 上名为 `sitemigrate` 的 Kooboo 脚本第 4 行第 4 列。

### 3.2 高置信度推断：45 秒硬编码超时 + `k.net.url` 吞异常返回 `'T...'` 文本

> **证据边界说明**：本地代码库不包含部署在远端 `launch.kooboo.nl` 上的 `sitemigrate` 脚本源码，以下定位基于**请求耗时特征（47.1s）+ 报错特征（位置 0 出现 `'T'`）+ Kooboo 源码机制**的交叉验证，需在 DE 端查看 `sitemigrate` 源码最终确认。

1. **45 秒硬编码超时**：Kooboo KScript 中最常用的 `k.net.url.*`（`KScript.Curl`）底层固定使用静态全局客户端 `HttpClientHelper.Client`。在 [HttpClientHelper.cs](file:///Users/achen/Priv/Yardi/Kooboo/Kooboo.Lib/Helper/HttpClientHelper.cs#L56-L57) 中，其超时写死为 **45 秒**：
   ```csharp
   HttpClient client = new HttpClient(handler);
   client.Timeout = new TimeSpan(0, 0, 45);
   ```
   `45s` 下游请求超时加上前面约 2 秒的前置校验与网络往返，恰好与本次 `47.1s` 以及 [release-notes-0.8.3.md](file:///Users/achen/Priv/Yardi/AI-App/Kooboo-AI-Automation-Lab/docs/release-notes-0.8.3.md#L11) 中记录的另一次历史 HTTP 500 耗时（`48.95s`）高度吻合。
2. **异常被捕获为 `'T'` 开头的消息字符串**：在 [Curl.cs](file:///Users/achen/Priv/Yardi/Kooboo/Kooboo.Sites/Scripting/Global/Curl.cs#L761-L764)（以及 L690–693、L778–781、L807–810、L875–878）中，请求异常被捕获并直接 `return ex.Message;`。当 .NET `HttpClient` 触发 45 秒超时时，`ex.Message` 为：
   ```text
   The request was canceled due to the configured HttpClient.Timeout of 45 seconds elapsing.
   ```
   其第 0 个字符正是 **`'T'`**。
3. **直接 JSON 解析触发崩溃**：如果 `sitemigrate` 第 4 行调用了 `JSON.parse(...)` 解析 `k.net.url.post(...)` 的返回值，或者直接调用了会在内部解析 JSON 的 `k.net.url.postDataAsObject` / `k.net.url.getJson`（见 [Curl.cs](file:///Users/achen/Priv/Yardi/Kooboo/Kooboo.Sites/Scripting/Global/Curl.cs#L260-L270) 与 [L974-L978](file:///Users/achen/Priv/Yardi/Kooboo/Kooboo.Sites/Scripting/Global/Curl.cs#L974-L978)），就会立即抛出 `Unexpected token 'T' in JSON at position 0`。

*(注：即使下游实际返回的是其他以 `'T'` 开头的非 JSON 纯文本错误页，例如 `"Timeout..."` 或 `"Too Many Requests..."`，脚本未检查响应状态码与 `Content-Type` 即直接解析 JSON 同样会导致此错误。)*

### 3.3 触发诱因：`kooboo-site.zip` 体积膨胀（23.13 MB）与图片双份冗余

对照 [release-notes-0.8.3.md](file:///Users/achen/Priv/Yardi/AI-App/Kooboo-AI-Automation-Lab/docs/release-notes-0.8.3.md#L38) 的成功基准：此前 **8.05 MiB** 的站点从 HK 迁移到 DE 仅耗时 **4.93s**。而本次排障包导出的 `site/kooboo-site.zip` 体积达到了 **23.13 MB**（解压后 **28.31 MB**，共 118 个条目）。仅在本地排障导出阶段用 `fast` 模式从 HK 拉取该站点包就耗时 **10.74s**（`site/export.json`：`1795400635804` → `1795400646543`）。

检查 `kooboo-site.zip` 内部数据块大小分布如下：

| 压缩包内文件 | 未压缩大小 | 压缩后大小 | 体积构成与原因 |
| --- | ---: | ---: | --- |
| `CmsFile/Data.block` | **11.63 MB** | **11.22 MB** | 平台导入全部 25 份资料到 `CmsFile`，其中包含 4 张 2.2–2.98 MB 的未压缩原始大图 |
| `Image/Data.block` | **11.57 MB** | **11.43 MB** | 生成阶段对话（`dd3dc44d-5975-4515-a6a5-339b401dbc88`）中，AI 通过 `run_kscript` 把 7 张资料图批量复制进媒体库（含 `upgrade/hero-interior.jpg` ~2842 KB、`upgrade/entrance.jpg` ~2910 KB、`upgrade/monument.jpg` ~2149 KB、`upgrade/historic-exterior.jpg` ~2494 KB），而首页最终仅使用 `upgrade/exterior.jpg`（92 KB）和 `upgrade/wood-detail.jpg`（51 KB） |
| `aiData/Messages/dd3dc44d-5975-4515-a6a5-339b401dbc88.jsonl` | **3.46 MB** | **0.24 MB** | Kooboo AI 执行历史对话日志 |
| 其余页面、样式、索引与配置 | ~1.65 MB | ~0.24 MB | 常规站点内容 |

原始大图在 `CmsFile` 与 `Image` 中各存一份，直接导致导出包膨胀至 **23.13 MB**，叠加 HK ↔ DE 跨洲传输及目标站导入解压耗时，很容易突破 `45s` 超时窗口。

---

## 四、当前状态与排查修复建议

### 4.1 立即处理（核查目标环境与补录回执）

- **禁止盲目重发**：由于超时发生在 `sitemigrate` 等待下游导入响应的阶段，**DE 目标环境有可能在 45 秒之后依然完成了建站**；平台已按策略将本次交付标记为 `uncertain` 并阻止自动重发。
- **操作步骤**：
  1. 登录 DE 环境后台核查是否已存在本次迁移生成的 `huisartspraktijk_jwa_van_willigen` 站点及页面内容是否完整。
  2. 若已建站成功且内容完整：取得目标站的 `siteId` 与 `siteUrl`，在 Automation Lab 中执行**补录回执**，即可跳过重新迁移，直接进入交付核验。
  3. 若 DE 环境未创建该站点（或残留半成品）：先清理无效站点，待确认下方服务端超时问题或瘦身后再手动重新触发。

### 4.2 服务端治本（修复 DE `launch.kooboo.nl` 上的 `sitemigrate`）与双端超时对齐

Kooboo 站点在请求级存在两层互相独立的超时机制：

| 超时层级 | 默认值 | 控制方式 | 是否受 `__engine_timeout__` 影响 |
| --- | --- | --- | --- |
| **Jint 脚本引擎总执行超时** | **60 秒** | URL query `?__engine_timeout__=<秒>`（[KoobooRenderContext.cs](file:///Users/achen/Priv/Yardi/Kooboo/Kooboo.Sites/Render/KoobooRenderContext.cs#L230-L239)） | **是** |
| **`k.net.url.*` 下游 HTTP 超时** | **45 秒**（硬编码） | 全局静态 `HttpClientHelper.Client`（[HttpClientHelper.cs](file:///Users/achen/Priv/Yardi/Kooboo/Kooboo.Lib/Helper/HttpClientHelper.cs#L56-L57)） | **否** |
| **`k.net.httpClient.send` 超时** | **100 秒**（.NET 默认） | 脚本调用时显式传第 5 个参数 `timeout`（[KHttpClient.cs](file:///Users/achen/Priv/Yardi/Kooboo/Kooboo.Sites/Scripting/Global/NET/HttpClient/KHttpClient.cs#L81-L85)） | **否** |

为实现双端超时对齐：

1. **平台侧（Automation Lab `v0.9.2` 已补齐）**：在 [delivery.ts](file:///Users/achen/Priv/Yardi/AI-App/Kooboo-AI-Automation-Lab/server/automation/delivery.ts) 发起迁移请求时，通过 `deliveryRequestUrl` 自动按 `delivery.policy.timeoutSeconds`（默认 `180`）附加 `?__engine_timeout__=<timeoutSeconds>`（若配置 URL 未显式指定非空 `__engine_timeout__`），使 DE 端 Jint 引擎超时与平台客户端超时对齐。
2. **DE 端（`launch.kooboo.nl` 的 `sitemigrate` 脚本待补齐）**：将 `k.net.url.*` 替换为支持传入显式 `timeout` 参数的 `k.net.httpClient.send(url, method, content, headers, timeout)`，直接读取请求 query 参数 `__engine_timeout__`（或默认 `180` 秒）传给 `httpClient`；长期建议改为“异步提交迁移任务 + 轮询状态”模式，避免单次 HTTP 长连接超时。
3. **增加响应校验与结构化错误处理**：在解析 JSON 前校验 HTTP 状态码 / `response.success` 及 `Content-Type`，并将 `JSON.parse` 放入 `try/catch`；下游失败或超时时返回包含状态码与摘要的 JSON 错误，避免抛出未捕获的 `Script error`（HTTP 500 HTML）。

### 4.3 平台与生成侧减负（防止站点包无谓膨胀）

1. **避免原图双份落库与无用大图入媒体库**：在资料导入或 AI 生成脚本复制图片时，仅将实际使用的图片转入 `Image` 媒体库，并对数 MB 级原图做尺寸/质量压缩。
2. **评估导出过滤**：针对跨环境迁移导出路径，评估是否需要排除仅用于生成参考的 `_materials` 原始大文件及 `aiData/Messages` 执行日志，从源头缩小 `kooboo-site.zip` 体积。
