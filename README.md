# dsh-stats-sparkline

在 DSH Web GUI「对话框最下方那行统计」里做两件事：

1. 用**遮蔽（shadowing）**接管官方统计单元格，弹窗里除原有数值外再显示一块**随时间变化的折线图**；鼠标移到药丸上即弹出，不用点击。
2. 新增一个属于本插件的 **Token 构成 chip**（输入 / 缓存 / 输出），把原先由 `dsh-cost-meter` 那一行承担的 token 数字接过来，并给它同样的悬停折线图。

接管方式：`conversation.composer.dock` 是 **list 槽**，条目身份是 `(id, priority)`，同一个 `id` 上**优先级最低的那条渲染**。所以必须按下表占住 ui-chat 真正注册的两个 id（2026-11-10 校准，此前用的 `id: 'stats'` 已不存在于装配里）：

| 槽位 id | 谁注册 | 本插件 |
|---|---|---|
| `activity`（`order: 0`，`N 轮 M 步 · X tok/s`） | ui-chat | `priority: -1` 遮蔽，换成自己的组件 |
| `usage`（`order: 1`，`总量 tok · 缓存命中 P%`） | ui-chat | `priority: -1` 遮蔽，渲染 `null`（上方 `activity` 单元已经画了这两颗药丸） |
| `cost-meter`（`order: 5`） | dsh-cost-meter | `priority: -1` 遮蔽，渲染 `null` |

**id 写错不会"遮蔽"，只会多出一行** —— 这正是此前底部出现两对完全相同的药丸（`1 轮 15 步 · 107 tok/s` + `1M tok · 缓存命中 87%` 各两份）的原因：`priority: -1` 加在一个装配里不存在的 id 上，等于无操作。

因此：

- 药丸的文案、数字口径与原版逐字对齐（`N 轮 M 步 · X tok/s`、`总量 tok · 缓存命中 P%`）；唯一的例外是 tok/s 改为**实时值**（见下）；
- 弹窗保留原有的全部明细行（含 `data-session-stats-usage` / `data-session-stats-details` 两个钩子），只在下面追加图表；原口径的「本会话平均速度」也保留为单独一行；
- 本源文件一旦出错被渲染器 abdicate，官方那行统计会**自动回来**（`dsh-client-ui-renderer` 的遮蔽回选语义），最坏情况等于没装。

## 实时 tok/s（`LIVE_WINDOW_MS`）

药丸上的 tok/s 不再用「全会话 `ΣdecodeTokens / ΣdecodeMs`」——那个数字在几步之后就基本不动，看不出模型是刚加速、卡住还是已经停了。现在它取**最近 30 秒窗口的池化解码速率**：`ΔdecodeTokens / ΔdecodeMs`，窗口内没有任何解码时（单步还在流式输出首 token、工具调用中、空闲）**保持最近一次测得的步速率**，而不是清空。

口径边界（必须知道）：`sessionStats.decodeMs / decodeTokens` 是对已提交 `step/end` 事件的折叠，**粒度是一步，不是逐 token**。所以一个很长的单步只会在该步结束时刷新这个数字；逐 token 的实时速率不在这个投影里。弹窗里同时给出「最近 30 秒」与「本会话平均」两行，方便对照。

## 度量口径（本插件的核心约定）

| 量 | 类型 | 画法 |
|---|---|---|
| 缓存命中率 | 比率 | **窗口合并比率**：窗口内分子分母分别求和再相除（token 加权），即 `ΣcacheRead / Σ(未缓存输入 + cacheRead + cacheWrite)` |
| 输出速度 | 比率型速率 | 窗口合并：`ΣΔdecodeTokens / Σ(ΔdecodeMs/1000)` |
| 总 token / 输入 / 缓存 / 输出 | 计数累计量 | **对时间微分**：各自 `ΣΔ计数 / ΣΔt`（tok/s） |

**比率不做微分，也不用逐样本比率的算术平均。** 例：请求 A 命中 9990/10000（99.9%），请求 B 命中 0/10（0%）——窗口合并为 `9990/10010 = 99.80%`；若按逐样本比率取平均会得到 49.95%，被小请求彻底带偏。这条规则有决定性单测守着（`test/series.test.mjs`）。

窗口档位：`30秒 / 1分（默认）/ 5分 / 全程`，在弹窗内即时切换；会话短于窗口时用会话起点并在坐标轴标「起点」。

