#!/usr/bin/env node
/* 变异测试：把每一处修复逐个还原，确认对应测试真的会红。
   恒真的测试等于没写 —— 这个脚本用来证明它们不是。

   覆盖两半：client.js（表情链 / 感知 / 位置）与 lib/index.js（宿主数据联动）。
   其中 M10 / M14 / M15 守的是那次大分离的不变量：
   **脸只归宠物，AI 状态一律走 .dshPetMeter / .dshPetNote。**
   M17~M20 守的是之后"分时复用"的不变量：**闲时脸归宠物且不按节拍器换脸，
   忙时脸才交给 AI，并且要等够驻留时间；宠物自己的状态（睡觉/互动）永远优先。** */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const DIR = path.join(os.tmpdir(), 'dshpet-mutant')
fs.mkdirSync(DIR, { recursive: true })

/* 默认对仓库里这份做变异；想对"正在运行的那份插件"做，用环境变量指过去。 */
const ROOT = path.join(__dirname, '..')
const SRC = process.env.DSH_PET_CLIENT || path.join(ROOT, 'client.js')
const HOST = process.env.DSH_PET_LIB || path.join(ROOT, 'lib', 'index.js')
const TEST = path.join(__dirname, 'test_client.js')
const HOST_TEST = path.join(__dirname, 'test_host.mjs')

/* 每个变异：把某处修复还原，然后跑对应测试，确认真的会红。
   expect 是应该在输出里出现的 FAIL 前缀。 */
