# Kooboo AI Automation Lab 部署与交接指南

更新日期：2026-11-09。面向收到 ZIP、在自己电脑上运行平台的同事。

当前为内部试用：AI Site 模板已有真实流程案例；全站完整性、AI App 的端到端验收以及 Windows 实机验证尚未完成。先跑一条首页任务，再尝试其他场景，安装成功不代表所有场景验收通过。

## 交付内容与前提

解压得到 `Kooboo-AI-Automation-Lab/`，包含源码、SOP、采集引擎、匹配源码的前后端构建产物。本指南也放在包内根目录 `READ_FIRST.md`。`DELIVERY_MANIFEST.json` 记录基线提交、文件哈希和验收边界：`clean-commit` 表示干净提交，`working-tree-test-snapshot` 表示包含未提交改动的联调包。ZIP 旁的 `.zip.sha256` 用于校验传输完整性。

接收者准备：Node.js 24+（含 npm）、联网安装 Playwright Chromium；迁移 / 升级全站采集另需 Python 3.12（含 pip、venv）。还需要可访问的 Kooboo 环境及登录账号（或现成访问令牌）、模型 API 地址和 Key，由管理员安全提供。

**Kooboo 本体不在包内。** 可连接本机或远端环境，环境须配置建站模型、skill、reference、tools；管理前端须包含 `Frontend/src/components/ai-chat/core/automation-bridge.ts` 及 AI Chat 接入变更，并支持图片修复委托。普通发行版不一定含这些改动，由交付人确认实际 Kooboo 版本。“测试连接”仅验证基础 API，不代表桥接就绪。

主流程内置执行浏览器，无须旧版 Chrome 插件、个人 Codex 桌面应用或个人 skill。Codex SDK / CLI 随 npm 依赖安装，使用网页配置的凭据和独立运行目录，不修改全局 Codex 配置。不要使用 `--omit=optional` 安装，Codex 的系统专用可执行文件属于可选依赖。

不分发交付人的 `.data/`、密钥、`.env`、浏览器 profile、`node_modules/`、Git 元数据。同事首次得到独立空白工作区、自己的令牌与配置；个人任务、经验库、自定义规则不会随软件自动迁入。

## Windows 安装

安装 Node.js 24+，重新打开 PowerShell。完整解压到长期保留、当前用户可写的目录，不在 ZIP 预览目录运行：

```powershell
cd 'C:\Kooboo\Kooboo-AI-Automation-Lab'
node --version
npm.cmd --version
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
npm.cmd run install:browser
if ($LASTEXITCODE -ne 0) { throw '浏览器安装失败' }
npm.cmd start
```

`npm.cmd` 可避免 `npm.ps1` 执行策略问题，无需修改整机执行策略。包内已构建；修改源码后，启动前需 `npm.cmd run build`。

全站采集另外安装 Python 3.12，然后执行：

```powershell
py -3.12 --version
npm.cmd run install:collection
if ($LASTEXITCODE -ne 0) { throw '采集环境安装失败' }
npm.cmd run check:collection
```

Windows 普通采集有实现分支，但整个自动化链路尚未实机验收。采集引擎候选代码的隔离修复目前仅支持 macOS Seatbelt；Windows 会保留缺口，不能改成无隔离执行绕过。

## macOS 安装

安装 Node.js 24+，重新打开终端。完整解压后执行：

```sh
cd "$HOME/Applications/Kooboo-AI-Automation-Lab"
node --version
npm --version
npm ci && npm run install:browser && npm start
```

全站采集另装 Python 3.12，再执行 `python3.12 --version` 和 `npm run install:collection && npm run check:collection`。采集安装器要求 **3.12**，3.11 / 3.13 不能替代。

找不到 Python 时，macOS 用 `COLLECTION_PYTHON=/path/to/python3.12 npm run install:collection`；Windows 先设置 `$env:COLLECTION_PYTHON = 'C:\实际目录\python.exe'`。安装器只创建数据目录中的独立 `collection-runtime/`，不修改全局 Python 包和既有密钥配置。

