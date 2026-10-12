# dsh-pet

**一只住在 DSH（DeepSeek Harness）里的桌面宠物挂件。** 13 张表情差分，跟着鼠标做反应、
能拖能甩、会自己找事做、会打盹，还会顶着气泡说两句。

*A desktop-pet overlay plugin for DSH. It is deliberately **just a pet** —
the AI's status never borrows its face.*

![桌宠在 DSH 的聊天界面里](docs/screenshot.png)

**它只有一件事要做：当一只宠物。** AI 的状态（在跑工具 / 思考 / 出错 / 上下文多满 / 待办进度）
**不占用它的脸**，走标签下面那条独立的细条仪表。

![13 张表情差分](docs/expressions.png)

## 环境要求

| | |
|---|---|
| DSH | 桌面版。本插件以 bundle 方式装载（`cordis.patch.yml` + `package.json` 的 `dsh.client`） |
| 运行时依赖 | **零** —— 宿主半边只用 Node 内置模块，浏览器半边只用 DSH 注入的 slot |
| 跑测试需要 | Node.js ≥ 18；`tools/check_eol.py` 与 `tools/make_sheet.py` 需要 Python 3（后者要 Pillow） |

## 安装

本插件不在 npm 上，用 **link** 方式装 —— 好处是改完代码不用重新打包，刷新页面就生效。

**① 把仓库放进插件目录**

```bash
git clone https://github.com/LKMN28256/dsh-pet.git ~/.dsh/plugins/dsh-pet
```

**② 在 DSH 的 profile 里登记**（以 `desktop` profile 为例，文件是
`~/.dsh/profiles/desktop/package.json`）—— 要改**两个**地方，少一个都不会加载：

```jsonc
{
  "dependencies": {
    // ① 依赖指向 clone 出来的目录（Windows 上换成你自己的用户目录名）
    "dsh-pet": "link:C:/Users/<你的 Windows 用户名>/.dsh/plugins/dsh-pet"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …原有条目…
        "dsh-pet"                                                // ② bundle 清单里点名
      ]
    }
  }
}
```

**③ 建好软链，然后重启 DSH**

```bash
cd ~/.dsh/profiles/desktop && pnpm install
```

> `client.js`（浏览器半边）是**热重载**的，改完刷新页面即可；
> `lib/index.js`（宿主半边）改了**必须重启 DSH** —— 这条踩过坑，见文末踩坑 #6。

## 先跑测试，再相信它装好了

仓库自带**离线测试台**：不用装任何依赖、不需要 DSH 在跑，就能验掉绝大部分逻辑。

```bash
node tools/test_client.js     # 138 项：在 Node 里种一个最小 React 替身，把 client.js 真跑一遍
node tools/test_host.mjs      # 49 项：fake 一个 ctx 直接调路由，宿主改完不用重启就能验
node tools/mutation_check.js  # 26 个变异必须全部"会红"
node tools/scan_undefined.js  # 静态扫"调了没定义的函数"（这类错会让整个桌宠消失）
node tools/verify_live.js     # 端到端：对着已经跑起来的 DSH 验（这一项需要 DSH 在跑）
python tools/check_eol.py     # 全仓必须是纯 LF
python tools/make_sheet.py    # 重新生成上面那张表情总览图（需要 Pillow）
```

**`mutation_check.js` 是这个项目最想给你看的东西。** 它把 26 处关键修复**逐个还原**，
再确认对应的测试真的会失败 —— 一条无论怎么改代码都绿的测试，不叫测试。

同理，`test_host.mjs` 存在的理由是：宿主改一次要重启一次 DSH，而重启会打断正在跑的会话，
所以"重启完再看一眼"是这里最贵的一种验证方式 —— 能提前在 Node 里算完的，就不要留给重启。

## 它现在长什么样

- 挂在 `shell.overlay`（全框浮层，层级高于所有列），默认**右上角**：距右 26px、距顶 9vh
- 高度 **29vh**，等比缩放（素材画布 512×683）
- **立绘本体不吃鼠标**（`pointer-events: none`），只有点击热区按椭圆几何判定
- 底部：呼吸浮动（±5px / 3s）、一个状态标签（标签右侧是 `↻` 手动换表情）
- 头顶：**漫画式台词气泡**（纸面 + 墨线 + 尖尾巴，按情绪换三套配色）
- 标签下方：**AI 状态细条**（一个圆点 + 一条细条 + 一行小字），和脸完全分开
- **脸分时复用**：AI 闲着时脸归宠物，AI 连续忙够 1.5s 才借去做显示屏，闲够 4s 收回
- 可以拖到任意位置，位置存 `localStorage`

## 设计上的分界线：脸 ≠ 仪表

这张脸曾经同时干两份活：一半是"陪你玩的宠物"，一半是"AI 的状态显示屏"。两者的出口是
**同一条隐式布尔优先级链**（9 个申请者抢一个表情槽），谁抢到，别人就一个字都说不出来。

于是 bug 长得像"缺席"而不是"错误"：`pickByScore` 没命中时兜底返回一个轮换表情，
"AI 有内容要说"就恒为真 —— 睡觉和靠近被永久饿死；`INTENT_MAP.waiting` 让回合结束后的
`mind` 长期占位，睡觉同样出不来；睡觉分支直接 `return`，游走和小动作再也出不来。
用户能报告的从来不是报错，只能是"凑过去没反应""见不到揉眼睛""睡觉时间有点长"。

现在这条线是硬的：

| | 归谁 | 出口 |
|---|---|---|
| 表情 / 立绘 / 台词气泡 | **宠物自己优先**：手动点击、连点生气、小动作、演示模式、靠近目送、睡觉 | `.dshPetImg` / `.dshPetBubble` |
| 闲下来时的静息脸 | **宠物**：`REST_FACE`（`calm`），**不按定时器换** | `.dshPetImg` |
| AI 忙起来时的静息脸 | **分时借给 AI**：`calling` / `cool` / `surprised` | `.dshPetImg`（`data-dsh-pet-face="ai"`） |
| AI 状态：意图 / 上下文 / todo / 长任务 | **仪表**：一个圆点 + 一条细条 + 一行小字 | `.dshPetMeter` / `.dshPetNote` |

判断标准很简单：**如果一条信息回答的是"AI 在干什么"，它就不该出现在脸上。**

**"分时复用"和当年的"同时抢"不是一回事。** 当年的病根不是"AI 信息出现在脸上"，而是
两条来源**同时**竞争同一个槽位、抢输了还不吭声。分时复用下一段时间只有一个主人，
而且"现在归谁"是**可见**的（根节点的 `data-dsh-pet-face`、标签里的 `AI 在忙`、
仪表圆点在呼吸）—— 它不再靠"安静"来表达"我没事"。

## 功能清单

### ① 自主行为（不用等 AI，自己会动）

| 功能 | 触发 | 常量 |
|---|---|---|
| 待机小动作 | 闲置 9s 起，间隔 11~26s 随机 | `IDLE_FIRST_MS` `IDLE_GAP_MIN/MAX` |
| 无聊游走 | 闲置 45s 后自己挪位置，**带踏步动作**（不是平移） | `WANDER_AFTER_MS` `WANDER_X/Y` `WALK_*` |
| 睡觉循环（打盹） | 闲置 90s → 睡 15~30s **自己醒**，醒后 45s 内不再睡 | `SLEEP_AFTER_MS` `SLEEP_NAP_MIN_MS` `SLEEP_NAP_MAX_MS` `SLEEP_AWAKE_MS` |
| 哈欠 / 伸懒腰 / 揉眼睛 | 混在上面的动作池里 | `IDLE_ACTIONS` |
| 忙闲分时复用 | AI 连续忙 1.5s → 脸借去当显示屏；闲 4s 收回 | `FACE_BUSY_DELAY_MS` `FACE_REST_DELAY_MS` `AI_FACE` `REST_FACE` |