const MUTATIONS = [
  {
    name: 'M1 存档不夹取（还原 6.17）',
    src: SRC,
    from: 'return clampToView({ x: v.x, y: v.y }, box.w, box.h);',
    to: 'return { x: v.x, y: v.y };',
    expect: /FAIL\s+6\.17/
  },
  {
    name: 'M2 松手夹取用窗口宽度（还原 6.16 的真 bug）',
    src: SRC,
    from: 'const np = clampToView(cur, box.w, box.h);',
    to: 'const w = (typeof window !== "undefined" && window.innerWidth) || 1280;\n' +
        '\t\t\t\tconst h = (typeof window !== "undefined" && window.innerHeight) || 900;\n' +
        '\t\t\t\tconst np = { x: Math.max(-(w - MARGIN_KEEP), Math.min(cur.x, w - MARGIN_KEEP)),' +
        ' y: Math.max(0, Math.min(cur.y, h - MARGIN_KEEP)) };',
    expect: /FAIL\s+6\.16/
  },
  {
    name: 'M3 去掉 resize 监听（还原 6.18）',
    src: SRC,
    from: 'window.addEventListener("resize", onResize);',
    to: 'if (false) window.addEventListener("resize", onResize);',
    expect: /FAIL\s+6\.18/
  },
  {
    name: 'M4 宿主不产出 meter（还原 ⑧ 上下文压力未实现）',
    src: HOST,
    from: 'out.meter = tokenPressure(session, tokenMeter, out.context)',
    to: 'out.meter = null',
    expect: /FAIL\s+H4/
  },
  {
    name: 'M5 宿主不产出 todos（还原 ⑧ 长任务进度未实现）',
    src: HOST,
    from: 'out.todos = todoProgress(rawEvents)',
    to: 'out.todos = null',
    expect: /FAIL\s+H[38]/
  },
  {
    name: 'M6 taskSince 写成相对毫秒（缓存命中就会过期）',
    src: HOST,
    from: 'out.taskSince = (ev.lastCallTime > 0 && ev.lastCallTime > ev.lastResultTime) ? ev.lastCallTime : 0',
    to: 'out.taskSince = (ev.lastCallTime > 0 && ev.lastCallTime > ev.lastResultTime) ? out.sinceMs : 0',
    expect: /FAIL\s+H6/
  },
  {
    name: 'M7 报错不再判新鲜度（立绘会永久停在出错表情）',
    src: HOST,
    from: 'const ERROR_FRESH_MS = 30000',
    to: 'const ERROR_FRESH_MS = Number.MAX_SAFE_INTEGER',
    expect: /FAIL\s+H5/
  },
  {
    name: 'M8 去掉 totalTokens 的 || 0 兜底（界面上会变成「上下文 NaN%」）',
    src: HOST,
    from: 'const used = Number(m.totalTokens) || 0',
    to: 'const used = Number(m.totalTokens)',
    expect: /FAIL\s+H7/
  },
  {
    /* 还原「甩得越快越甩不出去」：把终点也取成"窗口内最早的样本"。
       旧代码就是这么写的（终点 a 和基准点 from 在样本全落在窗口内时会重合），
       两端同一个点相减 → 位移恒为 0 → 速度恒为 0 → 永远进不了物理。 */
    name: 'M9 速度终点取成窗口内最早样本（还原用户报的"甩不出去"）',
    src: SRC,
    from: 'const endX = (ev && typeof ev.clientX === "number") ? ev.clientX : newest.x;\n' +
          '\t\t\t\tconst endY = (ev && typeof ev.clientY === "number") ? ev.clientY : newest.y;',
    to: 'const endX = from.x;\n\t\t\t\tconst endY = from.y;',
    expect: /FAIL\s+6\.19/
  },
  {
    /* 还原"九个申请者抢一张脸"：让 AI 的出错状态重新挤进表情链。
       分离之前它就是这么占位的，代价是别的申请者（睡觉 / 靠近 / 小动作）被饿死。 */
    name: 'M10 AI 状态重新抢进表情链（还原"谁抢到别人就不吭声"）',
    src: SRC,
    from: '\t\t\t\t|| sleepExpr\n\t\t\t\t|| aiFace',
    to: '\t\t\t\t|| ((info && info.error) ? BY_ID.surprised : null)\n' +
        '\t\t\t\t|| sleepExpr\n\t\t\t\t|| aiFace',
    expect: /FAIL\s+6\.6 报错仍然立刻改写了表情/
  },
  {
    name: 'M11 游走不叠踏步动画（还原用户报的"像平移"）',
    src: SRC,
    from: 'startWalk(WANDER_STEP_MS, nx - posRef.current.x);',
    to: 'void 0;',
    expect: /FAIL\s+6\.22/
  },
  {
    name: 'M12 睡着后不再自己醒（还原用户报的"见不到揉眼睛、散步"）',
    src: SRC,
    from: 'if (now < sr.napUntil) return;',
    to: 'if (true) return;',
    expect: /FAIL\s+6\.23/
  },
  {
    name: 'M13 小动作退回纯随机（连抽同一个，看起来"来回就那两下"）',
    src: SRC,
    from: 'return bag.pop() || null;',
    to: 'return bag[bag.length - 1] || null;',
    expect: /FAIL\s+6\.24/
  },
  {
    /* 仪表提示塞回宠物的嘴 —— "她在说话"和"系统在报数"重新混成一条通道，
       用户就再也分不清是谁在讲。 */
    name: 'M14 仪表提示改用宠物气泡（还原"分不清谁在说话"）',
    src: SRC,
    from: 'setMeterNote({ text: String(text), key: noteAtRef.current, ms: ms || NOTE_MS });',
    to: 'setBubble({ text: String(text), key: noteAtRef.current, ms: ms || NOTE_MS });',
    expect: /FAIL\s+6\.6 仪表提醒不该借宠物的嘴/
  },
  {
    /* 数据爬回标签：AI 的上下文百分比重新挤进"这张脸"的文案。 */
    name: 'M15 上下文百分比爬回标签（还原"数据挤在同一个槽位"）',
    src: SRC,
    from: ': (expr.label + " · " + source));',
    to: ': (expr.label + " · " + source + (info && info.pct ? " · 上下文 " + Math.round(info.pct * 100) + "%" : "")));',
    expect: /FAIL\s+6\.6 上下文又爬回标签了/
  },
  {
    /* 还原用户实机报的"抛出去之后是匀速下落"：竖直方向也乘上空气阻尼。
       重力 + 线性阻尼 = 终端速度，几百毫秒就饱和。 */
    name: 'M16 竖直方向也吃空气阻尼（还原用户报的"下落是匀速的"）',
    src: SRC,
    from: '\t\t\t\t\tph.vy = Math.min(MAX_VY, ph.vy + GRAVITY * dt);\n\t\t\t\t\tph.vx *= Math.pow(AIR_FRICTION, dt);',
    to: '\t\t\t\t\tph.vy = Math.min(MAX_VY, ph.vy + GRAVITY * dt) * Math.pow(AIR_FRICTION, dt);\n\t\t\t\t\tph.vx *= Math.pow(AIR_FRICTION, dt);',
    expect: /FAIL\s+6\.25/
  },
  {
    /* 忙/闲分时复用是这一轮的方案，下面四条守它的四个不变量。
       注意它们和 M10 不是一回事：M10 还原的是"AI 瞬时抢脸"（老毛病），
       M20 还原的是"AI 排在宠物自己的申请者前面"（新结构被拆坏）。 */
    name: 'M17 忙模式没有驻留时间（脸在两个模式之间来回跳）',
    src: SRC,
    from: 'const FACE_BUSY_DELAY_MS = 1500;',
    to: 'const FACE_BUSY_DELAY_MS = 0;',
    expect: /FAIL\s+6\.27/
  },
  {
    /* 还原用户报的"生硬的每四秒钟切换一次表情"：静息脸退回按时间轮换。 */
    name: 'M18 静息脸退回定时轮换（还原用户报的"每四秒切一次表情"）',
    src: SRC,
    from: '\t\t\t\t|| BY_ID[REST_FACE]\n\t\t\t\t|| BY_ID.calm;',
    to: '\t\t\t\t|| BY_ID[["sleepy", "calm", "shy", "happy"][Math.floor(Date.now() / 2600) % 4]]\n' +
        '\t\t\t\t|| BY_ID.calm;',
    expect: /FAIL\s+6\.26/
  },
  {
    name: 'M19 收回静息脸没有驻留时间（AI 一闲下来脸立刻变）',
    src: SRC,
    from: 'const FACE_REST_DELAY_MS = 4000;',
    to: 'const FACE_REST_DELAY_MS = 0;',
    expect: /FAIL\s+6\.28/
  },
  {
    /* 把 aiFace 挪到宠物自己的申请者前面 —— 这是"分时复用"被拆回
       "同时抢"的那一步：AI 又能在宠物睡觉时占着脸。 */
    name: 'M20 AI 的脸排到宠物自己的申请者前面（睡觉又被压住）',
    src: SRC,
    from: '\t\t\t\t|| sleepExpr\n\t\t\t\t|| aiFace',
    to: '\t\t\t\t|| aiFace\n\t\t\t\t|| sleepExpr',
    expect: /FAIL\s+6\.29/
  },
  {
    /* 气泡那轮的三个不变量：有尾巴、按情绪换花样、动画收尾和静息角度一致。 */
    name: 'M21 气泡没有尾巴（还原成一块圆角板子）',
    src: SRC,
    from: '".dshPetBubble::after {",',
    to: '".dshPetBubbleTailOff {",',
    expect: /FAIL\s+6\.30 气泡没有尾巴/
  },
  {
    name: 'M22 气泡不按情绪换花样（生气也还是普通气泡）',
    src: SRC,
    from: ': ((expr.id === "angry" || expr.id === "surprised" || flying) ? "shout"',
    to: ': ((false) ? "shout"',
    expect: /FAIL\s+6\.31 生气该用大声气泡/
  },
  {
    /* 这条守的是"动画收尾必须和静息 transform 用同一个变量"：
       不一致的话气泡会先倾着出现，动画一播完"啪"地弹正。 */
    name: 'M23 动画收尾写死角度（气泡播完会弹一下）',
    src: SRC,
    from: '100% { opacity: 1; transform: translate(-50%, 0px) scale(1) rotate(var(--dshPetTilt)); }',
    to: '100% { opacity: 1; transform: translate(-50%, 0px) scale(1) rotate(-2.2deg); }',
    expect: /FAIL\s+6\.30 keyframes 的收尾/
  },
  {
    /* 点击那轮的三个不变量：生气门槛是随机的、不同部位反应不同、分区足够多。 */
    name: 'M24 生气门槛写死三次（还原"第三下必炸"）',
    src: SRC,
    from: 'return MULTI_CLICK_MIN\n\t\t\t\t\t+ Math.floor(Math.random() * (MULTI_CLICK_MAX - MULTI_CLICK_MIN + 1));',
    to: 'return 3;',
    expect: /FAIL\s+6\.32/
  },
  {
    name: 'M25 脚和头顶同款反应（还原"戳哪儿都一样"）',
    src: SRC,
    from: '{ id: "feet", expr: "happy", mx: [0.34, 0.62], my: [0.90, 1.00],',
    to: '{ id: "feet", expr: "shy", mx: [0.34, 0.62], my: [0.90, 1.00],',
    expect: /FAIL\s+6\.12/
  },
  {
    /* 这条是直接还原用户抱怨的那版：只有"头 / 身 / 裙摆"三条横切线。
       分区表还在，但判定不走它了 —— 6.33 一撒网格就露馅。 */
    name: 'M26 分区退回三条横切线（还原"只有三个分区"）',
    src: SRC,
    from: '\t\t\tfor (let i = 0; i < ZONES.length; i += 1) {\n'
      + '\t\t\t\tconst z = ZONES[i];\n'
      + '\t\t\t\tif (x >= z.mx[0] && x <= z.mx[1] && y >= z.my[0] && y <= z.my[1]) return z;\n'
      + '\t\t\t}\n'
      + '\t\t\treturn ZONE_FALLBACK;',
    to: '\t\t\treturn y < 0.44 ? ZONES[1] : (y >= 0.80 ? ZONES[11] : ZONE_FALLBACK);',
    expect: /FAIL\s+6\.33/
  },
]