## 首次打开与配置

出现 `Kooboo AI Automation Lab: http://127.0.0.1:4180` 后，在日常浏览器中打开该地址，无需手动登录。首次自动创建 `.data/`，执行队列默认暂停。

1. **系统设置 → Kooboo 连接**：添加环境名称和地址，点击“登录连接”，输入账号密码；需要时继续输入邮箱、手机或验证器验证码。登录会检查站点列表可读，再自动加密保存该连接的访问凭据，不保存密码，也不保存其他尚未提交的设置。Kooboo 环境地址是执行浏览器访问的 origin，例如 `https://kooboo.example.com`，不带 `/_Admin`；平台访问地址是 Node 后台访问的 API origin，通常相同。账号须具有任务所需的建站、资料读写、会话读取和站点导出权限，登录成功只证明站点列表可读。已有令牌也可通过“手动填写访问令牌”录入并保存；凭据过期时点击“重新登录”。
2. **系统设置 → 评测模型**：填 `deepseek-flash-1017`、实际可用的 Responses 兼容 API 基础地址和自己的 Key，保存后“测试图片与工具”。由交付人安全提供已验证地址，不自行猜测路径。测试发送真实图片并调用模型，有少量费用，通过后再执行任务。
3. **系统设置 → 任务执行**：首次生成并发和评测并发都设为 1，保留自动交接评测。核对时限、AI 跟进预算、优化目标和最大轮数；准备好后选择“持续执行”并保存。任务固定输入、规则和策略，修改默认值不会自动改写已开始任务。
4. **费用与经验**：检查价格版本、北京时间高峰 / 闲时规则；金额为用量估算，缺失数据不能视为零费用。经验库首次为空，可从后续任务沉淀。

Kooboo 的建站模型在 Kooboo 内配置，本地评测 / AI 跟进模型在本平台配置，保存一方的 Key 不会同时配置另一方。AI 跟进和经验学习复用平台模型凭据。同事的 `localhost:3000` 是同事自己的电脑，连接远端服务需用实际可达地址；生成站公开 URL 也须可达。

执行浏览器默认无头，排障时在“任务执行 → 本机运行 → 高级设置”开启“显示执行浏览器窗口”，仅对新启动会话生效，不替换活动会话；独立评测保持无头。

## 单任务交接验证

1. 资源库新建“AI Site 模板”，提供可访问的内容站 URL，此场景内容站兼作参考站；附件支持多文件和文件夹上传。
2. 勾选资源创建任务，先选“仅首页”，确认环境；自动优化时核对目标分数和最大轮数。
3. 启用队列，观察准备 → Kooboo 生成 → 独立评测；异常进入 AI 跟进或留下明确中断原因。不用重复创建任务处理投递状态不明的问题。
4. 任务详情核对当前版本报告、PC / 移动端证据、执行记录和站点累计费用。执行结束或有分数不等于可交付，需确认范围、必过项与当前版本。
5. 中断时修正连接 / 模型 / 桥接，再恢复原任务。停止状态不明时先核查原 Kooboo 会话，再按平台提示确认停止。
6. 出问题用“更多 → 导出排障包”，交维护者分析。包含平台数据、证据与可取得的 Kooboo 原生站点 ZIP；Kooboo 离线仍可导出平台部分及缺失说明。

单任务通过后再提高并发、批量导入或尝试全站。首页样稿可在原生成站继续生成全站，再取得新版本报告；全站完整性与 AI App 另行专项验收。

## 香港生成与德国交付

本机建站无需交付配置。需要跨环境时，在香港连接启用交付，填 `/api/sitemigrate` 完整 URL 和**独立迁移服务令牌**。去向由迁移服务决定，不需要添加德国连接或提供目标后台令牌；平台保存接口返回的目标 `siteId` / `siteUrl`，据此访问并核验交付站。迁移令牌不等于账号登录取得的 Kooboo 访问令牌。