## 纵轴范围（按量分别定，而不是一律 0–100 或 0 起）

各量的"合理范围"差别很大，所以纵轴按量取窗口（`fitAxis`）：

| 量 | 典型范围 | 纵轴 |
|---|---|---|
| 缓存命中率 | 长会话稳定态 **90–99.9%**（健康缓存）；冷启动首请求可低至 0%；窗口内无新输入时为断点 | **拟合**：以数据跨度取带，最小跨度 2 个百分点，向外吸附到 1/2/2.5/5×10ⁿ 的整齐刻度，并夹在 [0,100] 内 |
| 消耗速率 / 输入 / 缓存 / 输出（计数微分） | 0 到上万 tok/s（一次性塞入 2 万 token 的请求就是万级尖峰）；空闲为 0 | **有 0 才用 0**：只要窗口内最低值 ≤ 峰值的 30%（含空闲），仍以 0 为基线——掉到 0 本身是信息 |
| 输出速度 | deepseek-flash 常在 **30–120 tok/s** | 同上：稳定在 40–55 时才会拟合（否则一样是贴顶直线） |

- 命中率之所以必须拟合：97–100% 落在 0–100 轴上只占顶部 3% 高度，必然画成一条直线；拟合后 99.8–99.9 的波动才看得出来。
- **拟合不是静默的**：纵轴被缩小时，页脚会写明范围（如 `窗口 1分 · 会话累计 98.2% · 纵轴 99–100%`），且纵轴**上/中/下三个刻度都带标签**，不会让人把 1 个百分点的抖动误读成大变化。
- 无数据、单一数值、全等值都退化处理：仍给出非零高度的带（命中率最小 1 个百分点），不会出现零高度或 NaN。

### 二号纵轴（右侧）：量级差太大时把小的那条单独放大

同一个图里两条线量级差一个数量级以上时，共用纵轴会把小的那条按在底部——例如时间药丸的「速率」：消耗速率常在上万 tok/s，而输出速度只有几十。规则：

- 取每条线的峰值；峰值 **低于最大峰值的 1/4** 的线移到**右侧二号纵轴**（`AXIS_SPLIT_RATIO = 4`，可调）；1:1～1:2 仍共用左轴，不轻易分轴；
- 两条轴**各自独立拟合**（各自也能缩放），小的那条在自己的轴上占满高度，小变化看得见；
- **右侧刻度用该线自己的颜色**绘制，图例里被移走的线标注「（右轴）」，页脚写明「纵轴 左 … · 右(二号轴) …」——三处都在说明"这是两个刻度"；
- 分轴时右侧留白从 4px 增到 26px 给刻度文字（`CHART_PAD_RIGHT_DUAL`），绘图区相应变窄，弹窗宽度不变；
- 命中率视图**永不**分轴（两条线都是百分比，天然同量级）。

### 各胶囊的动态纵轴核查（全部具备）

| 胶囊 | 视图 | 动态纵轴 | 分轴 |
|---|---|---|---|
| 时间药丸 | 速率 | 有（整段远离 0 时拟合；出现真实 0 时保留 0 基线，因为 0 本身是信息） | 输出速度常被移到右轴 |
| token 药丸 | 命中率 | 有（百分比永远拟合，最小 1 个百分点） | 不需要（两条都是 %） |
| Token 构成 chip | 构成 | 有（同"速率"规则） | 输出常被移到右轴 |

这三条都有单测守着（`every view zooms its left axis`、`a 100x magnitude gap moves the small line to a second axis`、`the breakdown view gives a small output line its own axis`）。

## 交互

- **悬停即开**：指针进入药丸/chip 180 ms 后打开弹窗（原版是点击开；本插件保留点击并补上悬停）。
- 指针离开 250 ms 后自动关闭；**点击可固定**；`Esc`、点击外部照旧关闭。
- **每个座位只画自己的量**（没有指标切换键，因为两个药丸的图本来就不是同一件事）：
  - 时间药丸 → `速率`：消耗速率 + 输出速度（tok/s）
  - token 药丸 → `命中率`：窗口命中率（实线）+ 会话累计（虚线）
  - Token 构成 chip → `构成`：缓存 / 输入 / 输出 三线（tok/s）
  唯独**时间窗口**仍可切换（`30秒 / 1分 / 5分 / 全程`），因为那是"看多远"的问题，不是别的座位的重复。