小动作共 8 种，全部是 **WAAPI 关键帧**，作用在独立的 `.dshPetAct` 层：
`tiltL` `tiltR` `shake` `hop` `stretch` `lookAway` `yawn` `rubEyes`。

> 哈欠和揉眼睛目前借用 `sleepy` 差分 + CSS 拉伸近似。**有真动作帧后，把 `IDLE_ACTIONS`
> 里那一项的 `expr` 改成新素材 id 即可**，机制不用动。

### ② 鼠标感知

| 功能 | 触发 | 常量 |
|---|---|---|
| 划过吓一跳 | 鼠标速度 >1.7px/ms 且从 250px 内掠过 → 惊讶 + 「！」 | `STARTLE_SPEED` `STARTLE_RADIUS` `STARTLE_COOLDOWN_MS` |
| 靠近抬头 | 进入 190px → 呼喊「看你」+ 气泡 | `NEAR_RADIUS` `NEAR_HOLD_MS` |
| 走远目送 | 退出 380px → 「目送」+ 气泡 | `FAR_RADIUS` `WATCH_AWAY_MS` |

### ③ 拖拽物理

- 拖动时换成**抓狂差分**（真交叉淡入：本体淡出 + 差分淡入），松开淡出
- 松手速度 > `THROW_SPEED` → 进入 rAF 物理循环：**惯性 + 重力 + 落地回弹 + 撞边反弹**
- 重力只作用在竖直方向（越落越快），空气阻力只作用在水平方向 —— 抛物线的形状是对的
- 落地速度够大 → 脚下扬尘 + 抖一下，然后收敛静止
- 静止后位置写进 `localStorage`，刷新还在

### ⑤ 气泡交互（只有宠物会说话）

- 台词气泡：点击 / 靠近 / 走远 / 被甩飞 / 落地 / 睡醒 / 无聊 都会说话
- 连点生气：`MULTI_CLICK_WINDOW` 内点到 **随机** `MULTI_CLICK_MIN`~`MULTI_CLICK_MAX` 下 → 生气「别戳了！」并保持 `ANGRY_HOLD_MS`
- 分区反应：**12 个分区**，各有自己的表情和台词（见下表）

**分手气门槛是随机的，不是写死三次。** 写死 3 的下场是：用户戳两下就知道"第三下必炸"，
于是第三下不再是"她生气了"，而是"我触发了那个开关"。窗口每次重置都重新掷一次，
所以摸不出规律。

点击分区表（`ZONES`，**判定顺序就是数组顺序，先匹配者胜**）：

| 分区 | 位置（相对立绘框的 0~1） | 反应 |
|---|---|---|
| `ahoge` | 呆毛 | 兴奋「别拽呆毛啦——」 |
| `hat` | 帽子蕾丝 | 害羞「唔…别摸头」 |
| `bowR` / `bowL` | 左右蝴蝶结 | 开心「蝴蝶结好看吧」 |
| `face` | 脸 | 困惑「盯着我干嘛」 |
| `handL` / `handR` | 两只手 | 爱心「握手~」 |
| `apron` | 围裙（鲸鱼） | 开心「围裙上有鲸鱼」 |
| `hairL` | 左侧长发 | 惊讶「呀！头发乱了」 |
| `hairR` | 右侧长发 | 呼喊「右边也不行！」 |
| `feet` | 鞋 | 开心「痒！」 |
| `skirt` | 裙摆 | 冷淡「……别掀」 |
| （兜底 `body`） | 椭圆内、以上都不沾 | 开心「干嘛呀」 |

坐标是**量出来的，不是估的**：素材按 0.1 打网格量一遍，改完跑 `node zone_map.js`
把分区框画到立绘上再看一眼。分区是一堆 0~1 的比例数字，光看数字没法确认它落在哪儿。

**气泡长得像漫画里的对话气泡**：近白纸面 + 2px 深色墨线 + 一个朝她指的尖尾巴 +
入场时过冲一下（`cubic-bezier(.34, 1.46, .64, 1)`）。市面桌宠（Shimeji / Live2D 那一类）
的通用长相就是这个"贴纸感"——深色界面上一块近白纸面本身就比半透明深色泡泡显眼得多。

尾巴是 `::after` 画的：**一个转 45° 的方块**，右下两条边当描边、圆角当笔尖。
它上半截被气泡自己的纸面盖住，于是气泡底边那一段墨线被"吃掉"——这正是气泡开口的样子。

按情绪换三套配色，`data-dsh-pet-bubble` 里写着这一次是哪一套：

| kind | 什么时候 | 长相 |
|---|---|---|
| `say` | 平常说话 | 米白纸面 / 深蓝墨 / 倾 -2.2° |
| `shout` | 生气 · 受惊 · 被扔出去 | 暖白纸面 / 红墨 / 更大更粗 / 倾 -3.6° / 尾巴更尖 |
| `soft` | 犯困 · 睡着 · 害羞 | 冷白纸面 / 蓝墨 / 虚线边 / 字重更轻 / 倾 -1.2° |

> **气泡 = "她在说话"，仪表提示 = "系统在报数"，两者不共用通道。**
> AI 的报错 / 上下文告警 / 任务进度走 `.dshPetNote`（细条下面那行小字），**不借她的嘴**。
> 这个区分是刻意的：混在一起时，用户分不清"是她在讲还是系统在报数"。

### ⑧ DSH 数据联动 —— 全部搬进细条仪表

数据全部来自宿主真实状态，不是编的。仪表由三个部件组成：

| 部件 | 显示 | 来源 / 阈值 |
|---|---|---|
| 圆点 | 当前 AI 状态（颜色；只有"正在动"的状态才呼吸） | `intent` → `error` 红 / `tool` 蓝 / `thinking` 紫 / `longtask` 黄 / `waiting` 灰 / `idle` 暗 |
| 细条 | 上下文占用 | `tokenMeter.measure()` ÷ `requestContext().contextWindow`；≥`PCT_WARN`(60%) 转黄，≥`PCT_HOT`(75%) 转红 |
| 小字 | `Todo 2/5` · `137s` 之类 | 最近一次 `todo_write` 的 `completed/total`；长任务从 `taskSince` 起算 |

越过阈值时在细条下方弹一行 `.dshPetNote`（"上下文 82% 快满了" / "还在跑 · 137s"），
`NOTE_MS` 后自己消失；**宠物的表情在此期间完全不受影响**。

### ⑨ 音效 —— 做过两版，都被否了，现在是安静版

`client.js` 里没有任何音频代码，宿主也没有 `/dsh-pet/sfx/` 路由，`assets/` 下没有 wav。
**想加回来之前先把踩坑 #25 读完** —— 同样的路已经走过两遍。

| 版本 | 做法 | 用户的判决（原话） |
|---|---|---|
| 一 | WebAudio 现场合成：锯齿波当声带 + 三个带通当共振峰 + 颤音 + 气声 | 「音效太机械了帮我模拟出真人的拟声词'音效」 |
| 二 | 本机 Windows 中文女声（Huihui / Yaoyao）念拟声字，离线抬到萝莉音区，存 7 个 WAV | 「太难听了音效全都回滚吧不要了」 |

留这一段不是记仇，是不让第三个人再来一遍。**结论不是"换个做法再试"，而是：
这条需求在没有真人配音资源之前不该再接。**
## 表情决策链（只剩 7 个申请者）

