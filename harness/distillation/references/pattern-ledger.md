# 外部站点反馈脱敏规律台账（Pattern Ledger）

本台账仅记录**完全脱敏**后的通用问题指纹、出现频次与工程落点状态。
**红线**：严禁写入任何客户公司名、人名、真实域名、URL、电话号码、邮箱或具体地名。

## 台账字段说明
- **ID**：`PAT-NNN`
- **状态**：
  - `observing`：仅记录观察，尚未进入全局硬规则（需 `>= 2` 个独立站点复现后再评估晋升）
  - `landed-L1` / `landed-L2` / `landed-L3` / `landed-L2+L3` / `landed-L1+L2+L3` / `landed-L3+evaluator`：已下沉到对应平台层级
  - `L4-profile-only`：仅保留为特定业务画像（如外联预览）或任务输入偏好，不进全局硬约束
  - `rejected`：经评估会引入误伤或与更高优先级原则冲突而驳回
- **occurrences**：在不同脱敏站点案例中独立确认的次数

---

## 已收录模式

| ID | 来源案例（脱敏） | 问题指纹与根因摘要 | 类别 | occurrences | 落点层级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `PAT-001` | `2026-11-26 · classic-auto-restoration` | `upgrade` 场景照搬参考模板高饱和科技蓝，脱离传统实体老店原有品牌色与行业气质；旧规则要求严格对齐参考站色彩角色导致生成/评测打架 | 策略冲突（选项 A 定案） | 1 | L3 (`shared/automation.ts`, `site-ui-rules.ts`) + Evaluator (`bounded-checker-rules.ts`) | `landed-L3+evaluator` |
| `PAT-002` | `2026-11-26 · classic-auto-restoration` | 旧站同时存在白天座机与 24/7 紧急手机热线，生成站只保留座机却写 24/7 文案，且联系入口缺少完整 `tel:`/`mailto:` | 真缺口（转化信任） | 1 | L2 (`R-TRUST-01`) + L3 (`site-ui-rules.ts`) | `landed-L2+L3` |
| `PAT-003` | `2026-11-26 · classic-auto-restoration` | PC 首屏顶部留白过多导致 Hero 浮层信息卡被视口底边腰斩截断；同一创立年份/定位标签在 Hero 内连续重复 3 次 | 已有规则漏检 | 1 | L1 (`HERO_FOLD_CLIPPED.overlayCardBottom`, `CONTENT_DUPLICATION.heroRepeatedBadges`) + L2 (`R-LAYOUT-04`, `R-DUPE-01`) + L3 | `landed-L1+L2+L3` |
| `PAT-004` | `2026-11-26 · classic-auto-restoration` | 缺少合作方 Logo 时把 4 张实拍照片缩灰硬塞进 Logo 墙槽位，或为凑 4 格指标硬编无说服力数字 | 真缺口（高频套模板破绽） | 1 | L2 (`R-TRUST-01`) + L3 (`site-ui-rules.ts`) | `landed-L2+L3` |
| `PAT-005` | `2026-11-26 · classic-auto-restoration` | 来自旧站的低清图（`naturalWidth < 600px`）被强行拉满大横幅或大尺寸卡片导致发虚 | 真缺口（可 100% 机检） | 1 | L1 (`LOW_RES_IMAGE_UPSCALE`) + L2 (`R-VISUAL-02`) + L3 (`site-ui-rules.ts`) | `landed-L1+L2+L3` |
| `PAT-006` | `2026-11-26 · classic-auto-restoration` | 同一张实拍业务图在 Hero 与下方优势区/画廊重复出现，削弱专业质感 | 阈值收紧（原 `<=2` 收紧至 `<=1`） | 1 | L1 (`CONTENT_DUPLICATION.duplicateImages >= 2`) + L2 (`R-DUPE-01`) + L3 (`site-ui-rules.ts`) | `landed-L1+L2+L3` |
| `PAT-007` | `2026-11-26 · classic-auto-restoration` | `homepage`（仅首页）模式下导航或卡片 CTA 仍指向未生成子页路径，引发点击 404 风险 | 真缺口（可 100% 机检） | 1 | L1 (`HOMEPAGE_SUBPAGE_LINK`) + L2 (`R-TRUST-01`) + L3 (`site-ui-rules.ts`) | `landed-L1+L2+L3` |
| `PAT-008` | `2026-11-26 · classic-auto-restoration` | 页面残留未本地化的外部图片/旧站 `http://` 资源，触发 HTTPS 拦截或跨站请求风险 | 真缺口（可 100% 机检） | 1 | L1 (`EXTERNAL_OR_INSECURE_ASSET`) + L2 (`R-TRUST-01`) + L3 (`site-ui-rules.ts`) | `landed-L1+L2+L3` |
| `PAT-009` | `2026-11-26 · classic-auto-restoration` | 外联预览首页建议控制在 5–7 个板块（约 4,000–5,500px）防止过长疲劳 | 业务画像偏好（外联场景） | 1 | L4（观察中，不进全局硬约束） | `observing` (`L4-profile-only`) |
| `PAT-010` | `2026-11-26 · classic-auto-restoration` | 外籍客群地区商家资料建议提供轻量双语切换（NL/EN），新站未落地 | 资料驱动/业务画像偏好 | 1 | L4（按资料显式清单或外联画像触发） | `observing` (`L4-profile-only`) |