- 可访问性：图表是 `role="img"` 并带文字摘要，颜色全部取宿主主题令牌（`--dsw-*`，含 `state-success` / `state-warn`），深浅色自动适配，无动画。

## 那一行现在长这样

```
[ 表盘: N 轮 M 步 · X tok/s ]  [ 总量 tok · 缓存命中 P% ]  [ 输入 … · 缓存 … · 输出 … ]      [ 上下文已用 Q% ]
   └─ 悬停/点击 → 会话统计 + 图        └─ 悬停/点击 → Token 用量 + 图      └─ 悬停/点击 → Token 构成 + 图
```

- 该行**只有一个缓存命中率**（stats 药丸上的那个）；Token 构成 chip 只放 输入 / 缓存 / 输出，不含比率、不含百分号（有单测守着这条）。
- 底部**只有一对**统计药丸：`activity` 单元由本插件接管（其中已经画了 token 总量 + 缓存命中），`usage` 单元被遮蔽成空，所以不会出现"两份一模一样"的行。
- Token 构成 chip 的 `id` 是 `stats-tokens`（全新 cell、`order: 10`），不是遮蔽，所以不会顶掉任何插件。
- Token 构成 chip 与药丸**共用同一套字号/行高**（`--dsh-content-font-size-secondary - 1px`）：chip 是独立单元格，继承不到药丸那层的排版，所以样式里对 `.dss-root, .dss-anchor` 同时声明（有单测守着这条回归）。
- **已知边界**：ui-chat 的「统计显示方式 = 详细/紧凑」(`performanceUsage`) 不会被本行继承。该模式存在 ui-chat 模块私有的 `PerformanceUsagePolicy` store 里，作为 entry 级注入的 observable 传入，客户端插件拿不到；因此这一行始终按「详细」渲染（本机配置本来就是 `detailed`，无实际差别）。

### 重复信息块的处置：认领 cost-meter 那一格（不改它的包、不读 DOM）

`dsh-cost-meter` 在**同一行**注册了 `id: cost-meter`（`order: 5`），文案模板是
`本会话 {amount} · 命中 {hitRate} · 输入 {input} · 缓存 {cache} · 输出 {output}`：它的命中率与左边的 token 药丸重复，它的输入/缓存/输出与本插件的 chip 重复。

本插件的做法是**用同一套官方遮蔽机制认领该单元格并渲染空内容**（`id: 'cost-meter'`、`priority: -1`、组件返回 `null`）：

- 不改 cost-meter 的包、不改它的配置、不读它的 DOM、不写它的账本；
- 停用本插件，那一行**原样回来**（遮蔽型 entry 消失即回选）；
- 开关是本文件里的常量 `SUPPRESS_COST_METER_LINE`（默认 `true`）。想保留那行就置 `false`；
- 金额/额度不受影响：cost-meter 的**侧边栏卡片**仍在（`sidebar.footer.action`），只是不再占这一行；
- 也可以换成它自己的设置：设置 → 插件 → dsh-cost-meter → 显示设置 →「会话费用显示位置」→ 关闭。两种方式并存不冲突（它的配置存在自己账本的 `config.position`，loader 层改不动，所以本插件没有去写那个文件）。

## 数据来源

只读宿主已有的两个**全会话累计**投影，不新增任何采集通道、不落盘 `$DSH_HOME`：

- `useProjection('tokenUsage')` → `uncachedInputTokens / cacheReadTokens / cacheWriteTokens / outputTokens`
- `useProjection('sessionStats')` → `turns / steps / llmMs / toolMs / ttftMs / ttftSteps / decodeMs / decodeTokens`

采样时机：任一投影变化时 + 每 5 s 心跳（滚动窗口需要时间轴上的点），**采样只发生在 stats 单元格里**，Token 构成 chip 只读同一份序列（模块级订阅，不重复采样）。每会话保留最近 720 个累计样本、内存里最多 8 个会话；曲线另镜像进 `sessionStorage`（键 `dsh-stats-sparkline:v1:<sessionId>`，最多 300 样本、节流 2 s），因此**刷新页面曲线不丢**。累计量出现回退（revert/分支重放）时序列重启，绝不画负增量。

## 安装（本机现状）

已经装进 `desktop` profile，无需再操作：