```text
手动点击 > 连点生气 > 动作自带表情 > 演示模式 > 靠近/目送 > 睡觉 > [AI 借来的脸] > 静息脸
```

前面六个**全是宠物自己**，在"闲"和"忙"两种模式下都优先 —— 也就是说 **AI 再忙也压不住
互动和睡觉**。`[AI 借来的脸]` 只在忙模式且有驻留时间保证时才拿到槽位；它拿不到时是
`REST_FACE`（`calm`）。

标签会写明是谁在控制：`· 手动` / `· 生气` / `· 睡着了` / `· 看你` / `· 目送` / `· 待机` /
`· AI 在忙` / `· AI 出错了`；拖动时是 `抓狂 · 拖拽中`，飞出去时是 `被扔出去了`。

根节点的 `data-dsh-pet-face` 直接说明"现在这张脸归谁"：`pet` 或 `ai`。**测这个，别测表情** ——
忙模式下的静息脸也叫 `calling`，而宠物随时可能打个哈欠把表情换成 `sleepy`。

> **AI 状态不在这条链的"同时竞争"里**，这正是上面那条分界线要解决的问题。历史上它有 9 个
> 申请者、其中两个是"宿主意图"，而且是**同时**抢；五个最顽固的 bug（靠近没反应 /
> 见不到小动作 / 睡觉一睡不醒 / 睡着了还打哈欠 / 报错改写表情）全是那条链的产物。

## 数据从哪来

宿主路由 `GET /dsh-pet/__mind` 返回 `{ ok, digest }`，`digest` 字段：

| 字段 | 含义 |
|---|---|
| `intent` | `error` / `tool` / `thinking` / `waiting` / `idle` / `longtask` |
| `tool` | 最近一次工具名（仪表提示从 `TOOL_LINES` 里选一句人话） |
| `error` | 新鲜报错（30s 内且未被后续成功覆盖） |
| `todos` | `{ done, total, at }` 或 `null` |
| `meter` | `{ used, limit, pct }` 或 `null`（`ctx.tokenMeter.measure()` 的真实返回是 `{ totalTokens, surfaceTokens, nodes }`，这里只取 `totalTokens`） |
| `taskSince` / `turnSince` | **绝对时间戳**，不是"已经过了多久" |
| `running` `turnEnded` `userJustSpoke` `pendingToolCall` | 回合边界判定 |

**为什么是绝对时间戳**：`__mind` 按 `seq` 缓存 digest，缓存命中的那次会被直接复用；
写成相对毫秒就成了过期数字。绝对时间戳由客户端自己减，缓存多久都不会错。

客户端每 `MIND_POLL_MS` 轮询一次，`infoKey()` 做数值指纹，**只在可见值变化时才 setState**。

## 目录与部署

| 位置 | 作用 |
|---|---|
| `~/.dsh/plugins/dsh-pet/` | **插件包真身**（`client.js` + `lib/index.js` + `assets/`） |
| `~/.dsh/profiles/desktop/node_modules/dsh-pet` | Junction，指向上面 |
| `~/.dsh/profiles/desktop/package.json` | `dependencies` 里 `link:` + `dsh.profile.bundles` 里的 `dsh-pet` |

测试台与工具都在本仓库的 `tools/` 里，**默认对着本仓库这份代码**跑（想改测"正在运行的那份插件"，
用下面的环境变量指过去即可）：

- **测试** —— `test_client.js`（138 项断言）、`test_host.mjs`（宿主 `sessionDigest` 49 项断言，
  **不重启 DSH 也能验证 ⑧ 的三项**）、`mutation_check.js`（**变异测试**：把 26 处关键修复
  逐个还原，确认对应测试真的会红）、`scan_undefined.js`（未定义引用静态扫描）、
  `check_eol.py`（全仓行尾必须是纯 LF）
- **实盘** —— `verify_live.js`（**实盘验收**：素材逐张取、`__mind` 字段判据、`__events`、`__diag`；
  重启 DSH 前后各跑一次即可确认新代码已加载）
- **看得见的东西** —— `preview_bubbles.js`（**气泡预览页**：从 `client.js` 的 `CSS_TEXT` 现抠
  气泡 CSS，生成可以直接双击打开的 `bubble-preview.html`；改完样式重跑一次即可）、
  `zone_map.js`（**分区覆盖图**：从 `client.js` 现抠 `ZONES` 表，把每个分区框画到立绘上存成
  `zone-map.png`；改完分区边界跑一次，别靠脑补坐标）、`make_sheet.py`（README 那张表情总览图）
- **立绘生产**（绿幕切图那套，**不在本仓库**）：`process_green_grid.py`、`process_drag.py`、
  `measure_scale.py`、`fix_ahoge.py`（呆毛内圈去白块，见踩坑 #21）


```bash
node tools/test_client.js     # 138 项；末尾会打印 hook 槽位数，必须是 58
node tools/test_host.mjs      # 49 项；fake 一个 ctx 直接调路由，不需要重启
node tools/mutation_check.js  # 26 个变异必须全部"会红"
node tools/verify_live.js     # 对着已经跑起来的 DSH 做端到端验收
node tools/preview_bubbles.js # 生成 bubble-preview.html，双击看气泡长相
node tools/zone_map.js        # 生成 zone-map.png，看点击分区落在哪儿
python tools/check_eol.py     # 全仓必须纯 LF（CRLF 会让变异锚点静默失配）
```

> 路径都能用环境变量覆盖：`DSH_PET_CLIENT` / `DSH_PET_ASSETS` / `DSH_PET_LIB`
> （`mutation_check.js` 就是靠这个把测试指向临时目录里的变异体的）。

## 路由

| 路由 | 作用 |
|---|---|
| `GET /dsh-pet/sprite/<name>.png` | 13 张素材（白名单 `ALLOWED`，**加新素材必须登记，否则 404 且界面无声无息**） |
| `GET /dsh-pet/__mind` | 会话状态摘要（内容驱动 + 数据联动数据源） |
| `GET /dsh-pet/__events` | 最近 60 个事件（排查意图判定） |
| `GET /dsh-pet/__diag?data=...` | 客户端崩溃时回传堆栈 → `%TEMP%\dsh-pet-diag.log` |
| `GET /dsh-pet/` | 服务探针（`hits` / `sprites` 清单） |

## ⚠️ 踩过的坑（改这个插件前必读）

### 1. React #311：hook 数量不一致 → 条目被永久退位

**症状**：界面里什么都没有，但 slot 查询显示 `active: false`，插件看起来"在工作"。

**根因**：渲染期调用宿主传入的 `useSessionStatus`，而它**首次渲染时还不存在**，
条件式地跳过/执行 hook 让两次渲染的 hook 数量不同 → #311。
DSH 的 `SlotCore.onEntryError` 收到 `info.abdicate` 就把条目加入 `abdicated` 集合，
之后**永不渲染**。

**铁律**：
- **绝不在渲染期调用任何宿主 hook**；宿主数据全走同源 HTTP 路由
- Pet 的 hook 槽位**当前是 58 个**，必须恒定（`test_client.js` 每次会打印这个数）
- 任何 `react.useXXX` 都不许出现在 `? :`、`&&`、`||` 或 `if` 里

### 2. 拖拽相关的三个"过期闭包"陷阱

`onPointerUp` 里读 **state 变量**都是本轮渲染的旧值：

```js
if (dragging) setDragging(false)      // ❌ 抬手快过重渲染 → 永久卡在抓狂表情
const nx = Math.min(pos.x, ...)       // ❌ 夹回视口时用旧坐标 → 松手瞬间跳回去
```

