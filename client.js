window.__ModuleLoader__.load({
	id: "dsh-pet",
	factory: (require) => {

		var module = { exports: {} };
		var exports = module.exports;

		let react = require("react");

		/* ================================================================== *
		 * 参数
		 * ================================================================== */
		const SPRITE_W = 512;             // 素材画布宽（px）
		const SPRITE_H = 683;             // 素材画布高
		const HEIGHT_VH = 29;             // 立绘高度（vh）
		const SHIFT_RIGHT = 26;           // 默认位置：距右边缘
		const SHIFT_TOP = 9;              // 默认位置：距顶部（vh）
		const POS_KEY = "dsh-pet:pos";    // 位置持久化 key
		const DRAG_THRESHOLD = 4;         // 位移超过这么多像素才算拖拽
		const MARGIN_KEEP = 60;           // 至少留这么多像素在视口内
		const FADE_MS = 220;              // 表情切换淡入时长

		/* 拖拽时的差分表情（抓狂）。刻意不放进 EXPRESSIONS：它不属于"表情轮换"。 */
		const DRAG_SPRITE = "drag";
		const DRAG_FADE_MS = 200;
		const DRAG_LIFT = 1.045;

		const BREATH_PX = 5;
		const BREATH_SEC = 3.0;
		const MANUAL_HOLD_MS = 4000;

		const BASE = "/dsh-pet/sprite/";
		/* ⚠️ 换了素材必须 +1，否则浏览器会拿缓存里的旧图 */
		const ASSET_VERSION = 8;
		const spriteUrl = (id) => BASE + id + ".png?v=" + ASSET_VERSION;
		const MIND_URL = "/dsh-pet/__mind";
		const MIND_POLL_MS = 1000;
		const DEMO_MODE = (typeof location !== "undefined")
			&& /[?&]dshpet=demo\b/.test(String(location.search || ""));
		const DEMO_MS = 2200;

		const EXPRESSIONS = [
			{ id: "calm", label: "待机" },
			{ id: "sleepy", label: "困了" },
			{ id: "surprised", label: "惊讶" },
			{ id: "shy", label: "害羞" },
			{ id: "happy", label: "开心" },
			{ id: "cool", label: "冷静" },
			{ id: "calling", label: "呼喊" },
			{ id: "angry", label: "生气" },
			{ id: "sleeping", label: "睡着" },
			{ id: "confused", label: "疑惑" },
			{ id: "love", label: "喜欢" },
			{ id: "excited", label: "兴奋" }
		];
		const BY_ID = {};
		for (const e of EXPRESSIONS) BY_ID[e.id] = e;

		/* ------------------------------------------------------------------ *
		 * 静息表情：不再有节拍器
		 *
		 * 这里原来是一个 4 张脸的轮换池，每 FRAME_MS(2600ms) 换一张，10.4 秒转一圈。
		 * 用户的原话是"生硬的每四秒钟切换一次表情"—— 他说得对：**一个没有原因的
		 * 表情变化，看起来就是机械的**。她打哈欠有原因（隔了十几秒没互动），
		 * 换脸没有，只是时钟走到了。
		 *
		 * 现在闲着就是 `REST_FACE`，安安静静待着；表情只在"有事发生"时变。
		 * 她的"活着"靠呼吸、眨眼、每 11~26 秒的小动作、45 秒后的游走、90 秒后的打盹。
		 * ------------------------------------------------------------------ */
		const REST_FACE = "calm";

		/* ------------------------------------------------------------------ *
		 * 忙 / 闲 分时复用这张脸
		 *
		 * 忙的时候她替 AI 露面，闲的时候她只是她自己。**注意这不是"九个申请者
		 * 抢一个槽位"的老结构** —— 那是 AI 和宠物同时抢、抢输了还不吭声，
		 * 五个顽固 bug 全是那一件事。这里一段时间里只有一个主人。
		 *
		 * 你的鼠标和它自身的状态（点击 / 生气 / 小动作 / 凑近 / 睡觉）
		 * 在两种模式下都优先 —— 那些是"你在跟它说话"，什么时候都该打断。
		 * ------------------------------------------------------------------ */
		const AI_FACE = {
			tool: "calling",        // 在跑工具
			thinking: "cool",       // 思考中
			error: "surprised",     // 出错了
			waiting: "calm",        // 等你
			idle: "calm"
		};
		const FACE_BUSY_DELAY_MS = 1500;   // AI 连续忙满这么久才把脸交出去
		const FACE_REST_DELAY_MS = 4000;   // 闲满这么久才把脸收回来

		/* ------------------------------------------------------------------ *
		 * 自主行为（不再只被动等 AI 状态，自己也会找事做）
		 * ------------------------------------------------------------------ */
		const IDLE_FIRST_MS = 9000;       // 启动后多久才开始可能触发小动作
		const IDLE_GAP_MIN = 11000;       // 两次小动作的最小间隔
		const IDLE_GAP_MAX = 26000;       // 最大间隔

		const WANDER_AFTER_MS = 45000;    // 多久没交互才开始游走
		const WANDER_STEP_MS = 3200;      // 一次游走持续多久（= CSS 过渡时长）
		const WANDER_GAP_MS = 16000;      // 两次游走之间至少隔多久
		const WANDER_X = 130;             // 游走的最大水平距离（px）
		const WANDER_Y = 46;              // 最大垂直距离（px）

		const SLEEP_AFTER_MS = 90000;     // 多久没动静就困（且 AI 也没在干活）
		const SLEEP_BREATH_SEC = 5.4;     // 睡着时呼吸更慢
		/* 睡觉是"打盹"，不是一睡不醒。没有下面这几个数，桌宠在没人管的时候
		   会一直躺着 —— 而"睡着的分支会 return"，于是揉眼睛、散步这些动作
		   再也出不来，用户就"经常见不到其他动作"。 */
		const SLEEP_NAP_MIN_MS = 15000;   // 一觉最短睡多久
		const SLEEP_NAP_MAX_MS = 30000;   // 一觉最长睡多久，到点自己醒
		const SLEEP_AWAKE_MS = 45000;     // 醒来后至少活动这么久才可能再睡

		/* 每个小动作 = 一组 WAAPI 关键帧，作用在 .dshPetAct 这一层上。
		   分层是刻意的：root 被呼吸占着、stage 被拖拽放大占着、img 被"弹一下"占着，
		   只有 act 层是空的，互不覆盖。 */
		const IDLE_ACTIONS = [
			{ id: "tiltL", label: "歪头", ms: 1000, kf: [
				{ transform: "rotate(0deg)" },
				{ transform: "rotate(-3.5deg)", offset: 0.4 },
				{ transform: "rotate(-2deg)", offset: 0.72 },
				{ transform: "rotate(0deg)" } ] },
			{ id: "tiltR", label: "歪头", ms: 1000, kf: [
				{ transform: "rotate(0deg)" },
				{ transform: "rotate(3.5deg)", offset: 0.4 },
				{ transform: "rotate(2deg)", offset: 0.72 },
				{ transform: "rotate(0deg)" } ] },
			{ id: "shake", label: "抖一下", ms: 560, kf: [
				{ transform: "translateX(0px) rotate(0deg)" },
				{ transform: "translateX(-3px) rotate(-2deg)", offset: 0.25 },
				{ transform: "translateX(3px) rotate(2deg)", offset: 0.55 },
				{ transform: "translateX(-2px) rotate(-1deg)", offset: 0.8 },
				{ transform: "translateX(0px) rotate(0deg)" } ] },
			{ id: "hop", label: "跳一下", ms: 780, kf: [
				{ transform: "translateY(0px) scale(1, 1)" },
				{ transform: "translateY(4px) scale(1.03, 0.96)", offset: 0.14 },
				{ transform: "translateY(-16px) scale(0.98, 1.03)", offset: 0.44 },
				{ transform: "translateY(0px) scale(1.03, 0.96)", offset: 0.72 },
				{ transform: "translateY(0px) scale(1, 1)" } ] },
			{ id: "stretch", label: "伸懒腰", ms: 1900, kf: [
				{ transform: "scale(1, 1)" },
				{ transform: "scale(0.97, 1.05)", offset: 0.42 },
				{ transform: "scale(0.975, 1.045)", offset: 0.72 },
				{ transform: "scale(1, 1)" } ] },
			{ id: "lookAway", label: "看向别处", ms: 1500, kf: [
				{ transform: "translateX(0px) rotate(0deg)" },
				{ transform: "translateX(-9px) rotate(-1.5deg)", offset: 0.35 },
				{ transform: "translateX(-9px) rotate(-1.5deg)", offset: 0.7 },
				{ transform: "translateX(0px) rotate(0deg)" } ] },
			/* 打哈欠 / 揉眼睛：用「闭眼微笑」那帧配合拉伸，观感接近；
			   要有真动作帧的话，把 expr 换成新素材 id 即可。 */
			{ id: "yawn", label: "打哈欠", ms: 2000, expr: "sleepy", line: "哈啊……", kf: [
				{ transform: "scale(1, 1)" },
				{ transform: "scale(0.98, 1.06)", offset: 0.38 },
				{ transform: "scale(0.99, 1.04)", offset: 0.74 },
				{ transform: "scale(1, 1)" } ] },
			{ id: "rubEyes", label: "揉眼睛", ms: 1500, expr: "sleepy", kf: [
				{ transform: "rotate(0deg) scale(1)" },
				{ transform: "rotate(2deg) scale(0.99)", offset: 0.28 },
				{ transform: "rotate(-2deg) scale(0.99)", offset: 0.58 },
				{ transform: "rotate(1.5deg) scale(0.99)", offset: 0.84 },
				{ transform: "rotate(0deg) scale(1)" } ] },
		];

		/* ------------------------------------------------------------------ *
		 * 鼠标感知
		 * ------------------------------------------------------------------ */
		/* 距离都是"到桌宠中心"的直线距离。图片半高约 130px，所以 150 其实要贴到脸上
		   才触发；放宽到 190 才能在"慢慢靠近"的过程中就被注意到。 */
		const NEAR_RADIUS = 190;          // 进入这个半径算"靠近"
		const FAR_RADIUS = 380;           // 退出这个半径算"走远"
		const STARTLE_SPEED = 1.7;        // 触发"吓一跳"的鼠标速度（px/ms）
		const STARTLE_RADIUS = 250;       // 只有从附近掠过才吓到
		const STARTLE_COOLDOWN_MS = 4500;
		const NEAR_HOLD_MS = 2400;        // "抬头看你"保持多久
		const WATCH_AWAY_MS = 1800;       // "目送"保持多久

		/* ------------------------------------------------------------------ *
		 * 拖拽物理
		 * ------------------------------------------------------------------ */
		const THROW_SPEED = 0.35;         // 松手速度超过这个才进入物理（否则原地放下）
		const GRAVITY = 0.0026;           // px / ms²（只作用于竖直方向）
		const AIR_FRICTION = 0.9955;      // 水平方向每毫秒保留的速度比例（竖直方向不衰减！）
		const MAX_VY = 3.2;               // 自由落体速度上限（px/ms），防止长距离下落糊成一片
		const BOUNCE = 0.5;               // 落地反弹系数
		const WALL_BOUNCE = 0.6;          // 撞左右边的反弹系数
		const REST_SPEED = 0.075;         // 低于这个速度就停下（px/ms）
		const MAX_SPEED = 4.5;            // 速度上限
		const LAND_SHAKE_SPEED = 0.85;    // 落地速度超过这个就震一下
		const VEL_WINDOW = 110;           // 用最近这么多毫秒的位移算速度
		/* 抬手通常晚于最后一次 pointermove。超过这个宽限期还没新样本，就当"手已经停了"，
		   速度归零 —— 这是"拖到位再轻轻放下"该有的语义，别让它误判成抛掷。 */
		const VEL_GRACE_MS = 60;

		/* ------------------------------------------------------------------ *
		 * 走路动画（游走时叠在位移上的踏步）
		 *
		 * 只给 left/top 加 CSS 过渡，看起来就是"平移"而不是"走过去" ——
		 * 所以游走期间必须在 .dshPetAct 上再叠一层循环的踏步动画。
		 * ------------------------------------------------------------------ */
		const WALK_STEP_MS = 620;         // 一个踏步周期
		const WALK_BOB_PX = 3;            // 抬脚高度
		const WALK_TILT_DEG = 1.8;        // 左右微倾（朝哪边走在算 walkKeyframes 时定）

		/* ------------------------------------------------------------------ *
		 * 交互
		 * ------------------------------------------------------------------ */
		const BUBBLE_MS = 2800;           // 气泡自动消失
		const MULTI_CLICK_WINDOW = 1700;  // 连点判定窗口
		/* 生气的门槛**每次重新随机**。写死 3 的下场是：用户戳两下就知道
		   "第三下必炸"，于是第三下不再是"她生气了"，而是"我触发了那个开关"。 */
		const MULTI_CLICK_MIN = 3;        // 最少点几下才生气
		const MULTI_CLICK_MAX = 6;        // 最多点几下
		const ANGRY_HOLD_MS = 2600;
		/* 仪表提示（note）的冷却：不冷却的话 info 一变就换一句话，看着像复读机 */
		const NOTE_MS = 2600;             // 一条提示默认显示多久
		const NOTE_QUIET_MS = 1800;       // 刚提示过，这么多毫秒内让位
		const ERROR_NOTE_GAP_MS = 12000;   // 报错最短间隔
		const SPACE_NOTE_GAP_MS = 60000;   // 上下文告警最短间隔
		const BUSY_NOTE_GAP_SEC = 15;      // 长任务报进度间隔（秒）
		const BUSY_NOTE_FIRST_SEC = 12;        // 长任务第一次开口的门槛（秒）

		/* ------------------------------------------------------------------ *
		 * AI 状态仪表（.dshPetMeter）
		 *
		 * 它是"AI 的仪表盘"唯一的落脚点 —— 表情/动作/台词一概不碰。
		 * 用颜色和长度表达，所以既看得见又不会抢戏。
		 * ------------------------------------------------------------------ */
		const AI_STATE_COLOR = {
			error: "#ff7a7a",                  // 出错
			tool: "#6fc9ff",                   // 在跑工具
			thinking: "#b39dff",               // 思考中
			longtask: "#ffd479",               // 磨很久
			waiting: "rgba(255, 255, 255, 0.42)", // 回合结束，等你
			idle: "rgba(255, 255, 255, 0.22)"     // 闲着
		};
		/* 只有"正在动"的状态才呼吸；闲着和等你的圆点是静的 */
		const AI_STATE_PULSE = { error: "1.0s", tool: "1.2s", thinking: "2.6s", longtask: "2.6s" };
		const PCT_WARN = 0.60;            // 上下文占用到这儿，条子转黄
		const PCT_HOT = 0.75;             // 到这儿转红，同时开始呼吸提醒
		const PCT_SPACE_ALERT = 0.80;     // 到这儿用一句话明说"快满了"

		/* 工具 → 台词（比只显示"跑工具"更有信息量） */
		const TOOL_LINES = {
			pwsh: "跑个命令…", bash: "跑个命令…", terminal_open: "开终端…",
			read: "翻翻这个文件…", read_image: "看张图…", glob: "找找文件在哪…",
			write: "写点东西…", edit: "改几行…", present: "把成品递给你…",
			grep: "搜搜看…", web_search: "上网查一下…", web_fetch: "读这个网页…",
			workflow: "派一队小助手…", subagent: "叫个小助手帮忙…",
			todo_write: "理一下待办…",
		};

		const CLICK_LINES = [
			"嗯？", "怎么啦", "在的在的", "有事吗？", "我在这儿",
			"又点我…", "嗯嗯", "在听", "你说",
			"唔？", "干嘛呀", "找我吗", "我听着呢", "说呀",
			"戳我做什么", "手好闲哦", "嗯…嗯？",
		];
		/* ------------------------------------------------------------------ *
		 * 点击分区
		 *
		 * 判定顺序**就是数组顺序**：小而特别的区域排在大而笼统的前面
		 * （呆毛在帽子上面，手在头发上面）。mx / my 是相对元素框的 0~1 比例。
		 *
		 * 坐标怎么来的：把 512×683 的素材按 0.1 打上网格量出来的（`node zone_map.js`
		 * 能把这张图连同分区框一起画出来，改完分区跑一次，别靠脑补）。
		 * 原来只有"头 / 身 / 裙摆"三条横切线，戳哪儿都差不多；现在 10 条。
		 * ------------------------------------------------------------------ */
		const ZONES = [
			{ id: "ahoge", expr: "excited", mx: [0.26, 0.54], my: [0.07, 0.23],
				lines: ["呀！呆毛！", "别拽呆毛啦——", "会变形的…", "那是天线吗",
					"呆毛不能拔！", "它自己会动的…", "别拽，会打结", "啊，弹回去了"] },
			{ id: "hat", expr: "shy", mx: [0.10, 0.92], my: [0.14, 0.38],
				lines: ["唔…别摸头", "头饰会歪的", "帽子要掉了", "摸头会长不高的",
					"蕾丝会皱的…", "刚戴好的！", "唔…好舒服", "帽子歪了，帮我扶正"] },
			{ id: "bowR", expr: "happy", mx: [0.68, 0.92], my: [0.33, 0.48],
				lines: ["蝴蝶结好看吧", "轻一点啦", "两边是对称的哦",
					"系了好久的", "蓝色的哦", "松了…帮我系回去"] },
			{ id: "bowL", expr: "happy", mx: [0.10, 0.24], my: [0.34, 0.47],
				lines: ["蝴蝶结好看吧", "轻一点啦", "两边是对称的哦",
					"系了好久的", "蓝色的哦", "松了…帮我系回去"] },
			{ id: "face", expr: "confused", mx: [0.30, 0.66], my: [0.38, 0.60],
				lines: ["唔？", "盯着我干嘛", "脸上有东西吗", "……看什么",
					"戳脸会扁的", "别戳眼睛！", "唔…痒", "腮帮子不许捏"] },
			{ id: "handL", expr: "love", mx: [0.22, 0.35], my: [0.66, 0.80],
				lines: ["握手~", "牵一下", "嘿嘿",
					"手很小的", "要牵手吗", "暖暖的", "别捏，会麻"] },
			{ id: "handR", expr: "love", mx: [0.60, 0.73], my: [0.66, 0.80],
				lines: ["握手~", "牵一下", "嘿嘿",
					"手很小的", "要牵手吗", "暖暖的", "别捏，会麻"] },
			{ id: "apron", expr: "happy", mx: [0.33, 0.63], my: [0.60, 0.84],
				lines: ["围裙上有鲸鱼", "痒…", "别戳肚子",
					"鲸鱼是蓝色的", "肚子不能戳啦", "围裙是我自己洗的", "呜…痒痒的"] },
			{ id: "hairL", expr: "surprised", mx: [0.00, 0.30], my: [0.18, 0.90],
				lines: ["呀！头发乱了", "别扯左边——", "我梳了好久的…",
					"左边是分缝！", "啊，打结了", "别拉，会疼的", "右边可以，左边不行"] },
			{ id: "hairR", expr: "calling", mx: [0.70, 1.00], my: [0.18, 0.90],
				lines: ["哎哎哎——", "右边也不行！", "轻一点啦",
					"两边都不行的", "头发不是绳子", "唔…翘起来了", "刚梳顺的！"] },
			{ id: "feet", expr: "happy", mx: [0.34, 0.62], my: [0.90, 1.00],
				lines: ["痒！", "别碰鞋子", "站不稳了",
					"鞋子是新擦的", "别搔痒啦", "站不住了！", "再碰我踢你哦"] },
			{ id: "skirt", expr: "cool", mx: [0.00, 1.00], my: [0.74, 0.94],
				lines: ["……别掀", "你在看哪里", "哼",
					"不许看下面", "裙子有层次的", "再掀我生气了", "手，拿开"] },
		];
		/* 落在人形椭圆内、但不在任何分区里的兜底（主要是裙摆两侧和手臂内侧） */
		const ZONE_FALLBACK = {
			id: "body", expr: "happy",
			lines: ["干嘛呀", "痒…", "嘿嘿", "别戳啦",
				"唔？", "找我吗", "有点痒"]
		};
		const BORED_LINES = [
			"好闲…", "要不要做点什么", "我在这儿等着", "有点无聊",
			"你忙你的，我不吵", "发呆中…",
		];
		/* ------------------------------------------------------------------ *
		 * 手动交互的台词池
		 *
		 * 全部走 pick(list, seed) 取模选词，所以**池子越长越不容易重复**；
		 * 相邻两次点击间隔通常几百毫秒，池子 7~9 句时基本不会连着撞同一句。
		 * 台词要短（气泡只有一行、1.5~2.2 秒），而且要能听出"戳的是哪儿"。
		 *
		 * 两个池子的**第一句是锁死的**：
		 *   STARTLE_LINES[0] = "！"        —— 测试 6.8 认这一句
		 *   ANGRY_LINES[0]   = "别戳了！"  —— 测试 6.11 / 6.31 认这一句
		 * 它们用各自的计数器取下标（第一次必然是 0），所以第一句永远不变，
		 * 变花样只发生在被吓第二回、被戳生气第二回之后。
		 * 要加词往后加，**别动第 0 个**。
		 * ------------------------------------------------------------------ */
		const WAKE_LINES = ["唔…醒了", "我没睡！", "哈…几点了", "嗯？怎么了",
			"唔…别吵", "我醒着呢…", "呜…再睡五分钟", "谁！…哦，是你"];
		const FLY_LINES = ["哇——", "放我下来！", "呜哇", "晕了…",
			"要飞出去了！", "哇啊啊啊——", "转…转晕了", "轻点扔！", "我恐高的！"];
		const LAND_LINES = ["到了", "唔…", "站稳了",
			"呼…落地了", "晕…", "到了吗", "下次轻点", "唔…屁股疼"];
		const NEAR_LINES = ["看你~", "在的", "嗯？", "我在这儿",
			"来啦？", "要找什么吗", "我在这里哦", "鼠标别抖"];
		const AWAY_LINES = ["走啦？", "慢走…", "再见~",
			"又走了…", "嗯，去忙吧", "拜拜", "路上小心"];
		const STARTLE_LINES = ["！", "哇！", "吓我一跳！", "唔哇——", "！？", "别突然冒出来！"];
		const ANGRY_LINES = ["别戳了！", "说了别戳！", "再戳就生气了", "哼！",
			"唔…不理你了", "手拿开啦", "我要咬人了哦"];

		/* ------------------------------------------------------------------ *
		 * 从 digest 提取客观数据
		 *
		 * 这里原来还有 `localState()` + `exprFor(frame)`：一个按开机时间算帧号、
		 * 再拿帧号去轮换池里取表情的节拍器。它被整体删掉了 —— 见上面 REST_FACE
		 * 那段注释。别再把它加回来：定时换脸 = 机械感。
		 * ------------------------------------------------------------------ */

		/* ------------------------------------------------------------------ *
		 * 这里曾经有一整套「按 AI 说的话猜表情」的规则：CONTENT_RULES /
		 * mindToExprs / RULE_WEIGHT / INTENT_MAP / TOOL_EMOJI / pickByScore。
		 *
		 * 它被整体删除，因为它正是"这张脸到底听谁的"这个问题的病根：只要 AI
		 * 在说话，它就会抢走表情槽位，而且抢赢了不吭声 —— 用户看到的是"宠物
		 * 今天有点安静"，而不是"出错了"。安静和坏掉长得一模一样。
		 *
		 * 现在脸只由宠物自身状态 + 鼠标互动决定（见渲染期的 expr 那一段），
		 * AI 的状态改由 .dshPetMeter 那条独立小仪表表达，两者互不干扰。
		 *
		 * 想恢复"内容感知表情"，正确的做法不是把它塞回表情链，而是在仪表盘上
		 * 再加一个字段（比如"当前在聊什么"），不要再让它碰脸。
		 * ------------------------------------------------------------------ */
		const INTENT_LABEL = {
			tool: "跑工具",
			thinking: "思考中",
			waiting: "等你",
			error: "出错",
			longtask: "磨很久",
		};

		/* 从 digest 里抽出"界面要显示的真实数据"。
		   只在数值发生**可见变化**时才回传，避免每秒重渲染。 */
		function infoFromDigest(digest) {
			const d = digest || {};
			let todos = null;
			try {
				if (d.todos && Number.isFinite(Number(d.todos.total)) && Number(d.todos.total) > 0) {
					todos = { done: Number(d.todos.done) || 0, total: Number(d.todos.total) || 0 };
				}
			} catch (err) { todos = null; }
			let pct = 0, used = 0, limit = 0;
			try {
				if (d.meter && Number.isFinite(Number(d.meter.pct))) {
					pct = Number(d.meter.pct) || 0;
					used = Number(d.meter.used) || 0;
					limit = Number(d.meter.limit) || 0;
				}
			} catch (err) { pct = 0; }
			return {
				intent: String(d.intent || "idle"),
				tool: String(d.tool || ""),
				error: !!d.error,
				todos: todos,
				pct: pct,
				used: used,
				limit: limit,
				taskSince: Number(d.taskSince) || 0,
				turnSince: Number(d.turnSince) || 0,
			};
		}

		/** 数值指纹：只有它变了才值得重渲染 */
		function infoKey(info) {
			if (!info) return "";
			const t = info.todos ? (info.todos.done + "/" + info.todos.total) : "-";
			return info.intent + "|" + info.tool + "|" + (info.error ? 1 : 0)
				+ "|" + t
				+ "|" + Math.round(info.pct * 20)
				+ "|" + (info.taskSince ? 1 : 0);
		}

		/* 轮询宿主：**只**取客观状态（意图 / 工具 / 进度 / 上下文 / 计时）。
		   ⚠️ 这里绝不产出表情。它曾经会把"AI 说的话"算成一个表情写进 mind.id，
		   于是脸被 AI 占住、宠物自己的动作被永久饿死（睡觉、靠近、散步全没了）。
		   那条路已经整体删除 —— 脸归宠物，AI 状态走 .dshPetMeter 那条独立仪表。 */
		function scheduleContentProbe(setInfo, demoMode) {
			react.useEffect(() => {
				if (demoMode) return undefined;
				let alive = true;
				let lastInfoKey = null;

				const tick = async () => {
					if (!alive) return;
					try {
						const res = await fetch(MIND_URL, { cache: "no-store" });
						if (!res || !res.ok) return;
						const body = await res.json();
						const info = infoFromDigest(body && body.digest);
						/* 只在**可见值**变化时才 setInfo，否则每秒都会重渲染 */
						const ik = infoKey(info);
						if (ik === lastInfoKey) return;
						lastInfoKey = ik;
						if (alive) setInfo(info);
					} catch (err) {
						/* 拿不到就保持现状：绝不因为探测失败而崩 */
					}
				};

				tick();
				const t = setInterval(tick, MIND_POLL_MS);
				return () => { alive = false; clearInterval(t); };
			}, []);
		}

		/* ------------------------------------------------------------------ *
		 * 样式
		 * ------------------------------------------------------------------ */
		function vhToPx(vh) {
			const h = (typeof window !== "undefined" && window.innerHeight) || 900;
			return Math.max(160, Math.round((vh / 100) * h));
		}

		/** 单调时钟（毫秒）。统一走这里，免得同一个函数里混用两套时基。 */
		function nowMs() {
			return (typeof performance !== "undefined" && performance.now)
				? performance.now()
				: Date.now();
		}

		/** 立绘的渲染尺寸（和渲染期用的 boxW/boxH 同一套算法） */
		function petBox() {
			const bh = vhToPx(HEIGHT_VH);
			return { w: Math.round(bh * (SPRITE_W / SPRITE_H)), h: bh };
		}

		/**
		 * 把位置夹到"至少 MARGIN_KEEP 像素留在视口内"，保证桌宠永远点得到。
		 *
		 * ⚠️ 左边必须用**宠物自身宽度 bw**，绝不能用窗口宽度 w。
		 * 写成 `x >= -(w - MARGIN_KEEP)` 时，一只 200px 宽的立绘在 1440px 窗口里
		 * 可以被放到 x = -1380，也就是整只在视口外 —— 松手即消失，
		 * 而且因为没有任何界面入口，用户再也点不回来。
		 */
		function clampToView(p, bw, bh) {
			const w = (typeof window !== "undefined" && window.innerWidth) || 1280;
			const h = (typeof window !== "undefined" && window.innerHeight) || 900;
			const mw = Math.min(MARGIN_KEEP, bw);
			const mh = Math.min(MARGIN_KEEP, bh);
			const x = Number.isFinite(p && p.x) ? p.x : 0;
			const y = Number.isFinite(p && p.y) ? p.y : 0;
			return {
				x: Math.max(-(bw - mw), Math.min(x, w - mw)),
				y: Math.max(0, Math.min(y, h - mh))
			};
		}

		const CSS_ID = "dsh-pet-style";
		const CSS_TEXT = [
			"@keyframes dshPetBreath {",
			"  0%   { transform: translateY(0px); }",
			"  50%  { transform: translateY(-" + BREATH_PX + "px); }",
			"  100% { transform: translateY(0px); }",
			"}",
			/* 睡着时更慢更深的呼吸 */
			"@keyframes dshPetBreathSleep {",
			"  0%   { transform: translateY(0px) scale(1, 1); }",
			"  50%  { transform: translateY(-" + (BREATH_PX + 2) + "px) scale(1.012, 1.016); }",
			"  100% { transform: translateY(0px) scale(1, 1); }",
			"}",
			".dshPetRoot {",
			"  animation: dshPetBreath " + BREATH_SEC + "s ease-in-out infinite;",
			"  will-change: transform;",
			"}",
			/* 睡着时的 Zzz：三颗不同节奏往上飘 */
			"@keyframes dshPetZzz {",
			"  0%   { opacity: 0; transform: translate(0px, 0px) scale(0.7) rotate(-6deg); }",
			"  18%  { opacity: 0.95; }",
			"  100% { opacity: 0; transform: translate(16px, -42px) scale(1.18) rotate(12deg); }",
			"}",
			".dshPetZzz {",
			"  position: absolute;",
			"  right: 12%;",
			"  top: 16%;",
			"  font-size: 15px;",
			"  font-weight: 700;",
			"  color: rgba(220, 236, 255, 0.92);",
			"  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);",
			"  animation: dshPetZzz 3.2s ease-out infinite;",
			"  pointer-events: none;",
			"}",
			/* 落地扬尘 */
			"@keyframes dshPetDust {",
			"  0%   { opacity: 0.85; transform: translateX(-50%) scale(0.5); }",
			"  100% { opacity: 0; transform: translateX(-50%) scale(2.1); }",
			"}",
			".dshPetDust {",
			"  position: absolute;",
			"  left: 50%;",
			"  bottom: -2px;",
			"  width: 46px;",
			"  height: 12px;",
			"  border-radius: 999px;",
			"  background: radial-gradient(ellipse at center, rgba(210, 226, 255, 0.55), rgba(210, 226, 255, 0));",
			"  animation: dshPetDust 460ms ease-out forwards;",
			"  pointer-events: none;",
			"}",
			/* 气泡：漫画纸面 + 墨线 + 一个朝她指的尖尾巴。
			   市面桌宠（Shimeji / Live2D 那一类）的通用长相就是"贴纸感"：
			   近白纸面、深色粗描边、弹入时过冲一下。深色界面上近白纸面
			   本身就比原来的半透明深色泡泡显眼得多。
			   三套配色按情绪分：普通 / 大声 / 犯困，见 .dshPetBubbleShout|Soft。 */
			"@keyframes dshPetBubbleIn {",
			"  0%   { opacity: 0; transform: translate(-50%, 11px) scale(0.76) rotate(-7deg); }",
			"  62%  { opacity: 1; transform: translate(-50%, -1px) scale(1.05) rotate(var(--dshPetTilt)); }",
			"  100% { opacity: 1; transform: translate(-50%, 0px) scale(1) rotate(var(--dshPetTilt)); }",
			"}",
			".dshPetBubble {",
			"  --dshPetTilt: -2.2deg;",
			"  --dshPetPaper: #fffdf7;",
			"  --dshPetInk: #2b3550;",
			"  animation: dshPetBubbleIn 280ms cubic-bezier(.34, 1.46, .64, 1);",
			"  pointer-events: none;",
			"  max-width: 210px;",
			"  text-align: center;",
			"  padding: 6px 11px;",
			"  border-radius: 13px 13px 13px 5px;",
			"  font-size: 12.5px;",
			"  font-weight: 600;",
			"  line-height: 1.4;",
			"  letter-spacing: 0.2px;",
			"  color: var(--dshPetInk);",
			"  background: var(--dshPetPaper);",
			"  border: 2px solid var(--dshPetInk);",
			"  box-shadow: 0 5px 16px rgba(8, 12, 28, 0.5);",
			"}",
			/* 尾巴：一个转了 45° 的方块，右下两条边当描边、圆角当笔尖。
			   上半截被气泡自己的纸面盖住，于是底边那一段墨线被"吃掉"——
			   这正是对话气泡开口的样子。 */
			".dshPetBubble::after {",
			"  content: \"\";",
			"  position: absolute;",
			"  left: 24px;",
			"  top: 100%;",
			"  margin-top: -7px;",
			"  width: 14px;",
			"  height: 14px;",
			"  background: var(--dshPetPaper);",
			"  border-right: 2px solid var(--dshPetInk);",
			"  border-bottom: 2px solid var(--dshPetInk);",
			"  border-bottom-right-radius: 3px;",
			"  transform: rotate(45deg);",
			"}",
			/* 大声：生气 / 受惊 / 被扔出去。红墨、更粗更斜、尾巴更尖 */
			".dshPetBubbleShout {",
			"  --dshPetTilt: -3.6deg;",
			"  --dshPetPaper: #fff6ef;",
			"  --dshPetInk: #8c2f3f;",
			"  font-size: 13.5px;",
			"  font-weight: 800;",
			"  letter-spacing: 0.6px;",
			"}",
			".dshPetBubbleShout::after {",
			"  left: 17px;",
			"  width: 17px;",
			"  height: 17px;",
			"  margin-top: -8px;",
			"}",
			/* 犯困 / 害羞：蓝墨、虚线边、更圆，像自言自语 */
			".dshPetBubbleSoft {",
			"  --dshPetTilt: -1.2deg;",
			"  --dshPetPaper: #f3f6ff;",
			"  --dshPetInk: #55618c;",
			"  border-style: dashed;",
			"  border-radius: 16px 16px 16px 8px;",
			"  font-weight: 500;",
			"}",
			/* 上下文压力高时：标签描边变暖 */
			"@keyframes dshPetPressure {",
			"  0%, 100% { box-shadow: 0 0 0 1px rgba(255, 138, 138, 0.5); }",
			"  50%      { box-shadow: 0 0 0 3px rgba(255, 138, 138, 0.22); }",
			"}",
			".dshPetPressure { animation: dshPetPressure 1.8s ease-in-out infinite; }",
			/* AI 状态仪表的圆点：只有"正在动"的状态才呼吸（节奏内联给出） */
			"@keyframes dshPetPulse {",
			"  0%, 100% { opacity: 0.4; }",
			"  50%      { opacity: 1; }",
			"}",
			".dshPetDot { display: inline-block; }",
			/* 仪表提示的入场：一行小字滑进来，刻意不用气泡 */
			"@keyframes dshPetNoteIn {",
			"  0%   { opacity: 0; transform: translate(-50%, 4px); }",
			"  100% { opacity: 1; transform: translate(-50%, 0px); }",
			"}",
			/* 标签里的 ↻：收进药丸，省掉原来挂在下方抢位置的圆按钮 */
			".dshPetTagGo {",
			"  pointer-events: auto;",
			"  cursor: pointer;",
			"  opacity: 0.55;",
			"  font-size: 11px;",
			"}",
			".dshPetTagGo:hover { opacity: 1; }",
			/* 交互层 */
			".dshPetRoot { pointer-events: none; }",
			".dshPetRoot .dshPetStage { pointer-events: none; }",
			".dshPetRoot .dshPetAct { pointer-events: none; }",
			".dshPetRoot .dshPetDrag { pointer-events: none; }",
			".dshPetRoot .dshPetImg {",
			"  pointer-events: auto;",
			"  cursor: pointer;",
			"}",
			".dshPetRoot .dshPetImg:active { cursor: grabbing; }",
			".dshPetRoot .dshPetImg:hover {",
			"  filter: drop-shadow(0 10px 22px rgba(0, 0, 0, 0.45)) drop-shadow(0 0 12px rgba(140, 190, 255, 0.55));",
			"}",
		].join("\n");

		/* 点击热区：不用 CSS clip-path（它会同时裁剪显示，把立绘切成椭圆） */
		const CLICK_ELLIPSE = { cx: 0.52, cy: 0.51, rx: 0.45, ry: 0.47 };

		/** 按 ZONES 的顺序找出命中的分区；不在任何分区里就用兜底 */
		function zoneAt(x, y) {
			for (let i = 0; i < ZONES.length; i += 1) {
				const z = ZONES[i];
				if (x >= z.mx[0] && x <= z.mx[1] && y >= z.my[0] && y <= z.my[1]) return z;
			}
			return ZONE_FALLBACK;
		}

		/** 点击位置是否落在人形椭圆内，并顺便给出所在分区 */
		function hitZone(ev) {
			const miss = { hit: true, zone: "body", y: 0.5 };
			try {
				const el = ev && ev.currentTarget;
				if (!el || typeof el.getBoundingClientRect !== "function") return miss;
				const r = el.getBoundingClientRect();
				if (!r.width || !r.height) return miss;
				const x = (ev.clientX - r.left) / r.width;
				const y = (ev.clientY - r.top) / r.height;
				const dx = (x - CLICK_ELLIPSE.cx) / CLICK_ELLIPSE.rx;
				const dy = (y - CLICK_ELLIPSE.cy) / CLICK_ELLIPSE.ry;
				const inside = (dx * dx + dy * dy) <= 1;
				return { hit: inside, zone: zoneAt(x, y).id, y: y };
			} catch (err) {
				return miss;
			}
		}

		const rootStyle = {
			position: "fixed",
			pointerEvents: "none",
			userSelect: "none",
			zIndex: 40
		};

		const imgStyle = {
			display: "block",
			objectFit: "contain",
			objectPosition: "center bottom",
			filter: "drop-shadow(0 10px 22px rgba(0, 0, 0, 0.45))",
			opacity: 0,
			transition: "opacity " + FADE_MS + "ms ease"
		};

		const stageStyle = {
			position: "absolute",
			left: 0, top: 0, width: "100%", height: "100%",
			transformOrigin: "50% 96%",
			transition: "transform " + DRAG_FADE_MS + "ms ease"
		};

		/* 自主动作层：唯一空闲的 transform 通道 */
		const actStyle = {
			position: "absolute",
			left: 0, top: 0, width: "100%", height: "100%",
			transformOrigin: "50% 92%"
		};

		const dragImgStyle = Object.assign({}, imgStyle, {
			position: "absolute",
			left: 0, top: 0,
			pointerEvents: "none",
			transition: "opacity " + DRAG_FADE_MS + "ms ease"
		});

		const tagStyle = {
			position: "absolute",
			left: "50%",
			bottom: "-20px",
			transform: "translateX(-50%)",
			display: "flex",
			alignItems: "center",
			gap: "6px",
			whiteSpace: "nowrap",
			fontSize: "11px",
			lineHeight: "1.4",
			padding: "2px 9px",
			borderRadius: "999px",
			background: "rgba(10, 12, 24, 0.55)",
			color: "rgba(255, 255, 255, 0.86)",
			backdropFilter: "blur(6px)",
			WebkitBackdropFilter: "blur(6px)",
			border: "1px solid rgba(255, 255, 255, 0.14)"
		};

		/* 气泡只留几何；长相（纸面/墨线/尾巴/三套配色）全部在 CSS_TEXT 里 ——
		   配色要按情绪换，写在内联样式里就没法用类切换了。 */
		const bubbleStyle = {
			position: "absolute",
			left: "50%",
			bottom: "calc(100% + 6px)",
			/* 收尾的倾斜必须和 @keyframes 的 100% 用同一个变量，
			   否则动画一播完就会"啪"地弹回不倾斜的样子 */
			transform: "translateX(-50%) rotate(var(--dshPetTilt))"
		};

		/* ------------------------------------------------------------------ *
		 * AI 状态仪表：挂在标签下面的一条小横带
		 *
		 * 圆点 = 状态（颜色 + 呼吸节奏）、细条 = 上下文占用（长度），
		 * 一行小字 = 只在真有事时出现的进度/耗时。
		 * 三者都不碰表情、不碰动作、不占宠物气泡 —— 这就是"仪表盘搬走"。
		 * ------------------------------------------------------------------ */
		const meterStyle = {
			position: "absolute",
			left: "50%",
			bottom: "-39px",
			transform: "translateX(-50%)",
			display: "flex",
			alignItems: "center",
			gap: "5px",
			width: "min(80%, 190px)",
			padding: "2px 7px",
			borderRadius: "999px",
			background: "rgba(10, 12, 24, 0.42)",
			backdropFilter: "blur(6px)",
			WebkitBackdropFilter: "blur(6px)",
			border: "1px solid rgba(255, 255, 255, 0.08)",
			whiteSpace: "nowrap",
			/* 要能 hover 出 tooltip；它的 pointerdown 会被就地吞掉，不会带出拖拽 */
			pointerEvents: "auto",
			cursor: "help"
		};

		const dotStyle = {
			flex: "0 0 auto",
			width: "7px",
			height: "7px",
			borderRadius: "999px",
			boxShadow: "0 0 6px currentColor"
		};

		const barStyle = {
			flex: "1 1 auto",
			minWidth: "26px",
			height: "3px",
			borderRadius: "999px",
			background: "rgba(255, 255, 255, 0.16)",
			overflow: "hidden"
		};

		const barFillStyle = {
			display: "block",
			height: "100%",
			borderRadius: "999px",
			transition: "width 400ms ease, background 400ms ease"
		};

		const meterTextStyle = {
			flex: "0 1 auto",
			fontSize: "10px",
			lineHeight: "1.3",
			color: "rgba(255, 255, 255, 0.78)",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		/* 仪表提示：系统口吻的一行小字。
		   刻意**不用气泡** —— 气泡是"她在说话"，两者必须一眼分得开。 */
		const noteStyle = {
			position: "absolute",
			left: "50%",
			bottom: "-59px",
			transform: "translateX(-50%)",
			maxWidth: "96%",
			padding: "1px 6px",
			borderRadius: "4px",
			fontSize: "10.5px",
			lineHeight: "1.4",
			color: "rgba(206, 224, 255, 0.82)",
			background: "rgba(10, 12, 24, 0.4)",
			whiteSpace: "nowrap",
			pointerEvents: "none",
			animation: "dshPetNoteIn 200ms ease-out"
		};

		function pick(list, seed) {
			if (!Array.isArray(list) || list.length === 0) return "";
			const i = Math.abs(Math.floor(seed)) % list.length;
			return list[i];
		}

		/* ================================================================== *
		 * 组件
		 * ================================================================== */
		function Pet(props) {
			/* ---- hook 段：数量与顺序恒定，且绝不调用宿主传入的 hook ---- */
			const [tick, setTick] = react.useState(0);
			const [manual, setManual] = react.useState(null);
			const [loaded, setLoaded] = react.useState(false);
			/* AI 状态的一行提示（出错 / 上下文 / 工具 / 进度）。
			   ⚠️ 它走独立的 note 通道，绝不占用宠物气泡 —— 用户要能一眼分清
			   "这是她在说话"还是"这是仪表在报数"。 */
			const [meterNote, setMeterNote] = react.useState(null);
			const [info, setInfo] = react.useState(null);
			const [dragReady, setDragReady] = react.useState(false);
			const [pos, setPos] = react.useState(() => {
				const w = (typeof window !== "undefined" && window.innerWidth) || 1280;
				const box = petBox();
				try {
					if (typeof localStorage !== "undefined") {
						const raw = localStorage.getItem(POS_KEY);
						if (raw) {
							const v = JSON.parse(raw);
							if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) {
								/* 存档可能来自修复前的版本（整只在视口外），也可能窗口比上次小 ——
								   一律夹回可见范围，否则一加载就消失且点不回来 */
								return clampToView({ x: v.x, y: v.y }, box.w, box.h);
							}
						}
					}
				} catch (err) { /* 读不到就用默认位置 */ }
				return { x: Math.max(0, w - SHIFT_RIGHT - box.w), y: vhToPx(SHIFT_TOP) };
			});
			const [dragging, setDragging] = react.useState(false);
			const [flying, setFlying] = react.useState(false);
			const [bubble, setBubble] = react.useState(null);
			const [action, setAction] = react.useState(null);
			const [asleep, setAsleep] = react.useState(false);
			const [moving, setMoving] = react.useState(false);
			const [dust, setDust] = react.useState(0);
			const [angry, setAngry] = react.useState(0);
			const [near, setNear] = react.useState("");

			const imgRef = react.useRef(null);
			const actRef = react.useRef(null);
			const firstPopDone = react.useRef(false);
			const dragRef = react.useRef(null);
			const physRef = react.useRef(null);
			const ptrRef = react.useRef(null);
			const geomRef = react.useRef({ x: 0, y: 0, w: 0, h: 0 });
			const posRef = react.useRef(pos);
			const clickRef = react.useRef({ n: 0, t: 0, need: 0, shout: 0 });
			const idleRef = react.useRef({ next: 0, cur: null, bag: [] });
			/* 游走时的踏步循环动画（独立于 idleRef.cur，两者互斥） */
			const walkRef = react.useRef(null);
			const interactRef = react.useRef(Date.now());
			const wanderRef = react.useRef({ last: 0 });
			const bubbleSeq = react.useRef(0);
			const bubbleAtRef = react.useRef(0);
			/* 仪表提示自己的冷却时间戳（与宠物气泡各算各的，互不挤占） */
			const noteAtRef = react.useRef(0);
			/* 三条"提醒类"气泡各自的冷却，免得同一句话反复刷屏 */
			const busyNoteRef = react.useRef(0);
			const spaceNoteRef = react.useRef(0);
			const errNoteRef = react.useRef(0);
			const mountedRef = react.useRef(true);
			/* 两个"最新值"镜像：定时器/事件监听里只能看到创建时的闭包，
			   直接读 state 会拿到过期值，所以统一从这里取最新。
			   （AI 状态的镜像已删除：脸不再读它，连睡觉判断也不再读它。） */
			const asleepRef = react.useRef(false);
			/* 打盹循环的状态：napUntil = 这一觉睡到什么时候（到点自己醒），
			   canSleepAt = 醒来后要活动到什么时候才允许再睡。 */
			const sleepRef = react.useRef({ napUntil: 0, canSleepAt: 0 });
			const actionRef = react.useRef(null);
			/* 忙 / 闲 分时复用的状态机：want = AI 此刻想不想占脸，
			   busy = 现在实际归谁，since = want 最近一次变化的时间。
			   两个 delay 就是这里的迟滞量，见 AI_FACE 那段注释。 */
			const faceRef = react.useRef({ want: false, busy: false, since: 0 });

			scheduleContentProbe(setInfo, DEMO_MODE);

			/* ---- 小工具 ---- */
			function say(text, ms) {
				if (!text) return;
				bubbleSeq.current += 1;
				bubbleAtRef.current = Date.now();
				setBubble({ text: String(text), key: bubbleSeq.current, ms: ms || BUBBLE_MS });
			}

			/**
			 * 仪表提示 —— 注意这不是宠物在说话。
			 * 单独一条通道的意义：宠物气泡 = 她的台词；note = 系统在报数。
			 * 两者可以同时出现，谁也不顶掉谁，用户一眼能分清是谁在说。
			 */
			function note(text, ms) {
				if (!text) return;
				noteAtRef.current = Date.now();
				setMeterNote({ text: String(text), key: noteAtRef.current, ms: ms || NOTE_MS });
			}

			/** 刚提示过就别马上再提示，免得刷屏 */
			function notedRecently(ms) {
				return (Date.now() - noteAtRef.current) < (ms || 900);
			}

			function touch() {
				interactRef.current = Date.now();
				if (asleep) setAsleep(false);
			}

			function persist(p) {
				try {
					if (typeof localStorage !== "undefined") {
						localStorage.setItem(POS_KEY, JSON.stringify({ x: p.x, y: p.y }));
					}
				} catch (err) { /* 存不了也无妨 */ }
			}

			function stopPhysics() {
				const ph = physRef.current;
				if (ph && ph.raf) {
					if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(ph.raf);
					else clearTimeout(ph.raf);
				}
				physRef.current = null;
				setFlying(false);
			}

			/* ---- 拖拽 ---- */
			function onPointerDown(ev) {
				if (ev.button !== undefined && ev.button !== 0) return;
				touch();
				stopPhysics();
				stopWalk();              // 踏步循环必须停，否则被抓起来还在原地踏步
				setMoving(false);        // 游走的过渡必须立刻停掉，否则拖拽会"追不上手"
				setNear("");
				const p = ev.currentTarget;
				try { if (p && p.setPointerCapture) p.setPointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }
				dragRef.current = {
					startX: ev.clientX, startY: ev.clientY,
					origX: pos.x, origY: pos.y,
					moved: false,
					samples: [{ t: (typeof performance !== "undefined" ? performance.now() : Date.now()), x: ev.clientX, y: ev.clientY }]
				};
			}

			function onPointerMove(ev) {
				const d = dragRef.current;
				if (!d) return;
				const now = nowMs();   /* ⚠️ 必须和 releaseVelocity 用同一个时基，否则速度算出来是天文数字 */
				d.samples.push({ t: now, x: ev.clientX, y: ev.clientY });
				if (d.samples.length > 24) d.samples.shift();
				const dx = ev.clientX - d.startX;
				const dy = ev.clientY - d.startY;
				if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
				d.moved = true;
				setDragging(true);
				/* 同步写 posRef：万一抬手来得比 React 重渲染还快，onPointerUp 读到的
				   就是这里的最新值，而不是 React 上一次渲染时的旧 pos */
				const np = { x: d.origX + dx, y: d.origY + dy };
				posRef.current = np;
				setPos(np);
			}

			/**
			 * 用最近 VEL_WINDOW 毫秒的位移估算松手速度（px/ms）。
			 *
			 * ⚠️ 这里踩过一个很隐蔽的坑，症状是"想甩飞，松手却停在原地"：
			 * 原来把**窗口内最早的样本**当成终点（循环从后往前扫，`a` 被反复覆盖成更早的
			 * 那个），基准点 `b` 则是窗口外的那一个；一旦**所有样本都落在窗口内**（快速一
			 * 甩就是这种情况，整个拖动还不到 110ms），`b` 就是 null，于是
			 * `from = s[0]`、`a` 也退化成 `s[0]` —— 同一个点相减，位移恒为 0，
			 * `dt = max(1, 0) = 1`，速度算出来就是 0，永远进不了物理。
			 * **甩得越快反而越甩不出去**，就是这么来的。
			 *
			 * 正确语义：基准点取窗口内最早的样本，**终点必须是最新样本/抬手点**。
			 */
			function releaseVelocity(d, ev) {
				const now = nowMs();
				const s = (d && d.samples) || [];
				if (s.length < 2) return { vx: 0, vy: 0 };
				const newest = s[s.length - 1];
				/* 抬手离最后一次移动太久 → 手已经停了，轻轻放下 */
				if (now - newest.t > VEL_GRACE_MS) return { vx: 0, vy: 0 };
				/* 基准点：窗口内最早的那个样本；若一个都不在窗口内就退回拖动起点 */
				let from = s[0];
				for (let i = s.length - 1; i >= 0; i--) {
					if (now - s[i].t <= VEL_WINDOW) from = s[i];
					else break;
				}
				/* 终点优选用真实抬手坐标：pointermove 会被浏览器合并/降频，
				   最后一次样本可能还差几十毫秒的位移，用抬手点能把它补回来 */
				const endX = (ev && typeof ev.clientX === "number") ? ev.clientX : newest.x;
				const endY = (ev && typeof ev.clientY === "number") ? ev.clientY : newest.y;
				const dt = Math.max(1, now - from.t);
				let vx = (endX - from.x) / dt;
				let vy = (endY - from.y) / dt;
				const sp = Math.sqrt(vx * vx + vy * vy);
				if (sp > MAX_SPEED) { vx = vx / sp * MAX_SPEED; vy = vy / sp * MAX_SPEED; }
				return { vx: vx, vy: vy };
			}

			function onPointerUp(ev) {
				const d = dragRef.current;
				dragRef.current = null;
				if (!d) return;
				/* 无条件复位：不能写 `if (dragging)` —— dragging 是本轮渲染的闭包值，
				   若抬手快过 React 重渲染它还是 false，会把人物永久卡在拖拽表情上 */
				setDragging(false);

				if (!d.moved) {
					/* 没移动 → 点击：分区反应 + 连点生气 */
					const z = hitZone(ev);
					if (!z.hit) return;
					touch();
					const now = Date.now();
					const c = clickRef.current;
					/* 换了一轮（隔太久）就重新掷一次生气的门槛 */
					if (now - c.t > MULTI_CLICK_WINDOW || !c.need) {
						c.n = 0;
						c.t = now;
						c.need = rollAngryNeed();
					}
					c.n += 1;
					c.t = now;
					if (c.n >= c.need) {
						c.n = 0;
						c.need = rollAngryNeed();   // 下一次也要重新掷，不然规律还是能被摸出来
						setAngry(Date.now());
						setManual("angry");
						/* 第一次生气必然是 ANGRY_LINES[0]（"别戳了！"），
						   之后每生气一次往后挪一句。计数器不清零：
						   "又生气了"本来就该换句新的，而不是回到第一句。 */
						const shoutIdx = c.shout || 0;
						c.shout = shoutIdx + 1;
						say(ANGRY_LINES[shoutIdx % ANGRY_LINES.length], 2200);
						setTick((n) => n + 1);
						return;
					}
					const zdef = zoneDefOf(z.zone);
					setManual(zdef.expr);
					say(pick(zdef.lines || CLICK_LINES, now + z.y * 100), 2000);
					setTick((n) => n + 1);
					return;
				}

				/* 拖拽结束：够快就进入物理（抛掷），否则原地放下并夹回视口 */
				const v = releaseVelocity(d, ev);
				const speed = Math.sqrt(v.vx * v.vx + v.vy * v.vy);

				if (speed >= THROW_SPEED) {
					startPhysics(v.vx, v.vy);
					say(pick(FLY_LINES, Date.now()), 1200);
					return;
				}
				const cur = posRef.current || pos;
				const box = petBox();
				const np = clampToView(cur, box.w, box.h);
				posRef.current = np;
				setPos(np);
				persist(np);
			}

			/** 分区 id -> 该分区的定义（表情 + 台词）。兜底见 ZONE_FALLBACK */
			function zoneDefOf(id) {
				for (let i = 0; i < ZONES.length; i += 1) {
					if (ZONES[i].id === id) return ZONES[i];
				}
				return ZONE_FALLBACK;
			}

			/** 掷一次"点几下才生气"。窗口每次重置都重新掷，所以摸不出规律 */
			function rollAngryNeed() {
				return MULTI_CLICK_MIN
					+ Math.floor(Math.random() * (MULTI_CLICK_MAX - MULTI_CLICK_MIN + 1));
			}

			/* ---- 拖拽物理：惯性 + 重力 + 落地回弹 + 撞边 ---- */
			function startPhysics(vx, vy) {
				stopWalk();
				const w = (typeof window !== "undefined" && window.innerWidth) || 1280;
				const h = (typeof window !== "undefined" && window.innerHeight) || 900;
				const g = geomRef.current;
				const bw = g.w || 200;
				const bh = g.h || 260;
				const minX = -(bw - MARGIN_KEEP);
				const maxX = w - MARGIN_KEEP;
				const floorY = Math.max(0, h - bh);

				const ph = {
					vx: vx, vy: vy,
					x: posRef.current.x, y: posRef.current.y,
					raf: 0,
					last: (typeof performance !== "undefined" ? performance.now() : Date.now()),
					landed: false
				};
				physRef.current = ph;
				setFlying(true);

				const step = () => {
					if (!mountedRef.current || physRef.current !== ph) return;
					const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
					const dt = Math.max(1, Math.min(42, now - ph.last));
					ph.last = now;

					/* 重力只作用在竖直方向，空气阻力只作用在水平方向。
					   这里曾经给 vy 也乘了同一份阻尼 —— 重力 + 线性阻尼 = 终端速度，
					   而且在这个尺度上几百毫秒就饱和了，于是"被扔出去之后"看起来是
					   **匀速平移下落**，而不是越落越快。竖直方向必须让它一路加速。 */
					ph.vy = Math.min(MAX_VY, ph.vy + GRAVITY * dt);
					ph.vx *= Math.pow(AIR_FRICTION, dt);
					ph.x += ph.vx * dt;
					ph.y += ph.vy * dt;

					let bounced = 0;
					if (ph.x <= minX) { ph.x = minX; ph.vx = Math.abs(ph.vx) * WALL_BOUNCE; }
					else if (ph.x >= maxX) { ph.x = maxX; ph.vx = -Math.abs(ph.vx) * WALL_BOUNCE; }

					if (ph.y >= floorY) {
						const impact = Math.abs(ph.vy);
						ph.y = floorY;
						ph.vy = -impact * BOUNCE;
						if (impact < REST_SPEED * 4) { ph.vy = 0; }
						ph.vx *= 0.86;
						bounced = impact;
					}
					if (ph.y < 0) { ph.y = 0; ph.vy = Math.abs(ph.vy) * 0.4; }

					setPos({ x: ph.x, y: ph.y });
					posRef.current = { x: ph.x, y: ph.y };

					const speed = Math.sqrt(ph.vx * ph.vx + ph.vy * ph.vy);
					const onFloor = ph.y >= floorY - 0.5;
					if (!ph.landed && onFloor && Math.abs(ph.vy) <= REST_SPEED * 4) {
						ph.landed = true;
						setFlying(false);
						if (bounced >= LAND_SHAKE_SPEED) {
							setDust((n) => n + 1);
							playAction("shake");
						}
						say(pick(LAND_LINES, ph.x + ph.y), 1200);
						persist({ x: ph.x, y: ph.y });
					}
					if (speed < REST_SPEED && onFloor) {
						physRef.current = null;
						setFlying(false);
						persist({ x: ph.x, y: ph.y });
						return;
					}
					ph.raf = (typeof requestAnimationFrame === "function")
						? requestAnimationFrame(step)
						: setTimeout(step, 16);
				};
				ph.raf = (typeof requestAnimationFrame === "function")
					? requestAnimationFrame(step)
					: setTimeout(step, 16);
			}

			/* ---- 自主小动作 ----
			   抽小动作用"洗牌袋"：8 个动作全部出现过一轮之后才可能重复。
			   直接 random 很容易连着抽到同一个（比如三次歪头），
			   用户就会觉得"来来回回就那么两下"。 */
			function nextIdleAction() {
				let bag = idleRef.current.bag;
				if (!bag || !bag.length) {
					bag = IDLE_ACTIONS.slice();
					for (let i = bag.length - 1; i > 0; i--) {
						const j = Math.floor(Math.random() * (i + 1));
						const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
					}
					idleRef.current.bag = bag;
				}
				return bag.pop() || null;
			}

			function playAction(id) {
				/* 显式指定动作（吓一跳的 shake、醒来的 stretch…）优先；
				   没指定就从未抽完的袋子里拿一个 */
				let a = id ? IDLE_ACTIONS.find((x) => x.id === id) : null;
				if (!a) a = nextIdleAction();
				if (!a) return;
				const el = actRef.current;
				if (!el || typeof el.animate !== "function") return;
				stopWalk();   // 踏步和小动作都在 .dshPetAct 上，同时跑会互相打架
				/* 已有的动作动画先取消，避免叠加 */
				if (idleRef.current.cur && idleRef.current.cur.cancel) {
					try { idleRef.current.cur.cancel(); } catch (err) { /* 忽略 */ }
				}
				let anim = null;
				try {
					anim = el.animate(a.kf, { duration: a.ms, easing: "ease-in-out" });
				} catch (err) {
					anim = null;
				}
				idleRef.current.cur = anim;
				setAction({ id: a.id, label: a.label, expr: a.expr || null, key: Date.now() });
				if (a.line) say(a.line, 1600);
			}

			/* ---- 走路 ----
			   游走的位移是 CSS 过渡（left/top），本身没有任何"动作"，看起来就是平移。
			   所以要在 .dshPetAct 上叠一层循环的踏步：抬脚 + 朝行进方向微倾。 */
			function walkKeyframes(dir) {
				const tilt = WALK_TILT_DEG * (dir >= 0 ? 1 : -1);
				return [
					{ transform: "translateY(0px) rotate(" + (-tilt) + "deg)", offset: 0 },
					{ transform: "translateY(-" + WALK_BOB_PX + "px) rotate(0deg)", offset: 0.25 },
					{ transform: "translateY(0px) rotate(" + tilt + "deg)", offset: 0.5 },
					{ transform: "translateY(-" + WALK_BOB_PX + "px) rotate(0deg)", offset: 0.75 },
					{ transform: "translateY(0px) rotate(" + (-tilt) + "deg)", offset: 1 },
				];
			}

			function stopWalk() {
				if (walkRef.current && walkRef.current.cancel) {
					try { walkRef.current.cancel(); } catch (err) { /* 忽略 */ }
				}
				walkRef.current = null;
			}

			/** 游走期间持续踏步，大约 ms 毫秒后自己停；dir < 0 表示往左走 */
			function startWalk(ms, dir) {
				const el = actRef.current;
				if (!el || typeof el.animate !== "function") return;
				stopWalk();
				if (idleRef.current.cur && idleRef.current.cur.cancel) {
					try { idleRef.current.cur.cancel(); } catch (err) { /* 忽略 */ }
					idleRef.current.cur = null;
				}
				/* 踏步周期固定，用 iterations 凑够整段路程，不要拉长周期（会看起来像慢动作） */
				const laps = Math.max(1, Math.round(ms / WALK_STEP_MS));
				try {
					walkRef.current = el.animate(walkKeyframes(dir), {
						duration: WALK_STEP_MS,
						iterations: laps,
						easing: "ease-in-out",
					});
				} catch (err) {
					walkRef.current = null;
				}
			}

			/* 预加载全部素材 */
			react.useEffect(() => {
				let alive = true;
				let pending = EXPRESSIONS.length;
				if (pending === 0) return undefined;
				EXPRESSIONS.forEach((e) => {
					const im = new Image();
					im.onload = im.onerror = () => {
						pending -= 1;
						if (alive && pending === 0) setLoaded(true);
					};
					im.src = spriteUrl(e.id);
				});
				return () => { alive = false; };
			}, []);

			/* 预加载拖拽差分 */
			react.useEffect(() => {
				const im = new Image();
				im.onload = () => setDragReady(true);
				im.src = spriteUrl(DRAG_SPRITE);
				return () => { im.onload = null; };
			}, []);

			/* 定时驱动重渲染（让"已经跑了 N 秒"这类文字动起来） */
			react.useEffect(() => {
				const step = DEMO_MODE ? Math.max(400, Math.round(DEMO_MS / 2)) : 1200;
				const t = setInterval(() => setTick((n) => n + 1), step);
				return () => clearInterval(t);
			}, []);

			/* 手动表情过一会儿交还给自动驱动 */
			react.useEffect(() => {
				if (!manual) return undefined;
				const t = setTimeout(() => setManual(null), MANUAL_HOLD_MS);
				return () => clearTimeout(t);
			}, [manual]);

			/* 注入样式（幂等） */
			react.useEffect(() => {
				if (typeof document === "undefined" || !document.head) return undefined;
				let el = document.getElementById(CSS_ID);
				let created = false;
				if (!el) {
					el = document.createElement("style");
					el.id = CSS_ID;
					el.textContent = CSS_TEXT;
					document.head.appendChild(el);
					created = true;
				}
				return () => {
					if (created && el && el.parentNode) el.parentNode.removeChild(el);
				};
			}, []);

			/* 卸载清理：物理循环 + 指针监听状态 */
			react.useEffect(() => {
				mountedRef.current = true;
				return () => {
					mountedRef.current = false;
					const ph = physRef.current;
					if (ph && ph.raf && typeof cancelAnimationFrame === "function") {
						cancelAnimationFrame(ph.raf);
					}
					physRef.current = null;
				};
			}, []);

			/* 气泡自动消失 */
			react.useEffect(() => {
				if (!bubble) return undefined;
				const t = setTimeout(() => setBubble(null), bubble.ms || BUBBLE_MS);
				return () => clearTimeout(t);
			}, [bubble]);

			/* 仪表提示自动消失 */
			react.useEffect(() => {
				if (!meterNote) return undefined;
				const t = setTimeout(() => setMeterNote(null), meterNote.ms || NOTE_MS);
				return () => clearTimeout(t);
			}, [meterNote]);

			/* 生气状态到时解除 */
			react.useEffect(() => {
				if (!angry) return undefined;
				const t = setTimeout(() => setAngry(0), ANGRY_HOLD_MS);
				return () => clearTimeout(t);
			}, [angry]);

			/* 动作状态到时清掉（表情覆盖随之解除） */
			react.useEffect(() => {
				if (!action) return undefined;
				const a = IDLE_ACTIONS.find((x) => x.id === action.id);
				const t = setTimeout(() => setAction(null), (a && a.ms ? a.ms : 1200) + 60);
				return () => clearTimeout(t);
			}, [action]);

			/* 自主行为调度：小动作 + 游走 + 睡觉 */
			react.useEffect(() => {
				if (DEMO_MODE) return undefined;
				let alive = true;
				idleRef.current.next = Date.now() + IDLE_FIRST_MS;

				const loop = setInterval(() => {
					if (!alive) return;
					const now = Date.now();
					if (dragRef.current || physRef.current) return;     // 拖着 / 飞着时别乱动
					const idleFor = now - interactRef.current;

					/* 睡觉：久无交互 且 AI 也没在干活。
					   ⚠️ 必须是"打盹循环"而不是一睡不醒 —— 睡着的分支会 return，
					   如果没人来叫醒就永远躺着，游走和所有小动作再也出不来。 */
					const sr = sleepRef.current;
					if (asleepRef.current) {
						if (now < sr.napUntil) return;     // 还没睡够
						/* 到点自己醒：先活动一阵，过 SLEEP_AWAKE_MS 才允许再睡 */
						asleepRef.current = false;
						sr.canSleepAt = now + SLEEP_AWAKE_MS;
						setAsleep(false);
						say(pick(WAKE_LINES, now), 1500);
						playAction("stretch");             // 醒来伸个懒腰
						return;
					}

					/* 睡觉只看"多久没被摸过"。曾经这里还要看 AI 在不在干活 ——
					   那是把脸借给仪表的副作用：宠物不需要知道你在忙。 */
					if (idleFor >= SLEEP_AFTER_MS && now >= sr.canSleepAt) {
						asleepRef.current = true;
						sr.napUntil = now + SLEEP_NAP_MIN_MS
							+ Math.random() * (SLEEP_NAP_MAX_MS - SLEEP_NAP_MIN_MS);
						/* 正在跑的小动作要收掉：打哈欠 / 揉眼睛的表情（sleepy）排在
						   睡脸前面，不收就会"睡着了还睁着眼打哈欠" */
						setAction(null);
						if (idleRef.current.cur && idleRef.current.cur.cancel) {
							try { idleRef.current.cur.cancel(); } catch (err) { /* 忽略 */ }
							idleRef.current.cur = null;
						}
						setAsleep(true);
						setNear("");
						stopWalk();      // 睡着了就别踏步了
						setMoving(false);
						say(pick(BORED_LINES, now), 1600);
						return;
					}

					/* 游走：更久没交互时，缓缓挪一小段 */
					const wr = wanderRef.current;
					if (idleFor >= WANDER_AFTER_MS && now - wr.last >= WANDER_GAP_MS) {
						wr.last = now;
						wander();
						return;
					}

					/* 小动作：随机间隔来一个 */
					if (now >= idleRef.current.next && !actionRef.current) {
						idleRef.current.next = now + IDLE_GAP_MIN
							+ Math.random() * (IDLE_GAP_MAX - IDLE_GAP_MIN);
						playAction(null);
					}
				}, 1500);

				return () => { alive = false; clearInterval(loop); };
			}, []);

			/* 鼠标感知：靠近抬头 / 快速划过吓一跳 / 走远目送 */
			react.useEffect(() => {
				if (typeof window === "undefined" || !window.addEventListener) return undefined;
				let alive = true;
				ptrRef.current = { x: 0, y: 0, t: 0, near: false, startled: 0, leaveAt: 0, nStartle: 0 };

				const onMove = (ev) => {
					if (!alive) return;
					const p = ptrRef.current;
					if (!p) return;
					const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
					const dx0 = ev.clientX - p.x;
					const dy0 = ev.clientY - p.y;
					const dt = Math.max(1, now - p.t);
					const dist = Math.sqrt(dx0 * dx0 + dy0 * dy0);
					const speed = p.t ? (dist / dt) : 0;
					p.x = ev.clientX; p.y = ev.clientY; p.t = now;

					const g = geomRef.current;
					if (!g.w) return;
					const cx = g.x + g.w * 0.5;
					const cy = g.y + g.h * 0.5;
					const dd = Math.sqrt(
						(ev.clientX - cx) * (ev.clientX - cx) +
						(ev.clientY - cy) * (ev.clientY - cy)
					);

					/* 吓一跳：快速掠过附近 */
					if (speed > STARTLE_SPEED && dd < STARTLE_RADIUS
						&& now - p.startled > STARTLE_COOLDOWN_MS) {
						p.startled = now;
						interactRef.current = now;
						setAsleep(false);
						setManual("surprised");
						playAction("shake");
						/* 第一次被吓必然是 STARTLE_LINES[0]（就是那个"！"），之后才换花样 */
						const nSt = p.nStartle || 0;
						p.nStartle = nSt + 1;
						say(STARTLE_LINES[nSt % STARTLE_LINES.length], 900);
						setTick((n) => n + 1);
						return;
					}

					if (dd < NEAR_RADIUS) {
						if (!p.near) {
							p.near = true;
							interactRef.current = now;
							setAsleep(false);
							setNear("near");
							/* 必须出声。之前靠近只换个表情 + 改标签文案，
							   而表情又被 AI 的演出压住，用户完全看不出有反应。 */
							say(pick(NEAR_LINES, now), 1500);
							setTick((n) => n + 1);
						}
					} else if (dd > FAR_RADIUS) {
						if (p.near) {
							p.near = false;
							setNear("away");
							say(pick(AWAY_LINES, now), 1500);
							setTick((n) => n + 1);
						}
					}
				};

				window.addEventListener("pointermove", onMove, { passive: true });
				return () => {
					alive = false;
					window.removeEventListener("pointermove", onMove);
				};
			}, []);

			/* 窗口尺寸变了（缩小窗口 / 取消最大化 / 改缩放）就把桌宠拉回可见范围。
			   位置是按像素存的，窗口一变小，原坐标可能整只在视口外 —— 看不见也点不到。 */
			react.useEffect(() => {
				if (typeof window === "undefined" || !window.addEventListener) return undefined;
				function onResize() {
					const box = petBox();
					const cur = posRef.current || pos;
					const np = clampToView(cur, box.w, box.h);
					if (np.x === cur.x && np.y === cur.y) return;
					posRef.current = np;
					setPos(np);
					persist(np);
				}
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);

			/* near/away 只是短时状态，到点自动收回 */
			react.useEffect(() => {
				if (!near) return undefined;
				const ms = near === "near" ? NEAR_HOLD_MS : WATCH_AWAY_MS;
				const t = setTimeout(() => setNear(""), ms);
				return () => clearTimeout(t);
			}, [near]);

			/* 游走：把位置缓慢挪一小段（用 CSS 过渡，不是逐帧） */
			function wander() {
				const w = (typeof window !== "undefined" && window.innerWidth) || 1280;
				const h = (typeof window !== "undefined" && window.innerHeight) || 900;
				const g = geomRef.current;
				const bw = g.w || 200;
				const bh = g.h || 260;
				const maxX = Math.max(0, w - bw);
				const dx = (Math.random() * 2 - 1) * WANDER_X;
				const dy = (Math.random() * 2 - 1) * WANDER_Y;
				const nx = Math.max(0, Math.min(maxX, posRef.current.x + dx));
				const ny = Math.max(0, Math.min(Math.max(0, h - bh), posRef.current.y + dy));
				setMoving(true);
				startWalk(WANDER_STEP_MS, nx - posRef.current.x);
				setPos({ x: nx, y: ny });
				posRef.current = { x: nx, y: ny };
				setTimeout(() => {
					if (!mountedRef.current) return;
					setMoving(false);
					stopWalk();
					persist({ x: nx, y: ny });
				}, WANDER_STEP_MS + 80);
			}

			/* ---- 渲染期计算（纯函数，绝不能在这里调 hook） ---- */
			const demoExpr = (DEMO_MODE && tick >= 0)
				? (BY_ID[EXPRESSIONS[Math.floor(tick / 2) % EXPRESSIONS.length].id] || null)
				: null;
			const actionExpr = (action && action.expr && BY_ID[action.expr]) || null;
			const angryExpr = angry ? BY_ID.angry : null;
			const nearExpr = (near && !manual && !angry) ? (BY_ID.calling || null) : null;
			const sleepExpr = (asleep && !manual && !angry) ? BY_ID.sleeping : null;

			/* ------------------------------------------------------------------ *
			 * 忙 / 闲 分时复用：决定"静息时这张脸归谁"
			 *
			 * 关键全在两个 delay 上。AI 是**间歇性**忙的 —— 调一次工具、想两秒、
			 * 再调一次。没有迟滞的话脸会在"她"和"仪表"之间来回跳，比原来的节拍器
			 * 还难看。所以：连续忙满 FACE_BUSY_DELAY_MS 才交出去，闲满
			 * FACE_REST_DELAY_MS 才收回来。
			 *
			 * 注意 since 只在 want **翻转**时重置，不是每次 intent 变化都重置 ——
			 * 否则 tool → thinking → tool 这种连续忙会被反复清零、永远切不过去。
			 * ------------------------------------------------------------------ */
			const aiIntent = (info && info.intent) || "idle";
			const aiError = !!(info && info.error);
			const aiState = aiError ? "error" : (AI_STATE_COLOR[aiIntent] ? aiIntent : "idle");
			const faceRefCur = faceRef.current;
			const aiWant = aiState === "tool" || aiState === "thinking" || aiState === "error";
			if (aiWant !== faceRefCur.want) {
				faceRefCur.want = aiWant;
				faceRefCur.since = Date.now();
			}
			/* 记下"忙的时候该露哪张脸"。松手（AI 闲下来）之后要**保持住**它，
			   直到 FACE_REST_DELAY_MS 用完 —— 直接读当前 aiState 的话，AI 一闲
			   下来 aiState 就变成 idle，脸会立刻变，迟滞等于没写。 */
			if (aiWant) faceRefCur.face = AI_FACE[aiState];
			const faceHeld = Date.now() - faceRefCur.since;
			if (aiWant && !faceRefCur.busy && faceHeld >= FACE_BUSY_DELAY_MS) faceRefCur.busy = true;
			else if (!aiWant && faceRefCur.busy && faceHeld >= FACE_REST_DELAY_MS) faceRefCur.busy = false;
			const faceBusy = faceRefCur.busy;
			const aiFace = faceBusy ? (BY_ID[faceRefCur.face] || null) : null;

			/* ------------------------------------------------------------------ *
			 * 这张脸只归宠物 —— 决策链里**没有**任何一个申请者来自 AI。
			 *
			 * 顺序：手动/演示 > 连点生气 > 小动作自带表情 > 鼠标靠近/目送
			 *       > 睡觉 > 静息脸。
			 *
			 * 前六个申请者全是**宠物自己**，它们在两种模式下都优先 —— 那是"你在跟
			 * 它说话"，什么时候都该打断。最后那个"静息脸"才是分时复用的位置：
			 * 忙的时候由 AI 状态填（aiFace），闲的时候就是 REST_FACE。
			 *
			 * 这里曾经是一条九人抢一个槽位的链（AI 的内容表情占了其中两格），
			 * 结果是：谁抢到别人就**一个字都不说**，而"安静"和"坏掉"长得一模一样 ——
			 * 睡不了觉、凑近没反应、见不到揉眼睛，全都是同一件事故的不同现场。
			 * 教训不是"AI 不能上脸"，而是**不能让两边同时抢**。
			 *
			 * ⚠️ 加新功能时先问一句：它属于"宠物自己"、"AI 的静息脸"，还是
			 * "AI 的仪表"？第一种往这条链的上半段加，第二种改 AI_FACE，第三种去
			 * .dshPetMeter —— 别在链中间插。
			 * ------------------------------------------------------------------ */
			const expr = (manual && BY_ID[manual])
				|| angryExpr
				|| actionExpr
				|| demoExpr
				|| nearExpr
				|| sleepExpr
				|| aiFace
				|| BY_ID[REST_FACE]
				|| BY_ID.calm;

			/* 把"最新值"同步给定时器/事件监听用的镜像（见上面的 refs 说明） */
			asleepRef.current = asleep;
			actionRef.current = action;

			/* 切换表情时"弹一下" —— 用 WAAPI 走内层 <img>：
			   呼吸占着 root 的 transform、动作占着 act 层，img 是第三条独立通道。
			   ⚠️ 必须放在 `const expr` 之后：依赖数组在渲染时立即求值，
			   写在前面会撞上 TDZ（Cannot access 'expr' before initialization）。 */
			react.useEffect(() => {
				const el = imgRef.current;
				if (!el || typeof el.animate !== "function") return;
				if (!firstPopDone.current) { firstPopDone.current = true; return; }
				try {
					el.animate(
						[
							{ transform: "scale(0.92)" },
							{ transform: "scale(1.04)", offset: 0.55 },
							{ transform: "scale(1)" }
						],
						{ duration: 220, easing: "ease-out" }
					);
				} catch (err) { /* 动效失败不影响功能 */ }
			}, [expr.id]);

			const boxH = vhToPx(HEIGHT_VH);
			const boxW = Math.round(boxH * (SPRITE_W / SPRITE_H));
			const showDrag = (dragging || flying) && dragReady;

			/* 语义状态：只讲"宠物自己在干什么"。
			   唯一一处提到 AI 的是最后一个分支 —— 因为那时候这张脸**确实**是在
			   替 AI 露面，不写出来的话就成了"脸换了意思但没告诉你"，又回到
			   "安静和坏掉长得一模一样"那个老毛病。 */
			let source = DEMO_MODE ? "演示"
				: (manual ? "手动"
					: (angry ? "生气"
						: (action ? action.label
							: (asleep ? "睡着了"
								: (near === "near" ? "看你"
									: (near === "away" ? "目送"
										: (faceBusy ? (aiState === "error" ? "AI 出错了" : "AI 在忙")
											: "待机")))))));

			/* 标签只讲宠物。AI 的进度 / 上下文 / 耗时一行都不进来 ——
			   它们全部搬到下面的仪表，这是"脸只归宠物"的另一半。 */
			const tagText = dragging ? "抓狂 · 拖拽中"
				: (flying ? "被扔出去了"
					: (expr.label + " · " + source));

			/* 气泡的花样按"这句话是什么情绪"分三套配色。
			   做成 data-dsh-pet-bubble 而不是只体现在颜色上 ——
			   颜色测不了，"这次是哪种气泡"能测。 */
			const bubbleKind = !bubble ? ""
				: ((expr.id === "angry" || expr.id === "surprised" || flying) ? "shout"
					: ((expr.id === "sleepy" || expr.id === "sleeping" || expr.id === "shy" || asleep) ? "soft"
						: "say"));
			const bubbleClass = "dshPetBubble"
				+ (bubbleKind === "shout" ? " dshPetBubbleShout" : "")
				+ (bubbleKind === "soft" ? " dshPetBubbleSoft" : "");

			/* ------------------------------------------------------------------ *
			 * AI 状态仪表 —— 独立于表情的一条指示
			 *
			 * 它回答"AI 现在在干什么"，用三种通道表达：
			 *   圆点：状态与节奏（蓝=跑工具，紫=思考，黄=磨很久，红=出错）
			 *   细条：上下文占用（唯一一个"程度"量，长度天然合适）
			 *   小字：只在真有事时说一句（进度 / 耗时），闲着时完全不出声
			 *
			 * 它同时承担一个职责：**告诉用户"现在脸归谁"**。圆点在闪 = 忙模式
			 * （她正在替 AI 露面），圆点静止 = 闲模式（她只是她自己）。
			 * ------------------------------------------------------------------ */
			const taskSec = (info && info.taskSince) ? Math.max(0, Math.round((Date.now() - info.taskSince) / 1000)) : 0;
			const pctPct = info ? Math.round((info.pct || 0) * 100) : 0;
			const todos = info && info.todos;
			const usedTok = info ? (info.used || 0) : 0;
			const limitTok = info ? (info.limit || 0) : 0;

			const aiColor = AI_STATE_COLOR[aiState];
			const aiPulse = AI_STATE_PULSE[aiState] || "";
			const pressure = pctPct >= PCT_HOT * 100;
			const barColor = pctPct >= PCT_HOT * 100 ? "#ff7a7a"
				: (pctPct >= PCT_WARN * 100 ? "#ffd479" : "#6fc9ff");

			/* 仪表上那行小字：只在"确实有事"时出现，免得变成常驻噪音 */
			const meterBits = [];
			if (aiError) meterBits.push("出错");
			else if (INTENT_LABEL[aiIntent]) meterBits.push(INTENT_LABEL[aiIntent]);
			if (todos && todos.total > 0) meterBits.push(todos.done + "/" + todos.total);
			if (taskSec >= BUSY_NOTE_FIRST_SEC) meterBits.push(taskSec + "s");
			const meterText = meterBits.join(" · ");
			const meterTitle = "AI 状态：" + (meterText || "空闲")
				+ (limitTok > 0 ? "；上下文 " + pctPct + "%（" + usedTok + " / " + limitTok + "）" : "");

			/* ---- 仪表提示：走 note 通道，**不占用宠物气泡** ----
			   这些提醒从前是用宠物自己的气泡说出来的，于是"她在说话"和
			   "系统在报数"挤在同一条通道里，用户根本分不清是谁在讲。 */
			react.useEffect(() => {
				if (!info || DEMO_MODE) return undefined;
				if (dragging || flying) return undefined;
				const t = setTimeout(() => {
					if (dragRef.current || physRef.current) return;
					/* 出错和上下文爆掉最要紧，可以打断别的提示 */
					if (info.error) {
						if (Date.now() - errNoteRef.current < ERROR_NOTE_GAP_MS) return;
						errNoteRef.current = Date.now();
						note("出错了", NOTE_MS);
						return;
					}
					if (info.pct >= PCT_SPACE_ALERT) {
						if (Date.now() - spaceNoteRef.current < SPACE_NOTE_GAP_MS) return;
						spaceNoteRef.current = Date.now();
						note("上下文 " + Math.round(info.pct * 100) + "% 快满了", 3200);
						return;
					}
					/* 其余是常规播报：刚提示过就让一让，不然 info 一变就换一句 */
					if (notedRecently(NOTE_QUIET_MS)) return;
					if (info.intent === "tool") {
						const line = TOOL_LINES[info.tool];
						if (line) { note(line, 2200); return; }
					}
					if (todos && todos.total > 0 && todos.done < todos.total && info.intent === "tool") {
						note("进度 " + todos.done + "/" + todos.total, 2200);
					}
				}, 260);
				return () => clearTimeout(t);
			}, [info, dragging, flying]);

			/* 长任务每 15 秒报一次进度（走 note，不走气泡）。
			   这里必须用"距上次提醒过了多久"而不是 `taskSec % 15 === 0` ——
			   taskSec 是渲染时按秒取整算出来的，1200ms 的 tick 一路上会直接跨过
			   恰好等于 15/30/45 的那一帧，条件几乎永远不成立。 */
			react.useEffect(() => {
				if (!taskSec) { busyNoteRef.current = 0; return undefined; }
				if (taskSec < BUSY_NOTE_FIRST_SEC || DEMO_MODE) return undefined;
				const last = busyNoteRef.current;
				if (last > 0 && taskSec - last < BUSY_NOTE_GAP_SEC) return undefined;
				busyNoteRef.current = taskSec;
				note("还在跑 · " + taskSec + "s", 2000);
				return undefined;
			}, [taskSec]);

			/* 几何信息供指针判定与物理使用 */
			geomRef.current = { x: pos.x, y: pos.y, w: boxW, h: boxH };
			posRef.current = pos;

			/* ---- 样式合成 ---- */
			const root = Object.assign({}, rootStyle, {
				left: pos.x + "px",
				top: pos.y + "px",
				width: boxW + "px",
				height: boxH + "px",
				cursor: dragging ? "grabbing" : "grab",
				touchAction: "none",
				/* 游走时给 left/top 加过渡 → 缓慢漂移而不是瞬移；
				   拖拽/物理时必须瞬时，否则会"拖不动" */
				transition: (moving && !dragging && !flying)
					? ("left " + WANDER_STEP_MS + "ms ease-in-out, top " + WANDER_STEP_MS + "ms ease-in-out")
					: "none",
				/* 睡着时覆盖呼吸动画（内联优先于 class 规则） */
				animation: asleep
					? ("dshPetBreathSleep " + SLEEP_BREATH_SEC + "s ease-in-out infinite")
					: undefined
			});
			const img = Object.assign({}, imgStyle, {
				width: "100%",
				height: "100%",
				opacity: loaded ? (showDrag ? 0 : 1) : 0
			});
			const stage = Object.assign({}, stageStyle, {
				transform: dragging ? "scale(" + DRAG_LIFT + ")" : "scale(1)"
			});
			const act = actStyle;
			const dragImg = Object.assign({}, dragImgStyle, {
				width: "100%",
				height: "100%",
				opacity: showDrag ? 1 : 0
			});
			/* 标签只讲宠物；"上下文压力"这件事归仪表条，所以高亮也从标签挪过去了 */
			const tagClass = "dshPetTag";
			const tag = tagStyle;
			const meterClass = "dshPetMeter" + (pressure ? " dshPetPressure" : "");
			const meter = meterStyle;
			const dot = Object.assign({}, dotStyle, {
				background: aiColor,
				color: aiColor,
				animation: aiPulse
					? ("dshPetPulse " + aiPulse + " ease-in-out infinite")
					: "none"
			});
			const barFill = Object.assign({}, barFillStyle, {
				width: pctPct + "%",
				background: barColor
			});

			const children = [
				react.createElement(
					"div",
					{ className: "dshPetStage", style: stage, key: "stage" },
					react.createElement(
						"div",
						{ className: "dshPetAct", style: act, ref: actRef, key: "act" },
						react.createElement("img", {
							/* 不加 key：key 一换 React 就要重建 <img>，
							   弹跳动画会打在旧节点上、切换也会闪一下 */
							ref: imgRef,
							className: "dshPetImg",
							src: spriteUrl(expr.id),
							alt: "",
							draggable: false,
							style: img
						}),
						react.createElement("img", {
							key: "drag",
							className: "dshPetDrag",
							src: spriteUrl(DRAG_SPRITE),
							alt: "",
							draggable: false,
							style: dragImg
						})
					),
					asleep ? react.createElement("span", {
						className: "dshPetZzz",
						key: "zzz1",
						style: { animationDelay: "0s" }
					}, "z") : null,
					asleep ? react.createElement("span", {
						className: "dshPetZzz",
						key: "zzz2",
						style: { animationDelay: "1.05s", fontSize: "18px", right: "6%", top: "8%" }
					}, "Z") : null,
					asleep ? react.createElement("span", {
						className: "dshPetZzz",
						key: "zzz3",
						style: { animationDelay: "2.1s", fontSize: "12px", right: "18%", top: "22%" }
					}, "z") : null,
					dust ? react.createElement("span", {
						className: "dshPetDust",
						key: "dust-" + dust
					}) : null
				),
				bubble ? react.createElement("div", {
					className: bubbleClass,
					"data-dsh-pet-bubble": bubbleKind,
					key: "bubble-" + bubble.key,
					style: bubbleStyle
				}, bubble.text) : null,
				react.createElement("div", {
					className: tagClass,
					style: tag,
					key: "tag"
				}, [
					react.createElement("span", { key: "txt" }, tagText),
					/* ↻ 收进药丸里，省掉原来挂在下方、会和仪表抢位置的那个圆按钮 */
					react.createElement("span", {
						className: "dshPetTagGo",
						key: "go",
						title: "点击换个表情",
						onClick: (ev) => {
							ev.stopPropagation();
							touch();
							const cur = manual ? EXPRESSIONS.findIndex((e) => e.id === manual) : -1;
							const next = EXPRESSIONS[(cur + 1) % EXPRESSIONS.length];
							setManual(next.id);
							setTick((n) => n + 1);
						}
					}, "↻")
				]),
				/* ---- AI 状态仪表：独立的一条，与脸无关 ---- */
				react.createElement("div", {
					className: meterClass,
					style: meter,
					title: meterTitle,
					key: "meter",
					"data-dsh-pet-ai": aiState,
					/* 仪表不是拖拽把手：按在它上面不该把宠物拖走 */
					onPointerDown: (ev) => ev.stopPropagation()
				}, [
					react.createElement("span", { className: "dshPetDot", style: dot, key: "dot" }),
					react.createElement("span", { className: "dshPetBar", style: barStyle, key: "bar" },
						react.createElement("i", { className: "dshPetBarFill", style: barFill })),
					meterText
						? react.createElement("span", { className: "dshPetMeterText", style: meterTextStyle, key: "t" }, meterText)
						: null
				]),
				/* ---- 仪表提示：系统在报数，不是宠物在说话 ---- */
				meterNote ? react.createElement("div", {
					className: "dshPetNote",
					style: noteStyle,
					key: "note-" + meterNote.key
				}, meterNote.text) : null
			];

			return react.createElement(
				"div",
				{
					className: "dshPetRoot",
					style: root,
					"data-dsh-pet": dragging ? DRAG_SPRITE : expr.id,
					/* 现在这张脸归谁："ai" = 她正在替 AI 露面，"pet" = 她只是她自己。
					   做成可读的状态而不是只体现在表情上 —— 不然又是"脸换了意思但没人
					   告诉你"，那个"安静和坏掉长得一样"的老毛病。 */
					"data-dsh-pet-face": faceBusy ? "ai" : "pet",
					title: "按住拖动可移动；单击换表情",
					onPointerDown: onPointerDown,
					onPointerMove: onPointerMove,
					onPointerUp: onPointerUp,
					onPointerCancel: onPointerUp
				},
				...children
			);
		}

		/* ------------------------------------------------------------------ *
		 * 崩溃诊断
		 * ------------------------------------------------------------------ */
		const reported = {};

		function reportError(where, err) {
			const key = where + "|" + String((err && err.message) || err);
			if (reported[key]) return;
			reported[key] = true;
			try {
				const detail = {
					where: where,
					name: String((err && err.name) || "Error"),
					message: String((err && err.message) || err),
					stack: String((err && err.stack) || "").slice(0, 1500),
					probe: {
						innerW: (typeof window !== "undefined" && window.innerWidth) || null,
						innerH: (typeof window !== "undefined" && window.innerHeight) || null,
						dpr: (typeof window !== "undefined" && window.devicePixelRatio) || null
					}
				};
				if (typeof fetch === "function") {
					fetch("/dsh-pet/__diag?data=" + encodeURIComponent(JSON.stringify(detail)), {
						cache: "no-store"
					}).catch(function () { /* 上报失败就算了 */ });
				}
			} catch (e) { /* 同上 */ }
		}

		const errCardStyle = {
			position: "absolute",
			top: "0px",
			right: "0px",
			maxWidth: "320px",
			padding: "8px 10px",
			borderRadius: "8px",
			background: "rgba(120, 20, 30, 0.92)",
			color: "#fff",
			fontSize: "11px",
			lineHeight: "1.5",
			whiteSpace: "pre-wrap",
			pointerEvents: "none",
			zIndex: 60
		};

		class PetBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { err: null };
			}
			static getDerivedStateFromError(err) {
				return { err: err };
			}
			componentDidCatch(err) {
				reportError("render", err);
			}
			render() {
				if (this.state.err) {
					return react.createElement(
						"div",
						{ className: "dshPetErrCard", style: errCardStyle },
						"dsh-pet 渲染失败:\n" + String((this.state.err && this.state.err.message) || this.state.err)
					);
				}
				return this.props.children;
			}
		}

		function PetGuarded(props) {
			try {
				return react.createElement(
					PetBoundary,
					null,
					react.createElement(Pet, props)
				);
			} catch (err) {
				reportError("outer", err);
				return react.createElement(
					"div",
					{ className: "dshPetErrCard", style: errCardStyle },
					"dsh-pet 装载失败:\n" + String((err && err.message) || err)
				);
			}
		}

		/* ------------------------------------------------------------------ *
		 * 插件入口
		 * ------------------------------------------------------------------ */
		const name = "dsh-pet";
		const inject = ["slots"];

		let registered = false;

		function apply(ctx) {
			if (registered) return;      // 幂等
			registered = true;
			try {
				ctx.slots.inject("shell.overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: "dsh-pet",
					order: 100,
					label: () => "dsh-pet"
				}, PetGuarded));
			} catch (err) {
				reportError("register", err);
			}
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