- 源码：`~/.dsh/plugin-src/dsh-stats-sparkline`
- profile 接线：`~/.dsh/profiles/<profile>/package.json` 的依赖 `"dsh-stats-sparkline": "file:<本地插件目录>/dsh-stats-sparkline"` 与 `dsh.profile.bundles` 末项
- `pnpm install --prefer-offline` 已执行（`node_modules/dsh-stats-sparkline` 是**普通拷贝目录，不是软链**）

> ⚠️ 改完源码必须**把 `client.js` 拷进 profile 的 `node_modules`**，否则应用读到的还是旧产物（2026-11-10 实测踩过：`plugin-src` 已改、`profiles/desktop/node_modules/dsh-stats-sparkline/client.js` 仍是 11-09 的旧字节，md5 不同）：
>
> ```bash
> cp ~/.dsh/plugin-src/dsh-stats-sparkline/client.js \
>    ~/.dsh/profiles/desktop/node_modules/dsh-stats-sparkline/client.js
> ```
>
> 也可以重跑 `pnpm install`，但那会连带处理整棵依赖树，改一行文件不值得。

**生效方式（2026-11-10 实测修正）：只硬刷新页面是不够的。**

`dsh-client-modules` 在 **host 启动时**完成组合（`this.composed = this.compose()`），bundle 字节在**首次 GET 时一次性读入并持有**（`readClientBundle` + 按 mtime/ctime/size 生成的 revision URL，`IMMUTABLE_CACHE`）。页面刷新拿到的还是同一份会被浏览器缓存的 `__DSH_BOOT__` 图与同一个 revision URL，所以**旧字节继续生效**——实测：改完 `client.js` 后硬刷新，底部仍是重复的两行。

改 `client.js` 后要让它重新进表，二选一：

1. **重启 DeepSeek Harness 应用**（最稳）；或
2. 设置 → 插件 → `dsh-stats-sparkline` 关掉再开（entry 重启触发 `internal/plugin` → `flush()` → `reconcilePackage()` 重读 bundle，revision 与 URL 随之改变），**然后硬刷新页面**。这条路不用重启宿主，会话不中断。

## 安装（其他机器 / 社区）

本包是标准 dsh **bundle**：`package.json` 声明了 `dsh.bundle.patch` 与 `dsh.client`，`exports["./client"]` 提供已构建好的浏览器半区（**仓库自带产物，安装不需要任何构建步骤或构建权限**）。

```bash
# npm（发布后）
dsh plugin --profile web add dsh-stats-sparkline
# GitHub 仓库
dsh plugin --profile web add github:<owner>/dsh-stats-sparkline
# 本地目录 / tarball
dsh plugin --profile web add link:/path/to/dsh-stats-sparkline
dsh plugin --profile web add ./dsh-stats-sparkline-1.0.0.tgz
```

桌面端由 Electron 应用独占管理，用「设置 → 插件 → 安装」填包名或 tarball 地址，装完重启应用。

## 提交到插件市场（清单与现状）

市场发现机制（实测 `dsh-plugin-marketplace@0.4.0` 源码 `client.js`）：

1. 用 **GitHub 搜索 `topic:dsh-plugin`** 列出候选仓库，读 README 呈现详情；
2. 用 **npm registry `/latest`** 判断该包是否 bundle（看 `dsh.bundle.patch`）以给出一键安装提示。

所以上架需要的就是"一个带 `topic:dsh-plugin` 的公开 GitHub 仓库 + 一个可安装的 npm 包"。本仓库/工程内已就绪的部分：

- [x] `dsh.bundle.patch` + `dsh.client{platform,immediately,inject}` + `exports{"."," ./client","./package.json"}`
- [x] 预构建产物 `client.js`（classic script，`window.__ModuleLoader__.load`），安装无需构建
- [x] `README.md`（说明 + 度量口径 + 安装/回退）、`LICENSE`（MIT）
- [x] 包元数据：`keywords`（含 `dsh-plugin`）、`engines`、`publishConfig.access=public`、`dshhub` 清单块
- [x] 30 项单测（`node --test`，零依赖、不需要宿主即可跑）
- [x] npm 名称 `dsh-stats-sparkline` 已确认**未被占用**（registry 返回 404）

仍需人工完成（涉及你的账号与外部发布，本代理不代为执行）：