正确做法：**`setDragging(false)` 无条件调用**（setState 同值会被 React 跳过），
坐标一律读 `posRef.current`，并在 `onPointerMove` 里**同时写 state 和 ref**。

### 3. 加了 `clip-path` 会连"显示"一起裁掉

为了让立绘不吃鼠标，我曾写 `clip-path: ellipse(45% 47%)` —— 它同时**裁剪了显示**，
人物被硬裁成椭圆，头发和裙子边缘全没。**点击热区必须用几何判定**
（`hitZone()` 算相对坐标落点），不能用 `clip-path`。

### 4. 素材路由加白名单后，忘了登记 = 静默失效

客户端 `dragReady` 靠 `img.onload` 置 true。素材 404 → 永远 false → **表情纹丝不动，
而且一个错都不报**，从界面完全看不出是 404。排查手段：直接 curl 素材路由看状态码。

### 5. 素材缓存：`no-cache` + 版本号

原来设了 `Cache-Control: public, max-age=86400`，改素材后浏览器一直用旧图，
表现是"文件明明改了、界面毫无变化"。
现在：宿主发 `no-cache`，客户端所有素材 URL 带 `?v=ASSET_VERSION`。**换素材请把
`ASSET_VERSION` +1**。

### 6. 改动生效方式：客户端热重载，宿主必须重启

| 改了什么 | 生效方式 |
|---|---|
| `client.js` | **热重载** —— 刷新页面即可 |
| `assets/*.png` | 同上（记得 +`ASSET_VERSION`） |
| `lib/index.js` | **必须重启 DSH** |
| `package.json` / `cordis.patch.yml` | 必须重启 |

判定宿主是否已加载新代码：`GET /dsh-pet/__mind` 看有没有最新加的字段。
**注意核对文件 mtime 与宿主进程启动时间**——我曾因为文件改在启动之后而误判"已生效"。

### 7. 呼吸动画要用 CSS，不要用 JS 定时器

`setInterval(1200ms)` 改 `transform` 一秒只动一两帧，看起来"一格一格跳"。
改用 `@keyframes` + `animation`（`ease-in-out`），由合成器按帧渲染。
**注意**：一旦用 CSS 动画，内联 `transform` 会盖掉它，两者不能同时写。

### 8. 分层要留"空的 transform 通道"

四层各占一条，互不覆盖：

```text
.dshPetRoot   呼吸（CSS 动画）
  .dshPetStage  拖拽放大（内联 transform）
    .dshPetAct    自主小动作（WAAPI）
      .dshPetImg    表情切换"弹一下"（WAAPI）
```

### 9. 淡入淡出不要只叠不藏

拖拽差分和本体姿态不同（呆毛位置不一样），**只叠加不淡出**会让本体的呆毛从差分
透明处透出来。必须真交叉：本体 `opacity → 0`、差分 `opacity → 1`。

### 10. 中文标签检测：颜色比形状可靠

绿幕网格图的每格底部有浅蓝中文标签要去掉。按行宽跳变判据在同图上摇摆（第一行准、
第二行总多切 6 行）。最后用**浅蓝像素计数**：
`light = nongreen & (b > r+15) & (b > 170) & (r > 140)`，`rows > 25` → 12/12 全中。
另：`a[:start]` 是**非连续视图**，`Image.fromarray` 处理它不可靠，要 `np.ascontiguousarray`。

### 11. 夹取位置时，左边必须用"宠物宽度"，不能用"窗口宽度"

这是最阴的一个 bug，因为它在**正常位置下完全不显形**：

```js
x: Math.max(-(w - MARGIN_KEEP), Math.min(cur.x, w - MARGIN_KEEP))   // ❌ w 是窗口宽度
x: Math.max(-(bw - MARGIN_KEEP), Math.min(cur.x, w - MARGIN_KEEP))  // ✅ bw 是宠物宽度
```

1440px 窗口里，第一行的左界是 **-1380**（一只 196px 宽的立绘在这里是**整只在视口外**）。
正常拖拽从右边起手最多只能把它拖到 x≈-100，所以看不出问题；但**只要它先在左边**
（无聊游走 45 秒后自己就挪过去了，或者你先往左拖过一次），再往左拖一把就直接归类到
-1380 —— **松手即彻底消失**。

而桌宠没有任何界面入口（按钮、快捷键、右键菜单都没有），唯一能救回来的是
`localStorage.removeItem("dsh-pet:pos")`。两个配套的兜底也因此必须存在：

- **存档加载时也要夹一次**：修复前存下的越界坐标不会自己变好，不夹就永远消失
- **必须监听 `resize`**：位置按像素存，窗口一缩小（或取消最大化、改缩放）原坐标就可能
  落到视口外，同样点不到

三者用的是同一个 `clampToView(p, bw, bh)`，规则是"**至少 `MARGIN_KEEP` 像素留在视口内**"，
和物理循环里 `startPhysics` 的 `minX/maxX` 保持同一套口径。
回归测试是 6.16 / 6.17 / 6.18，`mutation_check.js` 会把这三处修复逐个还原，
确认它们真的会红。

### 12. 甩不出去：`releaseVelocity` 的窗口两端取反了

用户实机反馈的原话是「本来是想甩飞的，但是**有时候**松开鼠标桌宠会停留在原地」。
"有时候"就是线索 —— 它只在**整个拖动短于 `VEL_WINDOW`(110ms)** 时发生，也就是**甩得越快越甩不动**。

旧代码的循环从后往前扫，把**窗口内最早的样本**当成终点：

```js
let a = null, b = null;
for (let i = s.length - 1; i >= 0; i--) {
    if (now - s[i].t <= VEL_WINDOW) { a = s[i]; }   // ⚠️ 每轮覆盖，最后 a 是窗口内最早的那个
    else { b = s[i]; break; }
}
const from = b || s[0] || a;                        // 基准点是"窗口外的那一个"
const dt = Math.max(1, a.t - from.t);
```

一旦**所有样本都落在窗口内**（快甩就是这种情况），`b` 是 `null` → `from = s[0]`，
而 `a` 也退化成了 `s[0]` —— 同一个点相减，位移恒为 0，`dt = max(1, 0) = 1`，
**速度算出来就是 0，永远进不了物理**。

正确语义是：基准点取窗口内最早的样本，**终点必须是最新样本 / 抬手点**。
现在还会用抬手事件的真实 `clientX/clientY` 当终点（`pointermove` 会被浏览器合并降频，
最后一次样本可能差着几十毫秒的位移），并加了一层 `VEL_GRACE_MS`(60) 宽限：
**抬手离最后一次移动超过 60ms 就当"手已经停了"**，速度归零 —— 这是"拖到位再轻轻放下"
该有的语义，不然每次放下都会被判成抛掷。

回归测试 6.19（60ms 内快甩）和 6.20（停手再松开），M9 变异会把终点改回窗口内最早样本。

### 13. 靠近没反应：`nearExpr` 被 AI 的内容表情永久压住 【已由"脸 ≠ 仪表"结构性消除】

优先级链原来是这样：

```js
|| (mindActive ? mindExpr : null)   // ⚠️ 排在 nearExpr 前面
|| sleepExpr
|| nearExpr
```

`mindActive` 在 `intent` 是 `tool` / `thinking` / `error` 时为真。而用户测这个功能时
**正在跟 AI 对话** —— 我一直在思考、跑工具，`mindActive` 恒真，且 `mindExpr` 总有值
（通常是 `cool`）。于是"鼠标慢慢靠近"永远被盖住，看起来就是"凑过去毫无反应"。