---

## L1 确定性探针目录（Deterministic Probes）

以下探针在 `server/automation/visual-precheck.ts` 中于真实 Playwright 渲染阶段自动采集并传入评测前置上下文：

| 探针信号码 | 检测目标 | 绑定规则 ID | 典型缺陷 |
| --- | --- | --- | --- |
| `HERO_FOLD_CLIPPED` | 首屏标题 `h1`、主 CTA 按钮及 Hero 浮层信息卡底边是否越过首屏视口下沿 | `R-LAYOUT-04` | Hero 卡片/按钮被首屏底边腰斩裁断 |
| `HOMEPAGE_SUBPAGE_LINK` | `homepage`（仅首页）模式下仍指向 `/services` 等未生成子页的导航或卡片 CTA | `R-TRUST-01` | 仅首页范围下存在点击 404 死链 |
| `LOW_RES_IMAGE_UPSCALE` | `naturalWidth < 600px` 的低清旧站图片是否被拉伸至宽幅横幅或大图容器 | `R-VISUAL-02` | 小图强行拉满大横幅导致明显模糊 |
| `EXTERNAL_OR_INSECURE_ASSET` | 生成站点是否残留外部域名图片或旧站 `http://` 不安全资源引用 | `R-TRUST-01` | 资源未本地化或触发 HTTPS 混合内容拦截 |
| `CONTENT_DUPLICATION` | 同页图片重复使用（`>= 2` 次）、Hero 创立年份/定位徽章连续复读、文案标题重复 | `R-DUPE-01` | Hero 与下方画廊重复贴图、首屏 `Sinds YYYY` 连续复读 |
| `SPLIT_HEIGHT_IMBALANCE` / `IMAGE_VISIBILITY_ISSUE` | 图文分栏高度比例失衡、图遮字/文字对比度或图片不可见 | `R-LAYOUT-02` / `R-VISUAL-03` | 分栏极度不对称或浅色文字压在亮背景上 |
| `MIN_FONT_SIZE` / `TITLE_LINES_EXCEEDED` | 正文最小字号过小、Hero/卡片标题行数超限 | `R-LAYOUT-01` / `R-LAYOUT-03` | 移动端字号难以阅读或标题过多折行 |
| `LOCALE_OR_DATE_ISSUE` / `MOBILE_MENU_TRAPPED` | 多语言/本地化混杂、过时年份或移动端汉堡菜单无法正常收放 | `R-TRUST-01` / `R-LAYOUT-05` | 语言混杂、过时版权年份或移动菜单交互失效 |
| `HERO_SVG_PLACEHOLDER` / `CARD_SVG_PLACEHOLDER` | Hero 或展示卡片用大块几何 SVG 替代真实摄影配图 / `imagePlaceholder` | `R-VISUAL-01` | 大型 SVG 假图占位 |

---

## 新增模式记录模板

```markdown
| `PAT-NNN` | `YYYY-MM-DD · <industry-slug>` | <去除了客户/域名/地名的通用问题描述> | <漏检/冲突/真缺口/画像偏好> | 1 | <L1/L2/L3/L4> | `observing` |
```