- [ ] `package.json` 补 `repository` / `homepage` / `bugs`（需你定下仓库地址，未定前不宜填假地址）
- [ ] 建公开 GitHub 仓库并在仓库 **Topics 里加 `dsh-plugin`**（这是市场唯一的发现入口）
- [ ] `npm publish`（需 `npm login`，2FA；包体不含 `test/`，见 `files`）
- [ ] 发布后回填 README 的安装命令示例与仓库链接

发布前建议跑一遍：`node --test test/series.test.mjs test/registration.test.mjs test/render.test.mjs`，并确认 `client.js` 仍是 classic script（0 条 `import`/`export`）。

## 开发循环

```powershell
$node = "node"   # 或你的 node 可执行文件绝对路径
& $node --test test/series.test.mjs test/registration.test.mjs test/render.test.mjs   # 在插件目录下
```

- 改 `client.js`：**源码目录与 profile 的 `node_modules` 副本是两份独立文件**（不是硬链接；2026-11-10 实测 md5 不同），改完必须拷过去再硬刷新：
  `cp client.js "$HOME/.dsh/profiles/desktop/node_modules/dsh-stats-sparkline/client.js"`
  （忘了这一步 = 应用仍跑旧产物，这是最容易误判"改了没生效"的地方。）
- 改 `index.js` / `cordis.patch.yml` / `package.json`：需要重启应用。
- 生产环境下 bundle 的 `__internals` 测试缝不会暴露（有单测守着）。

## 独立鲁棒性审计（2026-10-01，只读子代理）与处置

审计对象：`client.js` 1,614 行（当时 sha256 `3ceaf623…`）；结论"无高危缺陷"，给出 9 条发现。处置如下：

| # | 严重度 | 问题 | 处置 |
|---|---|---|---|
| 1 | 中 | `buildChartModel` 把非 session 窗口一律标成「1分」——选 30秒/5分 时 aria 摘要、页脚、左轴 `-1m` 全在说谎 | **已修**：`windowIdOf(ms)` 反查 preset；新增"每个 preset 自称其名"的测试 |
| 2 | 中 | `useChat(snapshot => snapshot.legacy.nodes)` 在 render 里裸解引用，快照形状不符即抛 → 统计行整体挂掉而不降级 | **已修**：逐层判空后再取 `nodes`；新增 6 种畸形快照的降级测试 |
| 3 | 低 | `projected !== undefined` 后紧跟 `stats.decodeMs` 裸解引用（宿主自己用 `??`） | **已修**：改 `projected != null` |
| 4 | 低 | 命中率精度循环在 `cacheRead > prompt`（负 miss）时无限 ×10 → 渲染线程死循环 | **已修**：`missedInputTokens <= 0` 直接返回；新增敌意计数测试（`(200,100)`/`(-5,100)`） |
| 5 | 低 | 降采样对"已合并比率"再做无权平均，超过 96 点后违反本文件自己的口径声明 | **已修**：点位携带原始增量，降采样改为**分桶再合并**（比率 Σ分子/Σ分母、速率 Σ增量/Σspan、水平量取桶尾）；新增决定性测试（99.9% vs 无权 50%） |
| 6 | 低 | 只判 `seat.pos === null`，`undefined` 会摆错位；定位永久失败时面板一直隐藏且无提示 | **已修**：`== null`；连续 500ms 未拿到定位则 `console.warn` 一次（说明可能是宿主选项名漂移） |
| 7 | 低 | chip 的曲线更新完全依赖 stats 单元格当采样器；若别的插件以更低 priority 赢下 `stats`，chip 曲线会冻住 | **已修**：抽出 `pushSample`/`seriesAgeMs`，chip 具备**待机采样**（仅在序列陈旧 > 2×心跳时补点，不与主采样器叠加频率） |
| 8 | 低 | 四个窗口按钮各自有标签，但容器没有组语义 | **已修**：容器加 `role="group"` + `aria-label`（新增 `windowGroup` 键） |
| 9 | 低 | `${cacheHit}%`、`-${windowText}`、分隔符 `·` 绕过 `t()` | **部分修**：百分比改走 `percentValue` 模板；`-`/`·` 属标点而非文案，**有意保留**（已在此记录） |