对比之下"快速掠过吓一跳"是能出效果的，因为它设的是 `setManual("surprised")`，
而 `manual` 在链首 —— 两个功能的表现差异正好印证了这条链的位置问题。

当时的修法是把鼠标互动排到所有 AI 内容表情之前：

```js
|| nearExpr
|| (mindActive ? mindExpr : null)
```

**但这个修法只是又调了一次排队顺序** —— 它治的是这一次的抢位，不是"九个申请者抢一张脸"
这件事本身。后来发现同一个失败在五个地方反复出现（见上面的"设计上的分界线"），
才把 AI 整个搬出表情链。**现在链上根本没有 `mindExpr` / `mindActive`，这一类抢位不可能再发生**；
`mutation_check.js` 的 M10 会把"AI 状态重新挤进表情链"这个变异加回去，确认它仍然会红。

顺带还有第二个原因（这条与分离无关，仍然有效）：靠近/走远原本**只换表情、不出声**，
唯一反馈是标签文案，表情一旦被压住就彻底无感了。现在 `onMove` 的靠近/走远转移点
会各说一句（`NEAR_LINES` / `AWAY_LINES`）。`NEAR_RADIUS` 也从 150 放宽到 190 ——
这个距离算的是**到桌宠中心**，而立绘半高就有约 130px，150 基本要贴到脸上才触发。

回归测试 6.21。

### 14. 游走"像平移"：位移有过渡，但没有踏步动作

`wander()` 只给 `left`/`top` 加了 CSS 过渡：

```js
transition: "left 3200ms ease-in-out, top 3200ms ease-in-out"
```

**过渡只是位移，不是动作** —— 桌宠会整只平滑滑过去，看起来就是个平移的贴图。

修法是游走期间在 `.dshPetAct` 上再叠一层**循环**的踏步动画（`startWalk`）：
抬脚 `WALK_BOB_PX` + 朝行进方向微倾 `WALK_TILT_DEG` 的关键帧，周期固定
`WALK_STEP_MS`(620)，用 `iterations` 凑够整段路程（**不要拉长周期去凑时间，
那会变成慢动作**）。

三个配套细节，少一个都会出怪相：

- `playAction` 里要 `stopWalk()` —— 踏步和小动作都在 `.dshPetAct` 上，同时跑会打架
- `onPointerDown` 里要 `stopWalk()`，**并且 `setMoving(false)`** —— 否则被抓起来还在原地踏步，
  而且残留的 CSS 过渡会让拖拽"追不上手"
- `startPhysics` 和睡着时也要 `stopWalk()`

回归测试 6.22，M11 变异会摘掉 `startWalk` 的调用。
`.dshPetRoot`(CSS 呼吸) / `.dshPetAct`(踏步或小动作) / `.dshPetStage`(拖拽缩放) 是三层
不同的 transform 通道，正好互不干扰 —— 这也是当初分层的目的。

### 15. 睡着之后"一睡不醒"：其他动作全被永久挡住

**症状**（用户原话）："挂机的睡觉时间有点长，我经常见不到其他动作比如揉眼睛，到处散步之类的"。

**根因**：睡着的分支直接 `return`，而唯一能叫醒它的是鼠标靠近 / 点击。没人管的桌面宠物
90 秒后入睡就**永远躺着** —— `wander()`（游走）和全部 `IDLE_ACTIONS`（揉眼睛 / 打哈欠…）
再也出不来。

**修法**：睡觉改成"打盹循环" —— 睡 `SLEEP_NAP_MIN_MS`~`SLEEP_NAP_MAX_MS`（15~30s，随机）
后自己醒，醒后 `SLEEP_AWAKE_MS`（45s）之内不再睡，并接上定义了却从没用过的 `WAKE_LINES`。
调度器里**先判"睡着中"、再判"该不该睡"**（原来顺序相反，睡下以后永远走不到唤醒分支）。

顺带两个修正：

- 入睡时把正在跑的小动作收掉（`setAction(null)` + `cancel()`）—— 打哈欠 / 揉眼睛的表情是
  `sleepy`，排在睡脸前面，不收就会"睡着了还睁着眼打哈欠"
- 小动作从 `pick(IDLE_ACTIONS, Date.now())` 改成 **Fisher-Yates 洗牌袋**（`nextIdleAction()`）：
  纯随机很容易连着抽到同一个（三次歪头），看起来就"来来回回那么两下"；洗牌袋保证 8 个动作
  都出现过一轮才可能重复

回归测试 6.23（睡着 → 40 秒内自己醒 → 醒来后继续活动）和 6.24（前 8 次小动作互不相同），
M12 / M13 变异分别把"自己醒"和"洗牌袋"打回原形。

### 16. 测试台不会自己重渲染：一次 advance 推太久，效果和真机不一样

假 React 只在 `s.render()` 时重渲染，真机是每次 `setState` 立刻渲染。所以
`advance(46000)` 一把推过去，"小动作到期自动清除"的 effect 迟迟不跑，
`actionRef.current` 一直是旧值，空闲调度那段就被 `!actionRef.current` 永久挡住 ——
看起来像"醒来后再也不动"，其实是**测试台失真，不是产品 bug**。

修法：新增 `advanceRendered(s, ms, chunk)`（默认每 1000ms 推进一次并渲染），
长时间推进一律用它。**症状是"时红时绿"时，先怀疑测试台，再改生产代码。**

### 17. 用 python 改过文件之后，整个文件变成 CRLF

`io.open(path, 'w')` 在 Windows 上默认把 `\n` 翻成 `\r\n`。一次 read-modify-write
之后整个 `client.js` / `README.md` / `test_client.js` 都成了 CRLF，后果是
**变异测试里含换行的锚点全部静默失效**（`indexOf` 落空 → 变异体被标成"跳过"，
覆盖率凭空少一半而你不知道）。

两条对策都要有：

- 脚本改完文件后归一化行尾：`io.open(p,'rb').read().replace(b'\r\n', b'\n')` 再以 `'wb'` 写回
- `mutation_check.js` 读源码时统一 `norm()`（`replace(/\r\n/g, '\n')`）再比对锚点

### 18. 假渲染器必须像真 React 一样摊平数组子节点

`test_client.js` 里的假 `createElement(type, props, ...children)` 一开始把 `children`
原样挂在节点上。组件写成 `react.createElement("div", {...}, [a, b])`（**数组**当第三个参数）
时 `kids = [[a,b]]`，而 `findAll()` 遍历的是 `node.children` —— 于是**整棵子树在测试台眼里
根本不存在**。

症状极具误导性：`aiStateOf` 正常返回，但 `meterTextOf` / `dotColorOf` / `barWidthOf` /
`noteTextOf` 一律 `null`，10 条断言报"仪表细条 = null"。看起来像组件没渲染仪表，
实际是**测试台没看见它**。根节点用 `...children` 展开、`labelOf` 读 `props.children`，
所以"大部分看起来正常"，只有数组子节点的那一层消失。

修法：`createElement` 里递归摊平（数组展开、丢弃 `undefined`/`null`/`false`/`true`）。
**又一个"症状像产品 bug、其实是测试台失真"的实例 —— 先怀疑测试台。**

### 19. 用 `ops_bash` heredoc 跑 python 改 JS 源码时，转义会被剥两层

`ops_bash` 的 JSON → shell → python 一共剥两层。想在 python 源码里写"反斜杠 + t"
（用来匹配 JS 字符串字面量里的 `\t`），写 `\\t` 到 python 手里**会变成真正的 TAB**，
锚点于是永远匹配不上（表现为 `AssertionError: (0, '...')`）。

