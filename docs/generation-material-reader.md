# 生成资料读取约定

生成任务包保留完整指令、来源清单及素材映射。素材映射含 `name/id/destination/type/size/sha256/storage`；有素材的任务即使指令较短，也投放 reader。原来的 `_automation-manifests/<task>.json` 数组映射仍保留兼容。

每次 `run_kscript` 用 IIFE 加载当前任务包的 `reader.js`，把批处理变量保留在函数局部。不要使用顶层 `t` 临时变量：Kooboo 把它注册为不可写的翻译函数，赋值后它仍可能是函数，随后 `.substring()` 等操作会失败。该行为来自 `Kooboo.Sites/Render/KoobooRenderContext.cs:266`（`writable:false`）；工具入口 `Kooboo.Sites/AI/Functions/BuiltIn/Basic/RunKScript.cs:32` 调用 `Manager.ExecuteCodeLine`，后者在 `Kooboo.Sites/Scripting/Manager.cs:367` 通过引擎执行 classic 脚本。`Kooboo.Sites/Scripting/Global/File/FileIO.cs:175–182` 的 `read` 实际返回文件文本字符串或 `null`，不是 JSON 对象。

```javascript
return (function () {
  var readerBase = "当前任务包索引所在目录/";
  eval(k.file.read(readerBase + "reader.js"));
  return automationMaterials({ prefix: "collection/data/", offset: 0, limit: 10 });
})();
```

- `automationMaterials({prefix,offset,limit})` 分页返回素材元数据，默认 10 项、最多 20 项。按 `nextOffset` 接续至 `null`；实际页大小还受总输出预算约束。
- `automationMaterialRead(name,{offset,chars})` 只读取映射内 `storage:kfile` 的文本，默认和最多 2000 个 UTF-16 码元。JSON 序列化后的结果最多 4000 字符，必要时缩小片段；`total/nextOffset/truncated` 保留接续位置。
- JSON 须显式指定 `{format:"json",path:[...],offset,limit}`，先解析、识别 `valueType`，再返回有界字段或元素摘要。`path` 可逐层选择对象键和数组下标；选择字符串时用 `chars` 继续逐段读取。不要对原始 JSON 字符串执行 `Object.keys()`。
- `automationSummary(automationRead("manifest"),{path:["items"],offset:0,limit:5})` 同样提供有界任务清单摘要；`instructions/guidance` 可选择后按字符串片段读取。摘要中的 `truncated` 不缩减交付范围。

未知或歧义素材、二进制素材在读取正文前拒绝，错误不包含其正文。reader 的无损 `automationRead(section)` 仍用于脚本内部批处理；不要把其完整返回值直接发送到聊天。helper 无法约束绕过它直接返回 `k.file.read()` 或自行生成的大结果，最终工具响应上限仍由 Kooboo 执行层负责。

新包格式为 `automation-context-v3`，reader 版本加入归档哈希和索引。reader 协议变化时必须更新版本，避免同一输入重用旧实现；同版本重试复用原包。旧归档不改写，新 reader 仍接受 v2 节点树。

冻结采集任务还提供 `collectionRecordBindings` 节，包含本轮 `CollectionRecordBindings` 的 `rowSchema` 和规则。可用 `automationSummary(automationRead("collectionRecordBindings"),{path:["rowSchema","properties"],limit:10})` 查看字段，再逐段读取 `rules`。小任务直接在消息中提供同一合同；合同随任务包归档，不修改已经投放的旧包。

- `requirementId` 仅取本轮 schema 枚举：必交付的 `page`、`template`、`dataIdentity.kind=page` 数据要求；未声明计量域的旧 data 项保留 page 兼容。SEO、interaction 使用各自验收证据；relations、assets 使用各自声明表。
- 必填字段为 `id/requirementId/sourceUrl/targetKind/targetContainer/targetId`。`targetKind` 只接受 `sqlite/content`，不接受 `sqlite-row/page/view`。容器和主键必须回指真实记录，不能用声明表、虚构记录或分页序号替代。
- 真实记录自身须用 `sourceUrl` 或 `oldUrl` 唯一回指同一冻结完整来源 URL；只有 `url` 字段或声明表中的来源 URL 不足以建立身份。`identityKeyField` 可省略并默认 `id`；指定时是非空的真实唯一字段名，不是 `null`。

声明不符合合同应在生成修复轮中修正自身实现并回读验证，平台不静默改写类型或猜测来源字段。

2026-11-09 已通过真实 `AI/CallFunction` 的 `run_kscript` 执行只读合成验证：IIFE 内的 `k.file.read` 仅访问合成字典，未读取或写入当前任务资料。结果为 `pass:true`、reader 版本 3、素材 3 项、JSON 类型 `array` / 12000 项；索引和 JSON 摘要分别为 681 / 549 字符；文本 7 片完整还原，`roundTrip:true`，禁止路径读取次数为 0，真实全局 `t` 类型为 `function`。这证明 helper 在该真实 KScript 解释器中能够执行及保持上述输出边界，不代表已向当前运行任务投放新 reader 或完成真实素材验收。本次修改未更新当前正在运行的任务包，也未重启服务。