流程为香港完整生成评测 → 迁移德国 → 交付核验。首次建议按需发起，完整性尚未验收时不能当作正式上线保证。回执不明确先核查，不能盲目重发。首版不处理正式域名 / DNS、覆盖既有目标站或增量同步。

## 日常运行、备份与更新

包含本次更新启动器的新 ZIP 后续通过侧栏版本号或“系统设置 → 检查更新”更新，默认来源为公开 GitHub 仓库 `achen-11/Kooboo-AI-Automation-Lab`。始终从原安装根目录运行 `npm start`；程序在版本目录间切换，实际数据路径保持固定。安装前检查活动工作、完整停机备份，再检查新版本；失败时成对恢复代码与数据。首次发布、旧包接入及恢复边界见 [在线更新说明](manual-updates.md)。下面的手工更换 ZIP 流程保留用于旧安装包接入和人工维护。

每天进入相同目录执行 `npm start`，不需重装。保持 Node 终端运行、供电并避免休眠；关闭网页不停止任务，关闭终端或休眠会中断。需要开机自启时再配置系统服务。同一数据目录仅运行一个实例。

平台会自动启动独立的后台执行子进程，无须另开终端启动 Worker；退出平台时会一并停止。健康接口 `workerReady` 表示执行进程是否就绪。后台意外退出时先保留原任务状态和错误，核实原 Kooboo 会话后再停机重启，不要通过重复新建任务恢复。启动升级版时会自动补齐轻量任务 / 核验报告索引，原报告与证据仍保留。生成浏览器关闭后的自动清理仅涉及可再生缓存，Cookie、会话恢复资料和业务证据不在清理范围内。

更新前暂停队列并等待活动任务结束；需中断时走平台停止流程并确认停止。终端 Ctrl+C，服务退出后备份**整个实际数据目录**。默认 `.data/` 包括数据库及 WAL、资料、截图、会话、`settings.enc` 和 `master.key`，必须一并保留。备份含凭据，不能作为软件交付包分发。

保留旧目录回退，新 ZIP 解压到新目录；停机后复制完整旧 `.data/`，安装依赖与 Chromium 再启动。全站采集需执行 `install:collection`；换电脑、换系统或更换项目路径后，不直接复用旧虚拟环境，把 `collection-runtime/` 单独移至备份位置后重新安装。不要重新生成已有主密钥。新版启动前保留数据备份，回退时同时恢复匹配的数据版本，不能假定新版数据库兼容旧代码。

修改源码后需 `npm run build`。真实任务期间不用 `npm run dev`，文件变动会重启 Worker。ZIP 不带 `.git`，不能直接 `git pull`；以后另行 clone 团队仓库并停机迁入完整数据目录，不用 `reset --hard` 或清空 `.data/` 处理更新。

高级部署可用 `EVALUATOR_DATA_DIR` 指定持久目录，安装采集环境与启动时使用相同值，工作目录始终为项目根。常规部署保留 4180，前端信任来源固定本机 4180 / 4181，不能只改监听端口就认为全部可用。`EVALUATOR_WORKER=off` 用于维护时禁用后台执行。

## 故障与远程协助