要匹配 JS 源码里的字面反斜杠序列，python 这边必须用 **raw string**（`r"""..."""`）。
另外 python 的 `cut(a, b, new)` 式切片改代码时，**连续多次切片必须确认区间不重叠** ——
我曾因顺序搞反而把刚插进去的 `source` / `tagText` 又切掉，报 `ReferenceError: tagText is not defined`。

### 20. 抛出去之后是"匀速下落"：竖直方向也吃了空气阻尼

**症状**（用户原话）："抛出后下落的速度有点不符合物理规律，不应该是匀速的"。

旧循环里 `damp` 同时乘给了两个方向：

```js
ph.vy += GRAVITY * dt;
const damp = Math.pow(AIR_FRICTION, dt);
ph.vx *= damp;
ph.vy *= damp;      // ⚠️ 重力 + 线性阻尼 = 终端速度
```

**重力配上线性阻尼，数学上必然收敛到一个终端速度**：`v_term ≈ GRAVITY*dt / (1 - AIR_FRICTION^dt)`。
按当时的数算出来约 **0.6 px/ms**，而这条曲线在 **~0.5 秒内就到 90%** —— 一次典型的抛掷
滞空也就 0.5~1 秒，所以眼睛看到的几乎全程是匀速下坠，抛物线被压成了"斜着平移下去"。

**修法**：重力只作用于竖直方向，阻尼只作用于水平方向。

```js
ph.vy = Math.min(MAX_VY, ph.vy + GRAVITY * dt);   // 竖直：一路加速，只有安全上限
ph.vx *= Math.pow(AIR_FRICTION, dt);              // 水平：这才是"甩出去会停下"的那一项
```

顺带加了 `MAX_VY`(3.2 px/ms) 兜底，防止超高窗口里下落糊成一片（正常 900px 窗口最多到 ~1.7）。

**回归测试 6.25 的判据值得记一笔**：一开始我想断言"末帧位移 > 首帧位移 × N"，但这个判据
**抓不到这个 bug** —— 旧代码前半程照样在加速（阻尼是从小速度开始起作用的），
只是后半程被压平了。真正区分两者的是**每帧速度增量**：自由落体时它恒等于 `g·dt²`，
被阻尼吃掉时会一路衰减到 0。所以 6.25 断言的是**后半程每帧增速仍约等于 `g·dt²`**，
`g` 直接从源码里读出来 —— 这样调 `GRAVITY` 也不会让测试失效。
**教训：断言"变化率的变化率"，而不是首末两点的比值。**

M16 变异把竖直阻尼加回去，6.25 立刻变红。

### 21. 11 张素材里，呆毛内圈被填了一块突兀的白

**症状**（用户原话）："呆毛和帽子之间有一块颜色很突兀的白色，你把他扣掉"。

先别急着动手抠 —— **先找有没有本来就对的图**。13 张里 `confused.png` 和 `drag.png` 的同一个
位置**本来就是透明的**（能看到背景），其余 11 张被填成了实心白。所以这不是审美取舍，
**是同一批素材里 11 张被填错了**，修法是"还原成那两张的样子"。有参照就好办，也省掉了
"抠到什么程度才自然"的扯皮。

**怎么抠**（`fix_ahoge.py`，13 张各自独立处理，不做跨图对齐）：

1. 取出头顶那根蓝卷 —— 从**最高的蓝色像素**做连通，拿到整根。
2. 求它的**凸包**。蓝卷是个月牙，凸包正好把月牙围出来的空档盖住，而下弦大致落在
   帽子蕾丝的上沿，所以不会一路扩进蕾丝里去。**这一步是全部关键**：直接按"近白"连通
   会从描边的缺口漏进蕾丝，把帽子也抠了（`calling`/`happy`/`love`/`sleeping` 都会漏）。
3. 空档 = 凸包 −（蓝卷 ⊕ 1px）− 深色描边 − 蓝色像素。
4. 从**最严阈值（250）**下位置最高的那块纯白取一个种子，在空档里洪泛 ——
   只保留种子所在的那一整块，避免误伤同一空档里别的白色。
5. 只把 `alpha` 置 0，**RGB 一个字节都不动**（验证过颜色完全一致）。

**回归检查**：`python fix_ahoge.py --check <素材目录>`，还有白块就退出码 1。
对修好的素材跑是 0 px，对备份的原图跑会报"11 张素材带着白块"。

**教训：素材类缺陷也要有一个能一键复跑的检查。** 人眼看过觉得对了不算数 ——
下一个人（包括三个月后的我）怎么知道这批图是干净的？换个素材、重新生成一次，
这个检查会立刻叫。

### 22. "生硬的每四秒钟切换一次表情"：一个没有原因的表情变化

**症状**（用户原话）："桌宠现在更像是生硬的每四秒钟切换一次表情，为什么不做成在 AI 工作
时候作为显示屏，在不工作的时候作为一个桌宠"。

根因是 `STATUS_MAP = { idle: ["sleepy", "calm", "shy", "happy"] }` + `FRAME_MS = 2600` 配
`exprFor(frame)`：闲着的时候按 **2.6 秒的节拍器**轮换表情，10.4 秒一圈。

**打哈欠有原因，换脸没有。** 一个没有原因的表情变化，看起来就是机械的 —— 这跟表情本身
好不好看没关系，是"变化必须有触发者"这条规则被违反了。

顺带纠正我自己的一个过度结论：上一轮"脸 ≠ 仪表"我把它推到了"AI 永远不该上脸"。其实病根
不是"AI 信息出现在脸上"，而是**两条来源同时竞争同一个槽位、抢输了还不吭声**。
**分时复用**（一段时间只有一个主人）是完全不同的结构，可以做。

**做法**（`client.js`）：

- 删掉 `STATUS_MAP` / `FRAME_MS` / `exprFor()` / `localState()` / `bootRef`，
  静息脸改成 `REST_FACE`（`calm`）—— **不按定时器换**。
- 忙模式由 `faceRef = { want, busy, since, face }` 管：`want` 是"AI 现在忙不忙"，
  `since` 在 `want` **翻转**时重置（不是每次 intent 变 —— 否则 `tool → thinking → tool`
  会反复清零，永远切不过去）。
- 迟滞：忙满 `FACE_BUSY_DELAY_MS`(1.5s) 才借脸，闲满 `FACE_REST_DELAY_MS`(4s) 才收回。
  **两个数都不能省**：AI 是间歇性忙的，没有驻留时间脸会来回跳，比原来的节拍器还难看。
- 表情链里 AI 的位置排在**宠物自己的六个申请者之后**：`… > 睡觉 > [AI 借来的脸] > 静息脸`。
  AI 再忙也压不住互动和睡觉。
- 切换必须**可见**：根节点 `data-dsh-pet-face`（`pet`/`ai`）、标签里的 `AI 在忙`、
  仪表圆点在呼吸。否则又回到"安静和坏掉长得一样"。

**两个坑**：

1. 一开始写的是 `aiFace = faceBusy ? BY_ID[AI_FACE[aiState]] : null` —— AI 一闲下来
   `aiState` 立刻变 `idle`，而 `AI_FACE.idle = "calm"`，于是脸**立刻**变回 `calm`，
   4 秒迟滞等于没写。必须**记住"忙的时候该露哪张脸"**（`if (aiWant) faceRefCur.face = …`），
   收回时用的还是那张。
2. **断言"脸归谁"要看 `data-dsh-pet-face`，不能看表情。** 忙模式的静息脸也叫 `calling`，
   而宠物随时可能打个哈欠把表情换成 `sleepy` —— 用表情断言会偶发地红。