审计同时确认（无需改动）：所有 hook 都在提前 return 之前、定时器/监听器都有清理、缓存有界（8 会话/720 样本/300 持久化/定时器自删）、比率全部 Σ分子/Σ分母 且有 `> 0` 守卫、非有限值在两条渲染路径都被过滤、`Math.min/max` 展开数组 ≤288 元素、storage/`JSON.parse`/portal/primitives 全部包了 try、字典零死键（46 zh = 46 en）、classic-script 契约完好。

审计**未能确定**的三点（本仓库已知边界）：`useChat` 快照在 0.2.0-rc.2 的真实形状（只在 asar 里确认了 `useChat` 存在，故按畸形输入做降级）；`useAnchoredPosition` 是否可能返回 `undefined` 或选项名漂移（已加一次性告警）；宿主是否真的尊重 `priority: -1`（我这边在 `dsh-client-ui-slots` 源码里读到"最低 priority 渲染"与 abdicate 语义，但那是库层，插件层声明未逐字核对）。

## 测试覆盖（46 项，全部通过）

- bundle 形态：classic script、无 `import`/`export`、`id` 等于包名、生产态无测试缝；**非浏览器环境（没有 `window`）只惰性退出而不抛错**，浏览器里缺 `__ModuleLoader__` 才报清晰错误。
- 清单可安装/可发布：`dsh.bundle.patch`、`dsh.client`、`exports`、`files` 逐个存在、非 `private`、含 `dsh-plugin` 关键词、`publishConfig.access=public`。
- 注册契约：三个 cell（`stats` 遮蔽 `priority:-1`；`stats-tokens` 新 id、`order:10`；`cost-meter` 遮蔽 `priority:-1` 且渲染 `null`）；字典含中英两套且药丸文案与原版一致；slot 不可用/重复注册/字典冲突/风格注入失败/**`ctx.effect` 通道本身被拒**时都只告警不抛错，且三个 cell 仍照常注册；chip 与药丸共用排版（回归守卫）。
- 口径数学：窗口合并比率（含 9990/10000 与 0/10 的决定性反例）、有限窗口边界、会话起点在环形缓冲裁剪后仍可用、累计量微分、无新 token 时留空、降采样保留断点、"构成"页签三线各自微分、图表模型三个页签与"数据不足"分支。
- 纵轴策略：比率贴天花板时拟合且封顶 100%（并断言页脚写出 `纵轴 99–100%`）、大范围比率保留 0–100、全等值仍有 ≥1pp 带、速率含 0 或尖峰时保持 0 基线、速率稳定在 40–55 时拟合为 [30,60]、单值/空值不产生零高度或 NaN、刻度取整与百分比文案；**量级差 ≥4× 时小量走右轴且左右各自拟合**（左刻度是 K、右刻度是几十）、可比时保持单轴、三种视图都有动态纵轴。
- 渲染烟测（桩 React 同步求值，含 `forceOpen` 打开内部弹窗）：行门控、药丸文案、弹窗保留原明细行并带 SVG、空闲态提示、portal 首帧测量态、纵轴上/中/下三个标签、**分轴时右侧三个刻度带该线颜色且图例标注「（右轴）」与页脚「二号轴」**、**每个座位只渲染自己那一种曲线**（并断言其它座位的图例不出现）、**Token 构成 chip 不含命中率/百分号**。
- 文案卫生（`test/locale.test.mjs`）：中英字典键集完全一致、**没有只定义没人读的键**、每个 `{占位符}` 都在调用点被真实传入（防止把字面量 `{count}` 渲染到界面上）。

## 已知限制

1. **不跟随 `performanceUsage` 的 compact 模式**：那是 ui-chat 私有 inject face，本插件接管单元格后一律按 detailed 布局渲染（当前 profile 配置正是 `detailed`）。
2. **历史从插件加载那一刻开始**：不回溯插件启用前的会话（Phase 2 可加 host 半区订阅 `llm/stream` 落盘后回填，社区同类插件 `@zerro223/dsh-token-usage` 是这个形态）。
3. 只有 1 个样本时不画线（显示「已采集 N 个样本」）；孤立点只画点不画线。
4. Token 构成 chip 只有 token，没有金额/额度（那是 cost-meter 的账本；金额仍在它的侧边栏卡片）。
5. 本插件默认会**认领并清空 cost-meter 的那一行**（见上）；这是对另一个插件 UI 的主动处置，若你不认同把 `SUPPRESS_COST_METER_LINE` 置 `false`。
5. 若未来 ui-chat 改了 dock 单元格的 id/priority 语义，最坏结果是多出一个统计行或本插件不生效（官方行回归），不会破坏界面。
6. 与其它遮蔽同一 `stats` 单元格的插件（如 `dsh-bottom-info-bar`，`priority:-1000`）共存时只有最低 priority 者渲染。
7. `sessionStorage` 曲线缓存在标签页关闭后消失（有意为之：不写 `$DSH_HOME`，回退零残留）。
8. 采样是"事件 + 5 秒心跳"：会话完全空闲时曲线会画成一条水平线（没有新 token 本来就是平的）。

## 回退

1. 「设置 → 插件」停用 `dsh-stats-sparkline`；或
2. 从 `~/.dsh/profiles/desktop/package.json` 删除该依赖与 `dsh.profile.bundles` 中的条目，重跑 `pnpm install`，重启应用。
3. cost-meter 那行：本插件默认已认领清空（把 `SUPPRESS_COST_METER_LINE` 置 `false` 即可恢复），或在其设置页把「会话费用显示位置」改回「输入区下方」。

本插件不写任何 `$DSH_HOME` 数据文件（只在浏览器 `sessionStorage` 留一条曲线缓存），回退无数据残留。

## 验证状态

- **已实测**：28 项单测通过；patch YAML 与工作正常的 `dsh-reduce-effects` 同构；profile 依赖/硬链接/锁文件/入口文件均存在；改后的 profile `cordis.patch.yml` 用 js-yaml 校验通过（10 条、无重复 id、`position` 解析为字符串 `"off"`）。
- **源码确认**：`dsh-client-ui-slots` 的 list 单元格"最低 priority 渲染"与 abdicate 语义；`conversation.composer.dock` 为 `list`/`session` 作用域、dock 行是居中 flex + 12px gap；原版药丸为点击开、弹窗无 child slot（因此只能遮蔽单元格）；cost-meter 的 `position` 取值与设置项文案（`positionDock:"输入区下方"`、`positionLabel:"会话费用显示位置"`）；格式化函数与 locale 文案取自官方 `token-format.ts` 与 ui-chat 字典。
- **未验证（需你重启后确认）**：GUI 里的实际观感与交互 —— 悬停是否按要求弹出、图表位置与配色、Token 构成 chip 与 stats 药丸并排的观感、cost-meter 那行确实消失、真实数据下曲线是否与药丸数字一致。


## 变更记录

### 2026-11-10 — 去掉重复药丸对 + 实时 tok/s

- **重复行根因（源码确认）**：本插件长期把遮蔽目标写成 `id: 'stats'`（`priority: -1`），但 ui-chat 早已改为注册 `id: 'activity'`（`order 0`）与 `id: 'usage'`（`order 1`）。list 槽的条目身份是 `(id, priority)` 且"同一 id 上最低 priority 才渲染"，**写错 id 不会遮蔽、只会多渲染一行** → 底部出现两对完全相同的 `N 轮 M 步 · X tok/s` + `总量 tok · 缓存命中 P%`。
  - 旁证（生产实测）：同机制的 `cost-meter` 行遮蔽**一直有效**（那行确实不在对话框底部出现），说明遮蔽机制本身没问题，问题只在 id 过期。
- **修复**：`activity` → 本插件接管；`usage` → 遮蔽渲染 `null`（`StatsRow` 已在同一单元里画出这两颗药丸及其弹窗、图表）。功能不减：轮/步、tok/s、token 总量、缓存命中、四个明细对话框行、悬停折线图全部保留。
- **tok/s 改为实时**：新增 `liveSpeed()` + `LIVE_WINDOW_MS = 30000`，药丸显示"最近 30 秒池化解码速率"（`ΔdecodeTokens / ΔdecodeMs`），窗口内无解码时保持最近一次测得的步速率；弹窗同时给「最近 30 秒」与「本会话平均」两行。旧口径（`ΣdecodeTokens / ΣdecodeMs`，会话平均）只留在弹窗里。
  - **口径边界**：`sessionStats` 的 `decodeMs/decodeTokens` 折叠自已提交的 `step/end`，粒度是一步而非逐 token；一个很长的单步只会在该步结束时刷新读数。
- 测试：51 项全过（新增 5 项：live 池化 / 静默期保值 / 空序列 / 药丸以实时值领先 / 弹窗同时给出两个口径；注册断言改为 activity+usage 五格）。
