# 评分平台交付与维护

适用：Site Evaluator 0.4.0；配套 Kooboo 建站插件 0.13.2。源代码、构建产物和文档交付；依赖、浏览器和个人数据由接收者本机安装/配置。

## 第一次启动

1. 安装 Node.js 24 或以上版本（含 npm）；将平台目录放在可长期保留的位置。不要直接在 ZIP 临时预览目录里运行。
2. 在平台根目录执行：

```sh
npm ci
npm run install:browser
npm run build
npm start
```

3. Linux 缺少 Chromium 系统依赖时，由运维执行 `npx playwright install --with-deps chromium`。普通启动保持非 root 用户；需要网络访问依赖仓库、目标/参考站、Kooboo 和模型服务。
4. 打开 `http://127.0.0.1:4180`，页面自动连接本机工作区。先保持终端中的 Node 服务运行。
5. 系统设置填写完整 Chat Completions 地址、模型名称、API Key，保存并主动点击模型测试。测试会发送真实图片和工具请求，可能产生模型费用；文本连通不等于支持评测。检查每阶段预算和采集次数。
6. 在环境连接中填写插件所用的 Kooboo 环境和有读取权限的令牌，平台从环境解析实际生成站和读取资料。仅凭 siteId 不能取得访问权限。
7. 平台设置页取得投递令牌、查询令牌，分别交给插件配置和 Admin 后端。新安装自动生成自己的令牌，不继承交付者个人配置。
8. 在插件设置填 `http://127.0.0.1:4180/api/evaluations`、投递令牌、查询令牌，规则版本留空使用默认规则。此地址指运行插件的同一台电脑。
9. 新建一项首页评测，查看截图、范围、分项引用和报告。真实模型和站点试跑由使用者执行，构建通过不等于模型/浏览器验收。

服务关闭会停止采集/评分，重新启动后从持久队列和检查点恢复。管理页关闭不停止任务。插件浏览器可关闭，但平台 Node 进程必须保持运行。多实例不得同时使用同一个 `.data/`。

## 两种协作方式

**每人本机运行**：同事安装插件和平台，自己配置模型/Kooboo，数据各自独立；Admin 如果在远程服务器，不能用服务器的 127.0.0.1 访问同事电脑。只分发软件不会自动形成共享数据库。

**团队共用实例**：选一台持续运行的机器配置平台，通过 HTTPS 为 Admin 后端开放只读 API；需要时另开插件投递和旧版单条查询。所有插件指向这个实例，才可集中查询这些插件提交的数据。用 `deploy/nginx-api.conf.example` 部署，替换域名、证书路径；不要公开整个 `/api/` 或管理登录入口。外部只读域名不提供管理 UI，插件的“打开报告”需管理员通过本机/隧道看管理页。

运行入口始终只绑定 127.0.0.1。同机反向代理把 Host 固定为 127.0.0.1:4180，透传 Authorization，清掉 Cookie，禁止非预期方法；Admin 后端调用不发送浏览器 Origin。示例配置提供可选的投递/单条查询 location（插件需要时启用），默认只开 v1 读取。生产域名、证书、网络访问控制和进程托管由部署者配置，此交付没有自动部署到公网。

远程管理可临时使用 SSH 隧道：

```sh
ssh -L 4180:127.0.0.1:4180 your-user@your-evaluator-host
```

然后访问自己电脑的 127.0.0.1:4180；本机端口须空闲。管理入口是本机权限模型，隧道只给受信管理员。跨机器共享文件目录不会共享插件本地授权或 Chrome 登录态。

## 后台运行

最简单是在专用终端运行 `npm start`。团队服务器用 systemd、launchd 或已有进程管理器托管，工作目录固定为仓库根、启动命令为绝对路径的 `node dist-server/server/main.js`，保持单 Worker 进程，并在进程退出时重启。Linux systemd 示例：

```ini
[Unit]
Description=Site Evaluator
After=network-online.target
[Service]
Type=simple
User=evaluator
WorkingDirectory=/opt/site-evaluator
ExecStart=/usr/bin/node /opt/site-evaluator/dist-server/server/main.js
Environment=EVALUATOR_DATA_DIR=/var/lib/site-evaluator
Restart=on-failure
TimeoutStopSec=60
[Install]
WantedBy=multi-user.target
```

先创建 evaluator 用户及可写的数据目录，并核对实际 Node 路径。Chromium 要以该服务用户安装，或设置服务可读的 `PLAYWRIGHT_BROWSERS_PATH`。`EVALUATOR_PORT` 可改监听端口，但当前 UI/修复接收的本机 Origin 白名单固定 4180/4181；常规部署保持 4180。`EVALUATOR_WORKER=off` 仅用于只读检查，不运行任务。

## 数据与更新

`.data/` 默认位于平台根：数据库、SQLite WAL、artifacts、master.key、settings.enc 都在里面。备份先优雅停止服务，再备份整个数据目录；备份包含密钥，应单独安全存储。恢复到新机器时恢复整个目录，使用相同 master.key。构建、更新不要删 `.data/`，也不要用交付包覆盖旧数据。已有插件的连接、目录授权、迁移记录在原 Chrome 用户资料中，不在平台包中。

用户建立远程仓库后，维护者首次推送：

```sh
git remote add origin <用户创建的仓库地址>
git push -u origin codex/initial
```

将远程默认分支设置为 codex/initial，或团队另行统一分支名。接收者首次：

```sh
git clone --branch codex/initial <仓库地址> site-evaluator
cd site-evaluator
npm ci
npm run install:browser
npm run build
npm start
```

日常更新：先停止服务、备份 `.data/`，确认 `git status` 干净，再执行：

```sh
git pull --ff-only
npm ci
npm run install:browser
npm run build
npm start
```

进程托管时最后一步改为重启对应服务。遇到本地改动先保留并处理，不用 reset --hard 覆盖；需要回退版本时同时评估数据库格式兼容性。远程建立前，源码 ZIP 可独立安装，但 ZIP 不包含 `.git`，不能直接 git pull；之后 clone 仓库并停机转移原 `.data/`。实际使用自定义数据目录时转移/备份那个目录。

## 接入入口和故障定位

- 同事日常用插件：读插件 `docs/USER_GUIDE.md`。
- Admin 建站协议：读插件 `ADMIN_INTEGRATION.md`；评测投递：`EVALUATION_INTEGRATION.md`。
- Admin 取评分数据：读本平台 `docs/PUBLIC_API.md`，运行 `examples/admin-query.mjs`。
- 同事的 Codex：先读 `docs/CODEX_INTEGRATION.md`。
- 401：检查令牌是否属于同一个平台实例、读写类型是否正确；403：检查 Host/Origin 和代理；排队不运行：检查是否暂停、Worker 是否启动；采集失败：查看阶段和 PNG 证据；只有完成度：核对参考站与图像能力。
- Launch 迁移与评分分别运行。迁移后返回的 Launch siteUrl/siteId 保存在插件中，平台当前仍评测投递时的生成站，不会自动把评测身份换成 Launch 域名。定制 Launch 仅为授权团队分发。