**变异**：M17（驻留时间归零）→ 6.27 红；M18（静息脸退回定时轮换）→ 6.26 红；
M19（收回驻留归零）→ 6.28 红；M20（AI 的脸排到睡觉前面）→ 6.29 红。

**教训：素材类缺陷也要有能一键复跑的检查。** 抠完肉眼看着对了不算数 ——
下一个人（包括未来的我）怎么知道这批图是干净的？`--check` 就是那个答案。

### 23. 气泡原来是"一块圆角半透明板子"，而且一加类测试就查不到

**症状**（用户原话）："气泡的花样可以有特色一点明显一点，参考市面主流桌宠"。

原来那个气泡是 `rgba(16,20,36,.82)` 的深色半透明圆角板 —— 在本来就深色的 DSH 界面上，
**它和背景是一个明度**，所以既不显眼也不像"有人在说话"。现在改成漫画气泡：近白纸面 +
2px 墨线 + 尖尾巴 + 入场过冲，并按情绪分三套配色（见功能清单 ⑤）。

**技术点全在尾巴上**：`::after` 放一个 `14×14` 的方块，`transform: rotate(45deg)`，
只给 `border-right` / `border-bottom` 上墨线、`border-bottom-right-radius` 当笔尖。
`top: 100%` + `margin-top: -7px` 让它的中心正好落在气泡的底边上 —— 上半截被气泡自己的
纸面盖住，**于是底边那一段墨线被"吃掉"**，正是气泡开口的样子。

用 `left/top + margin-top` 定位、把旋转留给 `transform`，**不要**写成
`top: 100%; transform: translateY(-50%) rotate(45deg)`：多个 transform 函数的先后次序
（以及百分比相对谁算）很容易把尾巴甩到别处去，而我这边**没有浏览器可以看**。

**动画收尾必须和静息 transform 用同一个变量**（`--dshPetTilt`）。动画结束后
`animation-fill-mode: none` 会把 transform 交还给内联样式，两边不一致的话气泡会先倾着
出现、播完"啪"地弹正。M23 就是守这一条的。

**顺带修掉一个测试台的真 bug**：`byClass` 原来写的是 `className === name`（整串相等），
而浏览器的语义是**按词匹配**。气泡一加情绪配色类（`dshPetBubble dshPetBubbleShout`），
6.8 / 6.11 立刻报"气泡 = null" —— 看起来像组件没渲染气泡，实际是断言查不到。
同样的隐患早就埋在 `dshPetTag dshPetPressure` 上了。**教训：假的 DOM 也要按真的语义查。**

**变异**：M21（摘掉尾巴）→ 6.30 红；M22（不按情绪换花样）→ 6.31 红；
M23（动画收尾写死角度）→ 6.30 红。

### 24. "生气次数总是固定在三次" + "只有三个分区有点少"

**症状**（用户原话）："戳戳的生气次数总是固定在三次，可以改为随机数字，
而且虽然戳不同部位有不同反应，但是只有三个分区有点少"。

这两条其实是**同一个毛病**：反应是**编排好的**，不是**活的**。

- 门槛写死 3 → 用户戳两下就知道"第三下必炸"。于是第三下不再是"她生气了"，
  而是"我触发了那个开关"。改成 `MULTI_CLICK_MIN`~`MULTI_CLICK_MAX` 随机，
  **而且窗口每次重置都重新掷**（只在开头掷一次的话，戳几轮还是能摸出来）。
- 三个分区（`y < 0.44` 头 / `y >= 0.80` 裙摆 / 中间身体）→ 本质上还是"三条横切线"，
  横着戳哪儿的反应都一样。现在换成一张 `ZONES` 表，12 个分区各有表情和台词。

**分区表是数据，判定顺序就是数组顺序**（先匹配者胜），所以"小而特别的"要排在
"大而笼统的"前面：呆毛在帽子上面，手在头发上面。加一个分区 = 加一行。

**坐标必须量，不能估。** 第一版我按"头占上 40%"之类的印象填了几组数字，
`zone_map.js` 一画出来就露馅：`face` 那一框压在胸口上。正确做法是给素材打 0.1 网格
（`grid_coords.png` / `grid_top.png` / `grid_bottom.png`），把每个特征的实际范围量出来。
**分区是一堆 0~1 的数字，光看数字根本判断不出它落在哪儿** —— 所以才写了 `zone_map.js`：
它从 `client.js` 里**现抠** `ZONES` 表（数括号，不靠正则猜结尾），把每个框画到立绘上。
抠出来的是真表，画出来的框必然和跑起来的一致。

**测试怎么写**：与其断言"某个坐标 → 某个表情"（写完就碎），不如**撒一张网格**：
96 个点各点一次，统计出现了几种表情、几种台词。分区一退回三条横切线，
6.33 立刻红（M26 就是干这个的）。生气门槛随机化没法直接断言，得先把骰子按住 ——
`withRandom(0.999, ...)` 掷到 6，点三下不该生气；补到六下必炸（M24）。

### 25. 音效做了两版都被否：合成音"太机械"，真人录音"太难听"

**两次判决**（用户原话）：「音效太机械了帮我模拟出真人的拟声词'音效」→ 换成真人录音后
「太难听了音效全都回滚吧不要了」。现在音效整个不存在，来龙去脉见 ⑨。

**最硬的一条教训：我听不到声音，就不该把"好不好听"当成自己能验收的东西。**
两版我验得都很仔细 —— 第一版验音频图结构（锯齿波声带、三个共振峰、颤音、气声），
第二版验频谱图（谐波横纹 = 真人声带）和基频曲线。结构全对，**两次都难听**。
结构对 ≠ 好听。听感类的需求，**验收人必须是能听的人**；我最多能证明"不是噪音、是人声、
音高在预期区间"，这三条离"好听"还很远。当时我把"我听不到"写进了交付说明，
但仍然把结论说成了"结构都对"，那等于把风险转嫁给了用户。

顺带记下几条还能复用的（都不是音效专属的）：

1. **验收动作要经过一整条不可控链路时，先换成一条最短路径。** 第一版的试听押在浏览器
   自动播放策略 + AudioContext 初始化 + `file://` 权限上，用户直接"听不到"。**用户第一次的
   反馈是"没法试听"，那本身就是设计缺陷的信号**，不该当成实现细节去修。
2. **先问"这台机器上已经有什么"。** 本机没有日文语音，但有两个 zh-CN 真人女声
   （`[Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices` 里的 Huihui / Yaoyao）。
   查一下，比造一套合成引擎便宜得多。
3. **WinRT 只认 `powershell.exe`（5.1）**，PowerShell 7 里 WinRT 类型解析失败；
   且 `.ps1` **必须带 UTF-8 BOM** —— 不带就中文乱码，报一堆"字符串缺少终止符"，
   看着像语法错，其实是编码错。
4. **SSML 的 `pitch` 被忽略、`rate` 生效。** 判据很硬：带 `pitch` 的产物与普通产物**字节数完全相同**。
5. **复刻出来的预览页会骗人。** 预览页的代码要**从源文件现抠**（按注释边界切块），
   照抄一份会随时间偏离真身，那种预览比没有预览更坏。
6. **回滚也要当成一次改动来做**：先备份、按行号整段删、删完拿残留标识符列表扫一遍，
   最后用"数字必须回到从前"（断言 138 / 宿主 49 / 变异 26 / hook 槽位 58）确认没有半拉子。
## 怎么在没有重启的情况下验证宿主改动

⑧ 的三项（上下文压力 / todo 进度 / 长任务计时）都在宿主里，**必须重启 DSH 才生效**。
但"重启一次"会打断正在跑的会话，所以宿主逻辑用 `test_host.mjs` 在 Node 里直接验：