/* 统一成 LF 再比对。
   踩过的坑：用 python 的 io.open(...,'w') 改过 client.js 之后，整个文件被写成 CRLF，
   而变异锚点里的换行写的是 \n —— indexOf 直接落空，所有含换行的变异体静默变成
   "跳过"。这里先归一化，脚本就不会再被行尾风格暗算。 */
function norm(s) { return String(s).replace(/\r\n/g, '\n') }

const original = norm(fs.readFileSync(SRC, 'utf8'))
const hostOriginal = norm(fs.readFileSync(HOST, 'utf8'))

let allBite = true
for (const m of MUTATIONS) {
  const base = m.src === HOST ? hostOriginal : original
  if (base.indexOf(m.from) < 0) {
    console.log('  \x1b[33m跳过\x1b[0m ' + m.name + '：源码里找不到锚点，脚本要跟着改')
    allBite = false
    continue
  }
  let out = ''
  if (m.src === SRC) {
    /* 变异体写到临时目录，再用 DSH_PET_CLIENT 把测试指过去。
       早先的写法是"把 test_client.js 里 CLIENT 那一行字符串替换掉" ——
       那等于把测试源码当模板改：测试里的路径只要动一次就静默失配，
       表现成"变异不咬"，实际是模板没命中。传环境变量就没这个耦合。 */
    const mutated = base.split(m.from).join(m.to)
    const mutant = path.join(DIR, 'client.js')
    fs.writeFileSync(mutant, mutated, 'utf8')
    out = run(process.execPath, [TEST], { DSH_PET_CLIENT: mutant })
  } else {
    /* 复制 lib/ 再改；assets/ 用 junction 挂过去（否则素材用例会因为读不到 PNG 而红） */
    const pluginRoot = path.dirname(path.dirname(HOST))
    const pkg = path.join(DIR, 'pkg')
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
    fs.cpSync(path.dirname(HOST), path.join(pkg, 'lib'), { recursive: true })
    try {
      fs.symlinkSync(path.join(pluginRoot, 'assets'), path.join(pkg, 'assets'), 'junction')
    } catch (err) {
      console.log('  \x1b[33m注意\x1b[0m assets junction 建不了，素材相关用例会红：' + err.message)
    }
    fs.writeFileSync(path.join(pkg, 'lib', 'index.js'), base.split(m.from).join(m.to), 'utf8')
    out = run(process.execPath, [HOST_TEST], {
      DSH_PET_LIB: path.join(pkg, 'lib', 'index.js')
    })
  }
  const caught = m.expect.test(out)
  if (caught) {
    const hits = (out.match(new RegExp(m.expect.source, 'g')) || []).length
    console.log('  \x1b[32m会红\x1b[0m ' + m.name + '  → ' + hits + ' 条失败')
  } else {
    console.log('  \x1b[31m不咬\x1b[0m ' + m.name + '  ← 没有测试能抓到它，等于没测')
    allBite = false
  }
}

function run(bin, argv, extraEnv) {
  let out = ''
  try {
    out = execFileSync(bin, argv, { encoding: 'utf8', env: Object.assign({}, process.env, extraEnv || {}) })
  } catch (e) {
    out = String((e.stdout || '') + (e.stderr || ''))
  }
  /* ⚠️ 必须剥掉 ANSI 颜色码：`FAIL\x1b[0m  H4` 里的转义序列会让 /FAIL\s+H4/ 匹配不上，
     表现成"变异没被抓到"，实际是断言写错了 —— 这个坑本身就值得留个注释。 */
  return out.replace(/\u001b\[[0-9;]*m/g, '')
}

fs.rmSync(DIR, { recursive: true, force: true })
console.log(allBite
  ? '\n\x1b[32m' + MUTATIONS.length + ' 个变异全部被抓到 —— 每条回归测试都是有效的。\x1b[0m\n'
  : '\n\x1b[31m有变异没被抓到，测试需要加强。\x1b[0m\n')
process.exit(allBite ? 0 : 1)
