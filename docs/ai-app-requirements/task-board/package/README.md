# 任务看板管理系统需求资料包

资料版本：`task-board-requirements-v1.0-review`；整理日期：2026-11-08。

资料状态：已形成完整的本地复核资料，包含正式需求、统一权限、具体样例及 84 项验收清单。尚未提交生成、运行或验收；R01—R07 为单独标出的整理默认，等待整体复核。版本号用于固定资料，不代表产品分期。

交付原则：以完整系统为目标，不预设首版、MVP 或后续功能阶段。明确排除项继续排除；之后实际发现遗漏再补充。

## 阅读与上传清单

| 顺序 | 文件 | 内容 |
| --- | --- | --- |
| 0 | 本文件 | 版本、范围、阅读顺序与使用说明 |
| 1 | [01-product-scope.md](01-product-scope.md) | 多项目、账号复用、访问边界与排除范围 |
| 2 | [02-projects-and-members.md](02-projects-and-members.md) | 成员角色、归档恢复、真删除与离开再加入 |
| 3 | [03-boards-and-workflow.md](03-boards-and-workflow.md) | 状态列、颜色、完成语义、排序与保护 |
| 4 | [04-tasks-and-collaboration.md](04-tasks-and-collaboration.md) | 任务字段、分配、标签、Markdown、评论、归档与真删除 |
| 5 | [05-query-and-my-tasks.md](05-query-and-my-tasks.md) | 搜索筛选、排序、项目内仅看我的任务 |
| 6 | [06-history-and-exceptions.md](06-history-and-exceptions.md) | 日志、站内/邮件通知、提及、失败与并发 |
| 7 | [07-images-and-resources.md](07-images-and-resources.md) | 上传转链接、格式、预览、权限与引用清理 |
| 8 | [08-delivery-and-acceptance.md](08-delivery-and-acceptance.md) | 真实持久化、源码配置、备份恢复与交付原则 |
| 9 | [09-time-and-timezones.md](09-time-and-timezones.md) | 精确截止、UTC、用户时区、逾期及夏令时 |
| 10 | [10-fields-and-ui.md](10-fields-and-ui.md) | #0001 编号、字段校验、任务详情 drawer、手机与整理默认 |
| 11 | [11-permissions.md](11-permissions.md) | 进行中/归档项目的统一权限矩阵 |
| 12 | [samples/README.md](samples/README.md) | 两项目、六身份、十任务、Markdown 与两张图片的建立方法 |
| 13 | [samples/scenario.json](samples/scenario.json) | 目标业务状态及可核对的查询预期，不是导入 API |
| 14 | [12-acceptance.md](12-acceptance.md) | 84 项可执行验收 |
| 15 | [acceptance-results.csv](acceptance-results.csv) | 实际结果及证据模板，全部未执行 |
| 16 | [manifest.json](manifest.json) | 文件清单、字节数、SHA-256 与验证状态 |

上传时保留整个目录及 `samples/` 下全部 Markdown、JSON 和 PNG 的相对结构，文件全集以 manifest 为准。若目标入口不能接收 ZIP，先解压再按其实际支持的方式提供，核对解析清单；不能仅以压缩包上传成功认定 AI 已读到所有正文、样例和图片。

## 核心约束

- 账号复用 Kooboo；项目权限独立。任务列表点击打开详情 drawer，字段、描述、评论及历史遵循同一任务与权限规则。
- 必做：站内和邮件通知、真实成员 @提及、项目内“仅看我的任务”、正文图片链接化、精确截止时间、桌面及手机基本操作。
- 排除：独立附件、自建账号密码、子任务、跨项目移动、跨项目“我的任务”、独立统计报表、定时到期催办和移动推送。
- 完成与归档独立，归档默认隐藏并只读；管理员才可真删除。项目归档后仍可管理成员和主动退出。
- 正式时间方案为 UTC 时间点与用户时区显示，不采用仅日期、固定北京时间或项目业务时区的旧候选。
- R01—R07 的范围、原因在字段文件单列；全应用递增及至少四位编号是整理默认。样例色值和具体文本属于测试数据，不强制产品只能使用这些值。

## 使用边界

- 最终生成和独立评测以同一份复核后的资料包版本为依据。
- 决策记录和 `working/` 属于整理过程，不包含在上传包；包内文档所列 D 编号仅是来源标识，读取本包无需取得历史草案。
- 现行范围已取消任务与评论的独立附件，改为 Markdown 正文图片并保存图片链接；旧附件决定仅供历史追溯，以 D075、D076 及当前正式需求为准。
- 由生成实施方按现有 Kooboo AI App 能力选择存储、权限接口、Markdown 库及邮件实现，保留实现依据；本包不虚构现有导入接口或要求用户预先设计数据库。
- 样例时钟须按真实 T0 换算，账号与邮件使用之后获准的测试资源，先上传图片再替换本地路径。
- 复核默认后固定实际使用版本及哈希，再生成与独立验收；不要按生成结果反改预期，也不在本次资料整理中自动发起生成或邮件。

运行后填写结果模板并回存案例记录；源码提交、生成完成、静态检查、真实运行、邮件收件与用户接受分别记载。当前只有资料整理成果。