它 fake 一个 `ctx`（`logger` / `webServer.register` 捕获 handler / `effect` / `get`），
`await import()` 真正的 `lib/index.js`，然后拿假 `res`/假 `sessions` 调路由处理器，
把 `sessionDigest()` 的每个输出字段都算一遍。这么做的意义是：
**重启之前就能确定宿主代码是对的，把"重启"从"试错"变成"确认"**。

三个容易踩的点：

- `apply(ctx)` 末尾会调 `ctx.effect(...)` 注册清理，**fake ctx 少了 `effect` 会直接抛**
- `sessionDigest` 里 `taskSince` / `turnSince` **必须是绝对时间戳**，不能是相对毫秒：
  `__mind` 有 `mindCache`（`sid` + `seq` 命中就直接回缓存），相对毫秒会在缓存命中时
  冻结成过期数字，界面上就变成"一直显示跑了 300 秒"
- `ctx.tokenMeter.measure(session)` 的真实返回是 **`{ totalTokens, surfaceTokens, nodes }`**，
  而 `TokenUsage.totalTokens` 在类型上是**可选**字段。所以这句兜底不能省：

  ```js
  const used = Number(m.totalTokens) || 0     // 少了 || 0，pct 就是 NaN
  ```

  少了它界面上会显示「上下文 NaN%」——不报错，只是静默显示一个荒谬的数字。
  `test_host.mjs` 的 H7 专门喂了一个"没有 totalTokens"的返回值来钉这条。

## 想改什么，改哪里

| 想改 | 改哪 |
|---|---|
| 位置 / 大小 | `SHIFT_RIGHT` `SHIFT_TOP` `HEIGHT_VH` `MARGIN_KEEP` |
| 允许被推到屏幕外多少 | `MARGIN_KEEP`（`clampToView()` 与 `startPhysics()` 的 `minX/maxX` 同一口径，改动要同步） |
| 呼吸幅度/速度 | `BREATH_PX` `BREATH_SEC` |
| 小动作频率 | `IDLE_FIRST_MS` `IDLE_GAP_MIN/MAX` |
| 多久开始游走 | `WANDER_AFTER_MS` `WANDER_STEP_MS` `WANDER_GAP_MS` `WANDER_X/Y` |
| 多久睡觉 / 睡多久 | `SLEEP_AFTER_MS` `SLEEP_NAP_MIN_MS` `SLEEP_NAP_MAX_MS` `SLEEP_AWAKE_MS` `SLEEP_BREATH_SEC` |
| 鼠标灵敏度 | `NEAR_RADIUS`(190) `FAR_RADIUS`(380) `STARTLE_SPEED` `STARTLE_RADIUS` |
| 甩出去 / 飞行的手感 | `THROW_SPEED`(0.35) `VEL_WINDOW`(110) `VEL_GRACE_MS`(60) `GRAVITY`(竖直) `AIR_FRICTION`(水平) `MAX_VY`(3.2) `BOUNCE` `WALL_BOUNCE` `REST_SPEED` `MAX_SPEED`(4.5) |
| 走路样子 | `WALK_STEP_MS`(620) `WALK_BOB_PX`(3) `WALK_TILT_DEG`(1.8) `WANDER_STEP_MS`(3200) |
| 落地震动门槛 | `LAND_SHAKE_SPEED` |
| 连点判定 | `MULTI_CLICK_WINDOW` `MULTI_CLICK_MIN`(3) `MULTI_CLICK_MAX`(6) `ANGRY_HOLD_MS` |
| 点击分区 | `ZONES` 表（顺序即优先级，`mx`/`my` 是相对立绘框的 0~1）；改完跑 `node zone_map.js` 看一眼 |
| 宠物气泡 | `BUBBLE_MS` `NOTE_QUIET_MS`（刚提示过就让位） |
| 气泡长相 | `CSS_TEXT` 里的 `.dshPetBubble` 那一段：`--dshPetPaper` `--dshPetInk` `--dshPetTilt`；三套配色见 `.dshPetBubble` / `Shout` / `Soft`，换哪句说什么情绪看 `bubbleKind` |
| 气泡尾巴位置 | `.dshPetBubble::after` 的 `left`（默认 24px，Shout 17px） |
| 宠物台词文案 | `CLICK_LINES` `ZONES[].lines` `ZONE_FALLBACK.lines` `BORED_LINES` `WAKE_LINES` `FLY_LINES` `LAND_LINES` `NEAR_LINES` `AWAY_LINES` |
| 仪表文案 | `TOOL_LINES` `INTENT_LABEL` |
| 仪表配色 / 呼吸 | `AI_STATE_COLOR` `AI_STATE_PULSE`（只有"正在动"的状态才呼吸） |
| 仪表提示节奏 | `NOTE_MS`(2600) `ERROR_NOTE_GAP_MS` `SPACE_NOTE_GAP_MS` `BUSY_NOTE_GAP_SEC` `BUSY_NOTE_FIRST_SEC` |
| 上下文阈值 | `PCT_WARN`(0.60 转黄) `PCT_HOT`(0.75 转红) `PCT_SPACE_ALERT`(0.80 明说"快满了") |
| 轮询频率 | `MIND_POLL_MS` |
| 忙闲分时复用 | `REST_FACE`（闲时那张脸）`AI_FACE`（忙时按意图映射）`FACE_BUSY_DELAY_MS`(1500) `FACE_REST_DELAY_MS`(4000) |
| 换素材 | 覆盖 `assets/<id>.png`（512×683、透明底、本体底边 y≈653、水平中心 x≈255）并 +`ASSET_VERSION`，然后跑 `python fix_ahoge.py --check <素材目录>`（呆毛内圈不能有白块，见踩坑 #21） |
| 加表情 | 素材丢进 `assets/`，`lib/index.js` 的 `ALLOWED` 登记，再往 `EXPRESSIONS` 加一行 |

## 卸载 / 回滚

```powershell
# 先退出 DSH
$prof="$env:USERPROFILE\.dsh\profiles\desktop"
Remove-Item -LiteralPath "$prof\node_modules\dsh-pet" -Force
Remove-Item -LiteralPath "$env:USERPROFILE\.dsh\plugins\dsh-pet" -Recurse -Force
Copy-Item -LiteralPath "$prof\package.json.bak-20261009-230801" -Destination "$prof\package.json" -Force
```

## 已知限制

- ~~"内容"= AI 的思考原文，我盘算怎么测你的时候表情也会跟着变~~ —— **这条已随"脸 ≠ 仪表"
  消失**：脸不再读 AI 的任何文本，"AI 在干什么"现在只影响那条细条仪表。
- `pickActiveSession` 按 **seq 最大**选会话。**同时开多个会话时可能选错**。
- 立绘活在 DSH 窗口内的 `shell.overlay` 浮层，**无法创建独立置顶窗口**——
  宿主没有暴露任何 window/Electron 能力，所以"爬到桌面上"做不到。
- 哈欠 / 揉眼睛 / 伸懒腰目前是 CSS 拉伸近似，不是真动作帧。
- 13 张素材共约 5.0MB，首次加载略重（之后有版本号缓存）。
- 素材改过两次（换 `drag` 差分、抠呆毛内圈白块）。要退回旧图：直接覆盖 `assets/`，
  再把 `client.js` 的 `ASSET_VERSION` 加 1（**不加版本号，浏览器不会重新取图**）。

## License

MIT，见 [LICENSE](LICENSE)。`assets/` 下 13 张立绘属于本仓库，一并按 MIT 授权。