| 现象 | 处理 |
| --- | --- |
| Node / npm 找不到 | 安装 Node.js 24+，重开终端；Windows 用 `npm.cmd` |
| 4180 被占用 | 先查是否已有实例，不重复启动或随意杀其他服务 |
| 缺 Chromium | 同一服务用户执行 `npm run install:browser`，不复制其他电脑的浏览器目录 |
| Python 不符 | 安装 3.12，必要时设 `COLLECTION_PYTHON`，执行 `check:collection` |
| Kooboo 拒绝连接 / 401 | 检查服务、地址与令牌；Kooboo 的 3000 与平台 4180 是不同服务 |
| automation bridge 未就绪 | 确认配套 Kooboo 前端已部署，不是更换模型 Key 可以解决的问题 |
| 排队不执行 | 检查队列是否启用、并发是否占满、Worker 是否关闭 |
| `workerReady=false` | 后台执行进程尚未就绪或已退出；保留终端错误，核实原执行状态后停止并重启平台，不重复投递不确定的任务 |
| CLI / 模型失败 | 核对地址、Key、图片与 Responses 工具支持；`npm ci` 安装当前系统依赖，不复制个人全局 Codex 配置 |
| Windows 首次跟进 / 评测失败 | 尚无实机验收，导出排障包，不关闭沙箱、不删除检查点 |
| 有分数不能交付 | 核对当前版本、范围、双端目标、必过项和完整性 / 业务验证 |
| 直接请求 health 返回 401 | 管理 API 需本机会话，先从网页建立，401 不代表服务未启动 |

提供“排障包 + 操作时间 + 复现步骤 + 系统 / Node 版本”。启动就失败、尚无任务时提供终端错误与 `DELIVERY_MANIFEST.json`，不要发送 `.data/` 或密钥截图。平台文本会脱敏，Kooboo 原生 ZIP 与业务二进制保留原样，只交受信维护者。

服务仅绑定本机，没有公网用户认证，不能直接暴露整个服务。远程 Admin 的 127.0.0.1 指服务器自身，无法访问同事电脑；团队共享服务、HTTPS 和访问控制另行部署。统一接口见 [UNIFIED_AUTOMATION.md](UNIFIED_AUTOMATION.md)，旧评分 API 见 [PUBLIC_API.md](PUBLIC_API.md)。旧 Chrome 插件不是主流程必装项。

## 交付人制作 ZIP

在项目根目录执行，Python 3 仅用于制作 ZIP，接收者全站采集仍要求 3.12：

```sh
python3 scripts/package-platform.py --output /tmp/kooboo-automation-lab-2026-11-09.zip
```

默认要求 Git 工作区干净，在临时目录安装依赖并构建，打包源码、运行资源、匹配产物与逐文件清单。不改运行中的 `dist/`、`.data/`，不启动浏览器、模型或真实任务，不要求旧插件目录。

macOS / Linux 可加 `--reuse-dependencies` 复用本机匹配依赖构建，不把依赖打包。未提交方案需联调时显式加 `--allow-dirty`，清单标明测试快照与路径，不称为正式发布。接收者无需执行打包步骤。

交付前检查 ZIP 可解压、哈希匹配、不含运行数据或凭据，按最新进展更新验收边界。将 ZIP 和 `.zip.sha256` 一起交给同事。首次仍需联网安装依赖、浏览器及可选采集环境，不是离线免安装版。

2026-11-08 交接准备检查：打包边界 4 项测试通过；临时目录生产构建通过；测试包解压后独立安装 npm 依赖并重新构建通过，真实 Node 入口在临时端口启动、页面 / 会话 / 健康及空白队列检查通过，Codex CLI 版本检查通过。没有使用个人运行数据，没有浏览器控制、模型调用或站点任务；本轮没有重新安装采集 Python 环境，也未做 Windows 验收。构建保留现有超过 500 kB 的 bundle 提示。

2026-11-09 源码整理检查：普通 Node 回归 662 项通过、2 项跳过（真实浏览器与 Codex 沙箱用例关闭），Python 离线测试 56 项通过，服务端 TypeScript 检查通过。包含来源采集与冻结、程序迁移核验、分片资料读取、自主跟进及相关测试和资料；修复历史评测清单阻断新迁移基线接续的问题，保留独立评测扩充清单及来源归属校验。构建及解压启动的本次实际检查结果随 ZIP 放在 `DELIVERY_CHECKS.md`，不沿用上一包结果作为本包验收依据。
