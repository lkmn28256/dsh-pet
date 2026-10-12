/**
 * dsh-pet 离线冒烟测试
 *
 * 用一个最小的 React / ModuleLoader 替身，在 Node 里把 client.js 真正执行一遍：
 *   1. 装载工厂是否能跑通
 *   2. 导出的 name / inject / apply 形状是否正确
 *   3. apply(ctx) 是否会按 dshmarket 的写法注册到 shell.overlay
 *   4. Pet 组件渲染是否抛错（含 useSessionStatus 拿不到 / 拿到对象 / 抛错三种情形）
 *   5. 拖拽差分是否接对（按下移动 → 抓狂层淡入；原地松手 → 仍然换表情）
 *
 * 这不等于真机验证（slot 的消费方仍是宿主），但能挡掉绝大多数"重启后才发现"的低级错误。
 */
const fs = require('node:fs')
const path = require('node:path')

/* 默认测仓库里这份（本脚本在 tools/，上一级就是仓库根）。
   想改测"正在运行的那份插件"，用环境变量指过去：
     DSH_PET_CLIENT=... DSH_PET_ASSETS=... node tools/test_client.js */
const ROOT = path.join(__dirname, '..')
const CLIENT = process.env.DSH_PET_CLIENT || path.join(ROOT, 'client.js')
const ASSETS = process.env.DSH_PET_ASSETS || path.join(ROOT, 'assets')
const SOURCE = fs.readFileSync(CLIENT, 'utf8')

let failures = 0
function ok(msg) { console.log('  PASS  ' + msg) }
function bad(msg) { failures++; console.log('  FAIL  ' + msg) }

/* ---------------- 最小 React 替身 ---------------- */
function makeReact() {
  const hooks = { list: [], cursor: 0, effects: [] }
  class Component {
    constructor(props) { this.props = props || {}; this.state = {} }
    setState(patch) { this.state = Object.assign({}, this.state, patch) }
  }
  Component.prototype.isReactComponent = {}
  return {
    Component,
    __hooks: hooks,
    useState(init) {
      const i = hooks.cursor++
      if (!(i in hooks.list)) hooks.list[i] = typeof init === 'function' ? init() : init
      const set = (v) => {
        hooks.list[i] = typeof v === 'function' ? v(hooks.list[i]) : v
      }
      return [hooks.list[i], set]
    },
    useRef(init) { const i = hooks.cursor++; if (!(i in hooks.list)) hooks.list[i] = { current: init }; return hooks.list[i] },
    useMemo(fn) { const i = hooks.cursor++; if (!(i in hooks.list)) hooks.list[i] = fn(); return hooks.list[i] },
    /* 带依赖的 useEffect：模拟 React 的「依赖不变就不重跑」。
       少了这一步，每次渲染都会把轮询 / 空闲调度这些 interval 重建一遍，
       时间推进时反复重置，行为测试根本不可复现。 */
    useEffect(fn, deps) {
      const i = hooks.cursor++
      const prev = hooks.list[i]
      const changed = !prev || deps === undefined || !prev.deps
        || deps.length !== prev.deps.length
        || deps.some((d, k) => !Object.is(d, prev.deps[k]))
      const slot = prev || { deps: undefined, cleanup: undefined, fn: null }
      hooks.list[i] = slot
      if (changed) {
        slot.deps = deps
        slot.fn = fn
        hooks.effects.push(slot)
      }
    },
    useCallback(fn) { return fn },
    createElement(type, props, ...children) {
      /* 真 React 会把数组子节点摊平；这里不摊平的话，
         createElement('div', p, [a, b]) 的整棵子树在 findAll 眼里**根本不存在** ——
         组件其实是对的，测试却报"找不到节点"，极容易误判成产品 bug。 */
      const kids = []
      const push = (c) => {
        if (c === undefined || c === null || c === false || c === true) return
        if (Array.isArray(c)) { c.forEach(push); return }
        kids.push(c)
      }
      children.forEach(push)
      /* 必须把 children 并进 props：真实 React 就是这么做的。
         少了这一步，class 组件（错误边界）的 render() 里读 this.props.children
         会拿到 undefined，整棵子树直接变空 —— 测试会"全都找不到"，
         却看不出任何报错，非常容易误判成组件出了 bug。 */
      const p = Object.assign({}, props || {})
      if (kids.length) p.children = kids.length === 1 ? kids[0] : kids
      if (typeof type === 'function' && type.prototype && type.prototype.render) {
        const inst = new type(p)
        inst.props = p
        return inst.render()
      }
      return { type, props: p, children: kids }
    },
    reset() { hooks.list = []; hooks.cursor = 0; hooks.effects = [] },
  }
}

/* 素材预加载用 <img>：Node 里没有，补一个「一赋 src 就立刻 onload」的替身。
   没有它，loaded / dragReady 永远是 false，就只能测到"素材没下好时的保守状态"。 */
global.Image = class {
  constructor() { this.onload = null; this.onerror = null; this._src = '' }
  set src(v) { this._src = v; if (this.onload) this.onload() }
  get src() { return this._src }
}

/* ---------------- 装载 client.js ---------------- */
const react = makeReact()
let captured = null

global.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}

require(CLIENT)

/* 每次都重新装载，拿到全新的 React hook 表 —— 否则多次渲染会共用同一份 hooks，
   映射到错误的槽位，测出来的东西不可信。
   （不能用 delete require.cache：对绝对路径的 require.resolve 不生效） */
const vm = require('node:vm')
const CLIENT_SOURCE = SOURCE

function loadPet() {
  const r = makeReact()
  const requireStub = (n) => {
    if (n === 'react') return r
    throw new Error('unexpected require: ' + n)
  }
  captured = null
  vm.runInThisContext(CLIENT_SOURCE, { filename: CLIENT })
  if (!captured) throw new Error('client.js 没有调用 window.__ModuleLoader__.load()')
  return { react: r, spec: captured, mod: captured.factory(requireStub) }
}

/* 用一次性的 ctx 应用插件，返回它注册的组件（每次都是全新实例） */
function applyPet(loaded) {
  const calls = []
  const ctx = {
    slots: {
      inject(key, cb) { calls.push({ op: 'inject', key }); return cb() },
      register(spec, comp) { calls.push({ op: 'register', spec, comp }); return () => {} },
    },
  }
  loaded.mod.apply(ctx)
  const inj = calls.find((c) => c.op === 'inject')
  const reg = calls.find((c) => c.op === 'register')
  if (!inj || inj.key !== 'shell.overlay') throw new Error('未 inject 到 shell.overlay')
  return { inj, reg, comp: reg.comp, spec: reg.spec }
}

console.log('== 1. 工厂与导出 ==')
const first = loadPet()
ok('调用了 __ModuleLoader__.load()')
if (first.spec.id !== 'dsh-pet') bad('模块 id 应为 dsh-pet，实际 ' + first.spec.id)
else ok('模块 id = dsh-pet')

const mod = first.mod
if (typeof mod.name !== 'string') bad('exports.name 缺失')
else ok('exports.name = ' + mod.name)
if (!Array.isArray(mod.inject)) bad('exports.inject 应为数组')
else ok('exports.inject = ' + JSON.stringify(mod.inject))
if (typeof mod.apply !== 'function') { bad('exports.apply 缺失'); process.exit(1) }
ok('exports.apply 是函数')

/* ---------------- 2. apply(ctx) 注册行为 ---------------- */
console.log('')
console.log('== 2. apply(ctx) 注册行为 ==')
let reg
try {
  const applied = applyPet(first)
  reg = applied.reg
  ok('apply 未抛错')
  ok('inject("shell.overlay") 正确')
} catch (err) {
  bad('apply 抛错: ' + err.message)
  process.exit(1)
}

if (!reg) bad('未调用 slots.register')
else {
  ok('register 被调用，id = ' + reg.spec.id)
  if (reg.spec.name !== 'shell.overlay') bad('register 的 name 必须是 shell.overlay')
  else ok('register name = shell.overlay')
  if (typeof reg.spec.label !== 'function') bad('label 应为函数')
  else ok('label 是函数（惰性求值）')
  if (typeof reg.comp !== 'function') bad('组件不是函数')
  else ok('注册的是组件函数')
}

/* ---------------- 3. 组件渲染 ---------------- */
console.log('')
console.log('== 3. Pet 组件渲染 ==')

/* 把「元素树」真正展开成 DOM 树：
   createElement 只是建元素，不会调用函数组件；外面又包了错误边界，
   所以必须递归地把 function / class 组件都渲染掉，才能看到真实的节点。 */
function renderTree(el) {
  if (!el || typeof el !== 'object') return el
  const t = el.type
  if (typeof t === 'function') {
    const out = (t.prototype && t.prototype.render)
      ? new t(el.props).render()
      : t(el.props)
    return renderTree(out)
  }
  const node = {
    type: t,
    props: el.props || {},
    children: (el.children || []).map(renderTree).filter(Boolean),
  }
  /* 把 ref 真的接上，并给节点一个能记账的 animate()。
     没有这一步，actRef.current 永远是 null，playAction() 会在第一行
     就 return —— 自主动作在测试里"什么都不做"，看起来像功能没写。 */
  const r = node.props.ref
  if (r && typeof r === 'object') {
    r.current = node
    node.animate = (kf, opts) => {
      ANIM_LOG.push({ cls: node.props.className, kf, opts, t: CLOCK.now })
      return { cancel() {} }
    }
  }
  return node
}

/* 记录所有 animate() 调用（自主动作 / 弹跳都走这里） */
const ANIM_LOG = []

/* ---- 假时钟 ----
   为什么必须自带一套：睡觉要等 90 秒、游走要等 45 秒，真等下去一轮测试要跑
   好几分钟，而且不可复现。接管 Date.now / performance.now / setInterval /
   setTimeout 之后，时间由 CLOCK.now 手动推进、定时器按到期顺序触发。

   ⚠️ 这段必须放在**所有用例之前**（而不是第 6 段开头）：拖拽用例也要靠它造出
   "这次移动花了 30 毫秒"的时间差。没有时间差，`dt = max(1, 0) = 1`，几像素的
   位移会被算成几十 px/ms，直接判成抛掷 —— 测得的分支就完全不对了。 */
const CLOCK = { now: 1700000000000 }
Date.now = () => CLOCK.now
global.performance = { now: () => CLOCK.now }

const TIMERS = { intervals: [], timeouts: [] }
let timerSeq = 0
global.setInterval = (fn, ms) => {
  const t = { id: ++timerSeq, fn, ms, nextAt: CLOCK.now + ms }
  TIMERS.intervals.push(t)
  return t
}
global.clearInterval = (t) => { const i = TIMERS.intervals.indexOf(t); if (i >= 0) TIMERS.intervals.splice(i, 1) }
global.setTimeout = (fn, ms) => {
  const t = { id: ++timerSeq, fn, at: CLOCK.now + ms }
  TIMERS.timeouts.push(t)
  return t
}
global.clearTimeout = (t) => { const i = TIMERS.timeouts.indexOf(t); if (i >= 0) TIMERS.timeouts.splice(i, 1) }

/* 深度优先找出所有符合条件的节点 */
function findAll(node, pred, acc) {
  acc = acc || []
  if (!node || typeof node !== 'object') return acc
  if (node.type && pred(node)) acc.push(node)
  ;(node.children || []).forEach((c) => findAll(c, pred, acc))
  return acc
}

function renderPet(loaded, props) {
  loaded.react.reset()
  const applied = applyPet(loaded)
  const el = renderTree(applied.comp(props))
  return { el, comp: applied.comp }
}

/* 重渲染但**不清空 hooks** —— 模拟 React 在 setState 后的 re-render。
   只把 cursor 归零（真实 React 每次渲染都从头消费 hook 槽位）。 */
function rerender(loaded, comp, props) {
  loaded.react.__hooks.cursor = 0
  return renderTree(comp(props))
}

/* 跑「本轮依赖变了」的 effect（真实 React 是在提交后跑）。
   先执行上一次的 cleanup —— interval / 监听器靠它才不会越积越多。 */
function runEffects(loaded) {
  const pend = loaded.react.__hooks.effects.splice(0)
  const live = loaded.react.__hooks.live || (loaded.react.__hooks.live = [])
  for (const slot of pend) {
    if (typeof slot.cleanup === 'function') {
      try { slot.cleanup() } catch (err) { /* 忽略 */ }
    }
    const c = slot.fn()
    slot.cleanup = (typeof c === 'function') ? c : undefined
    if (live.indexOf(slot) < 0) live.push(slot)
  }
}

/* 卸载：把还活着的 effect 全部清理掉。
   没有这一步，每次 session() 注册的轮询 / 空闲调度 interval 会一直留在
   TIMERS 里 —— 一个用例跑完它还在跑，后面所有用例的输出里都混着
   前面几十个"会话"的动作，断言会莫名其妙地时红时绿。 */
function unmountSession(loaded) {
  const live = loaded.react.__hooks.live || []
  live.forEach((slot) => {
    if (typeof slot.cleanup === 'function') {
      try { slot.cleanup() } catch (err) { /* 忽略 */ }
    }
  })
  live.length = 0
}

/* className 可能是 "dshPetTag dshPetPressure"，所以不能用 === 精确匹配 */
function hasClass(root, name) {
  return findAll(root, (n) => n.props && typeof n.props.className === 'string'
    && (' ' + n.props.className + ' ').indexOf(' ' + name + ' ') >= 0)
}

/* 假的指针事件：handler 会用到 currentTarget 的捕获与尺寸 */
function pointerEv(x, y) {
  return {
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    currentTarget: {
      setPointerCapture() {},
      releasePointerCapture() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 270 } },
    },
  }
}

/* 按 class **词**匹配，不是整串相等 —— 这正是浏览器的语义。
   原来写成 `className === name`，于是元素一旦多挂一个类就"查不到"：
   气泡加情绪配色（`dshPetBubble dshPetBubbleShout`）时 6.8 / 6.11 就是这么红的；
   仪表高压时的 `dshPetTag dshPetPressure` 也一直有同样的隐患。 */
function byClass(root, name) {
  return findAll(root, (n) => {
    const c = n.props && n.props.className
    return typeof c === 'string' && c.split(/\s+/).indexOf(name) >= 0
  })
}

/* 把 React 子节点摊平成文本。标签和仪表现在都是"一行 flex"，
   children 是数组（文字 + 控件），直接 join 会得到 [object Object]。 */
function flatText(c) {
  if (c == null || c === false || c === true) return ''
  if (Array.isArray(c)) return c.map(flatText).join('')
  if (typeof c === 'object') return flatText(c.props && c.props.children)
  return String(c)
}

function labelOf(el) {
  /* 用 hasClass 而不是精确匹配：className 可能是 "dshPetTag dshPetPressure"。 */
  const tag = hasClass(el, 'dshPetTag')[0]
  if (!tag) return null
  /* 只看文字那一段：第二个子节点是 ↻ 控件，它不算"标签内容" */
  const arr = Array.isArray(tag.props.children) ? tag.props.children : [tag.props.children]
  return flatText(arr[0])
}

/* ---- 仪表（AI 状态的那条独立指示） ----
   这些助手既接受 session 也接受节点：写成 noteTextOf(s) 和 noteTextOf(s.el)
   都能用。曾经因为写成 s 而到处返回 null，白查了一轮。 */
function nodeOf(x) { return (x && x.el) ? x.el : x }

/* 读根节点上的任意 data-*（"这张脸归谁"就挂在 data-dsh-pet-face 上） */
function attrOf(x, name) {
  const el = nodeOf(x)
  return (el && el.props && el.props[name] !== undefined) ? String(el.props[name]) : null
}

function meterOf(x) { return hasClass(nodeOf(x), 'dshPetMeter')[0] || null }

function aiStateOf(x) {
  const m = meterOf(x)
  return m ? (m.props['data-dsh-pet-ai'] || null) : null
}

function meterTextOf(x) {
  const m = meterOf(x)
  if (!m) return null
  const t = hasClass(m, 'dshPetMeterText')[0]
  return t ? flatText(t.props.children) : null
}

function dotOf(x) {
  const m = meterOf(x)
  return m ? hasClass(m, 'dshPetDot')[0] || null : null
}

function dotColorOf(x) {
  const d = dotOf(x)
  return d ? (d.props.style && d.props.style.color) || null : null
}

function barWidthOf(x) {
  const m = meterOf(x)
  if (!m) return null
  const f = hasClass(m, 'dshPetBarFill')[0]
  return f ? (f.props.style && f.props.style.width) || null : null
}

function meterTitleOf(x) {
  const m = meterOf(x)
  return m ? (m.props.title || null) : null
}

/* 仪表提示（系统口吻的一行小字，和宠物气泡是两回事） */
function noteTextOf(x) {
  const n = byClass(nodeOf(x), 'dshPetNote')[0]
  return n ? flatText(n.props.children) : null
}

// 3a: useSessionStatus 完全拿不到（最坏情况，必须不崩）
let pet = null
/* 同一个模块实例贯穿 3a~3c：拖拽是状态机，每次换新实例就测不出连续行为了 */
const petLoaded = loadPet()
try {
  pet = renderPet(petLoaded, {})
  const el = pet.el
  ok('无 useSessionStatus 时渲染通过')

  if (!el || el.type !== 'div') {
    bad('根节点不是 div，实际 ' + (el && el.type))
  } else {
    if (!el.props.style || el.props.style.pointerEvents !== 'none') bad('立绘根节点必须 pointer-events: none（否则挡鼠标）')
    else ok('立绘根节点 pointer-events: none')

    /* --- 图层结构：本体 + 拖拽差分必须同处一个舞台层，才能整体缩放 --- */
    const stage = byClass(el, 'dshPetStage')
    if (stage.length !== 1) bad('应有且仅有一个 div.dshPetStage，实际 ' + stage.length)
    else ok('存在舞台层 dshPetStage')

    const imgs = findAll(el, (n) => n.type === 'img')
    if (imgs.length !== 2) bad('应渲染 2 张 img（本体 + 拖拽差分），实际 ' + imgs.length)
    else {
      ok('渲染出 2 张 img')

      const base = imgs.find((i) => i.props.className === 'dshPetImg')
      const drag = imgs.find((i) => i.props.className === 'dshPetDrag')

      /* 本体和差分之间多了一层 dshPetAct（自主动作的 transform 通道），
         所以用「舞台子树里含它」而不是「舞台的直接子节点是它」 */
      const inStage = (cls, node) => stage.length > 0 &&
        findAll(stage[0], (n) => n.props && n.props.className === cls).indexOf(node) >= 0

      if (!base) bad('缺少本体 img.dshPetImg')
      else {
        ok('本体 src = ' + base.props.src)
        if (!inStage('dshPetImg', base)) bad('本体 img 不在 dshPetStage 里')
        else ok('本体 img 位于舞台层内')
        const file = path.join(ASSETS, path.basename(String(base.props.src).split('?')[0]))
        if (fs.existsSync(file)) ok('本体素材存在: ' + path.basename(file))
        else bad('本体素材缺失: ' + file)
      }

      if (!drag) bad('缺少拖拽差分 img.dshPetDrag')
      else {
        ok('拖拽差分 src = ' + drag.props.src)
        if (String(drag.props.src).indexOf('drag.png') < 0) bad('拖拽差分 src 未指向 drag.png')
        else ok('拖拽差分指向 drag.png')
        if (fs.existsSync(path.join(ASSETS, 'drag.png'))) ok('拖拽素材存在: assets/drag.png')
        else bad('拖拽素材缺失: ' + path.join(ASSETS, 'drag.png'))
        if (drag.props.style && drag.props.style.opacity === 0) ok('拖拽差分初始 opacity = 0（不拖时完全看不见）')
        else bad('拖拽差分初始必须 opacity: 0，实际 ' + (drag.props.style && drag.props.style.opacity))
        if (!inStage('dshPetDrag', drag)) bad('拖拽差分不在 dshPetStage 里（会跟本体错位）')
        else ok('拖拽差分与本体同层（缩放同步）')
      }
    }

    /* 拖拽层绝不能抢事件：规则写在模块注入的 CSS 里，静态校验 */
    if (SOURCE.indexOf('.dshPetRoot .dshPetDrag { pointer-events: none; }') >= 0) {
      ok('CSS 已禁用拖拽层指针事件（不盖本体热区）')
    } else bad('CSS 缺少 .dshPetDrag { pointer-events: none; }')

    /* ↻ 从"挂在下方抢位置的圆钮"收进了标签药丸里。
       它自己必须仍然是可点区域（CSS 里给 pointer-events: auto），
       否则父级 .dshPetRoot 的 pointer-events: none 会让它彻底点不到。 */
    const go = byClass(el, 'dshPetTagGo')[0]
    if (!go) bad('缺少换表情的 ↻ 入口（.dshPetTagGo）')
    else if (typeof go.props.onClick !== 'function') bad('↻ 没有接 onClick')
    else ok('存在换表情入口 .dshPetTagGo，且接了 onClick')
    if (/\.dshPetTagGo \{[^}]*pointer-events: auto/.test(SOURCE)) {
      ok('CSS 给 ↻ 开了 pointer-events: auto')
    } else bad('CSS 里 .dshPetTagGo 没开 pointer-events: auto（点不到）')

    if (el.props['data-dsh-pet']) ok('初始记号 data-dsh-pet = ' + el.props['data-dsh-pet'])
    else bad('根节点缺少 data-dsh-pet 记号')
  }
} catch (err) {
  bad('渲染抛错: ' + err.message)
}

// 3b: 拖拽行为 —— 按下并移动 → 切到抓狂差分
if (pet && pet.el && pet.el.props.onPointerMove) {
  try {
    /* 先把 effect 跑掉，让素材预加载完成（loaded / dragReady 变 true）。
       否则 showDrag 恒为 false，测到的是"素材还没下好"的保守分支。 */
    runEffects(petLoaded)
    const elReady = rerender(petLoaded, pet.comp, {})
    const baseReady = byClass(elReady, 'dshPetImg')[0]
    if (baseReady && baseReady.props.style.opacity === 1) ok('素材就绪后本体可见（opacity = 1）')
    else bad('素材就绪后本体仍不可见，opacity = ' + (baseReady && baseReady.props.style.opacity))

    const before = elReady.props['data-dsh-pet']

    elReady.props.onPointerDown(pointerEv(100, 100))
    /* 真实的拖动是有时间跨度的，这里必须让假时钟走一点。
       否则 dt = max(1, 0) = 1，12px 会被算成 12px/ms —— 远超 MAX_SPEED(4.5)，
       直接判定成"抛掷"，测到的就不是"放下"分支了。 */
    advance(30)
    elReady.props.onPointerMove(pointerEv(106, 100))
    advance(30)
    elReady.props.onPointerMove(pointerEv(112, 100))   // 总位移 12 > DRAG_THRESHOLD(4)

    const el1 = rerender(petLoaded, pet.comp, {})
    const drag1 = byClass(el1, 'dshPetDrag')[0]
    const base1 = byClass(el1, 'dshPetImg')[0]

    if (drag1 && drag1.props.style.opacity === 1) ok('拖拽中：抓狂层淡入（opacity = 1）')
    else bad('拖拽中抓狂层未淡入，opacity = ' + (drag1 && drag1.props.style.opacity))
    if (base1 && base1.props.style.opacity === 0) ok('拖拽中：本体同步淡出（真交叉淡入，不是叠加）')
    else bad('拖拽中本体未淡出，opacity = ' + (base1 && base1.props.style.opacity))

    if (el1.props['data-dsh-pet'] === 'drag') ok('拖拽中：记号切换为 drag')
    else bad('拖拽中记号应为 drag，实际 ' + el1.props['data-dsh-pet'])

    const lab = labelOf(el1)
    if (lab && lab.indexOf('抓狂') >= 0) ok('拖拽中：标签文案 = ' + lab)
    else bad('拖拽中标签文案异常: ' + lab)

    // 松手 → 抓狂层淡出，回到普通表情
    el1.props.onPointerUp(pointerEv(112, 100))
    const el2 = rerender(petLoaded, pet.comp, {})
    const drag2 = byClass(el2, 'dshPetDrag')[0]
    if (drag2 && drag2.props.style.opacity === 0) ok('松手后：抓狂层淡出（opacity = 0）')
    else bad('松手后抓狂层未淡出')

    if (before === el2.props['data-dsh-pet']) ok('松手后回到原先表情: ' + before)
    else bad('松手后表情没复位: ' + before + ' → ' + el2.props['data-dsh-pet'])
  } catch (err) {
    bad('拖拽流程抛错: ' + err.message + '\n' + String(err.stack).split('\n').slice(1, 5).join('\n'))
  }
} else {
  bad('组件根节点没有 onPointerMove（拖拽没接上）')
}

// 3c: 原地松手（没移动）→ 仍然当作点击换表情
if (pet && pet.el && pet.el.props.onPointerUp) {
  try {
    const el0 = pet.el
    const before = el0.props['data-dsh-pet']
    el0.props.onPointerDown(pointerEv(100, 135))
    el0.props.onPointerUp(pointerEv(100, 135))     // 正中心，落在椭圆热区内
    const el3 = rerender(petLoaded, pet.comp, {})
    const after = el3.props['data-dsh-pet']
    if (after !== before) ok('原地点击仍能换表情: ' + before + ' → ' + after)
    else bad('原地点击没有换表情（点击热区可能失效）')
  } catch (err) {
    bad('点击流程抛错: ' + err.message)
  }
}

// 3d: useSessionStatus 返回一个直接可用的状态对象
try {
  const fakeHook = () => ({ status: 'running' })
  renderPet(loadPet(), { useSessionStatus: fakeHook })
  ok('useSessionStatus 返回对象时渲染通过')
} catch (err) {
  bad('（对象形态）渲染抛错: ' + err.message)
}

// 3e: useSessionStatus 抛错（真实环境里若形状不符，绝不能拖垮插件）
try {
  const boomHook = () => { throw new Error('hook shape mismatch') }
  renderPet(loadPet(), { useSessionStatus: boomHook })
  ok('useSessionStatus 抛错时被吞掉，插件存活')
} catch (err) {
  bad('（抛错形态）未被兜住: ' + err.message)
}

/* ---------------- 4. 拖拽差分接入（静态校验） ---------------- */
console.log('')
console.log('== 4. 拖拽差分静态校验 ==')
const needs = [
  ['DRAG_SPRITE 常量', 'const DRAG_SPRITE'],
  ['拖拽阈值 DRAG_THRESHOLD', 'DRAG_THRESHOLD'],
  ['位置持久化 key', 'dsh-pet:pos'],
  ['vhid 换算 vhToPx', 'function vhToPx'],
  ['拖拽层样式 dragImgStyle', 'const dragImgStyle'],
  ['标签切换文案', '抓狂'],
]
needs.forEach((pair) => {
  if (SOURCE.indexOf(pair[1]) >= 0) ok('源码含 ' + pair[0])
  else bad('源码缺少 ' + pair[0] + '（找不到: ' + pair[1] + '）')
})

/* 拖拽差分必须**不在** EXPRESSIONS 里：否则轮换/表情挑选会把它当成普通表情选出来 */
const exprBlock = SOURCE.slice(SOURCE.indexOf('const EXPRESSIONS'), SOURCE.indexOf('const DRAG_SPRITE'))
if (exprBlock.indexOf('"drag"') < 0 && exprBlock.indexOf("'drag'") < 0) {
  ok('drag 不在 EXPRESSIONS 里（不会被随机轮到）')
} else bad('drag 混进了 EXPRESSIONS，会被当成普通表情选中')

/* 素材完整性：12 张表情差分全部存在 */
const ids = ['calm', 'happy', 'sleepy', 'cool', 'surprised', 'shy', 'calling', 'angry', 'sleeping', 'confused', 'love', 'excited']
const missing = ids.filter((id) => !fs.existsSync(path.join(ASSETS, id + '.png')))
if (missing.length) bad('表情素材缺失: ' + missing.join(', '))
else ok('12 张表情素材齐全')
if (fs.existsSync(path.join(ASSETS, 'drag.png'))) ok('拖拽差分素材齐全')

/* ---------------- 5. 素材 HTTP 路由（宿主白名单） ---------------- */
console.log('')
console.log('== 5. 素材路由可达性（宿主 ALLOWED 白名单）==')
/* 这一节是补的：素材文件躺在 assets/ 里不代表浏览器拿得到 ——
   宿主 lib/index.js 有个 ALLOWED 白名单，没登记就 404。
   而客户端在 dragReady 为 false 时"什么都不发生"，极难定位。
   所以直接从 HTTP 层查，把这层真相测出来。 */
const { execFileSync } = require('node:child_process')
const ROUTE = 'http://127.0.0.1:19387'
const PROBE_SINK = path.join(require('node:os').tmpdir(), 'dsh-pet-probe.bin')

function httpStatus(url) {
  /* 注意：不能在 Windows 上用 -o /dev/null —— 那是 MSYS 的路径，
     直接喂给 curl.exe 会报错，于是所有请求都变成 "ERR"，静默假阴性。 */
  try {
    const out = execFileSync('curl', ['-s', '-o', PROBE_SINK, '-w', '%{http_code}', '--max-time', '5', url],
      { encoding: 'utf8', timeout: 8000 })
    return String(out).trim()
  } catch (err) { return 'ERR' }
}

const avAt = SOURCE.indexOf('const ASSET_VERSION = ')
const ASSET_VERSION = avAt >= 0 ? parseInt(SOURCE.slice(avAt + 'const ASSET_VERSION = '.length), 10) : 1

if (httpStatus(ROUTE + '/dsh-pet') !== '200') {
  console.log('  SKIP  DSH 未在 19387 上响应，跳过（宿主白名单问题只能重启后在这里暴露）')
} else {
  const targets = ids.concat(['drag'])
  const blocked = []
  targets.forEach((id) => {
    const code = httpStatus(ROUTE + '/dsh-pet/sprite/' + id + '.png?v=' + ASSET_VERSION)
    if (code !== '200') blocked.push(id + '=' + code)
  })
  if (blocked.length) {
    bad('素材路由被挡: ' + blocked.join(', ') + '  ← 宿主 lib/index.js 的 ALLOWED 要同步加名字（改完必须重启 DSH）')
  } else ok(targets.length + ' 个素材（含 drag）全部 200')

  try {
    const probe = execFileSync('curl', ['-s', '--max-time', '5', ROUTE + '/dsh-pet'], { encoding: 'utf8', timeout: 8000 })
    const listed = JSON.parse(probe).sprites || []
    const notListed = targets.filter((id) => listed.indexOf(id) < 0)
    if (notListed.length) bad('宿主白名单里还没有: ' + notListed.join(', ') + '（多半是没重启）')
    else ok('宿主白名单 = ' + listed.length + ' 项，与客户端一致')
  } catch (err) {
    bad('白名单探针解析失败: ' + err.message)
  }
}

/* ---------------- 6. 行为驱动（假时钟 / 假定时器 / 假指针） ---------------- */
console.log('')
console.log('== 6. 行为驱动（自主行为 · 鼠标感知 · 拖拽物理 · 数据联动）==')

/* 假时钟 / 假定时器在上面（第 213 行附近）就已装好 —— 拖拽用例也要用。 */

/* 推进假时钟并触发到期定时器。slice 是时间粒度：
   物理要 16ms（不然一步跨过落地判定），行为调度 50~200ms 就够。 */
function advance(total, slice) {
  const step = slice || 16
  const end = CLOCK.now + total
  while (CLOCK.now < end) {
    CLOCK.now = Math.min(end, CLOCK.now + step)
    let guard = 0
    for (;;) {
      const due = []
      TIMERS.intervals.forEach((t) => { if (t.nextAt <= CLOCK.now) due.push(t) })
      TIMERS.timeouts.forEach((t) => { if (t.at <= CLOCK.now) due.push(t) })
      if (!due.length || ++guard > 4000) break
      due.forEach((t) => {
        if (t.nextAt !== undefined) t.nextAt += t.ms
        else { const i = TIMERS.timeouts.indexOf(t); if (i >= 0) TIMERS.timeouts.splice(i, 1) }
        try { t.fn() } catch (err) { /* 定时器内异常不该中断时间推进 */ }
      })
    }
  }
}

/* 长时间推进要"边推边渲染"。
   假 React 只在 s.render() 时重渲染，而真机是每次 setState 立刻渲染 —— 一次
   advance(46000) 会让"小动作到期自动清除"的 effect 迟迟不跑，actionRef 一直是
   旧值，空闲调度那一段就被 !actionRef.current 永久挡住，看起来像"醒来后再也不动"。
   这只是测试台的失真，不是产品 bug，所以推进时按 chunk 渲染一次对齐真机。 */
function advanceRendered(s, total, chunk) {
  const step = chunk || 1000
  let left = total
  while (left > 0) {
    const d = Math.min(step, left)
    advance(d, 100)
    s.render()
    left -= d
  }
}

/* tick() 是 async（fetch → json → setMind）：必须放微任务跑完 */
async function flush(n) {
  for (let i = 0; i < (n || 14); i += 1) await Promise.resolve()
}

async function advanceAsync(total, slice) {
  const step = slice || 100
  const end = CLOCK.now + total
  while (CLOCK.now < end) {
    advance(Math.min(step, end - CLOCK.now), step)
    await flush(4)
  }
}

/* 假 window：监听器记账 + 视口尺寸 */
const LISTENERS = {}
global.window.addEventListener = (type, fn) => { (LISTENERS[type] = LISTENERS[type] || []).push(fn) }
global.window.removeEventListener = (type, fn) => {
  const a = LISTENERS[type] || []
  const i = a.indexOf(fn)
  if (i >= 0) a.splice(i, 1)
}
global.window.innerWidth = 1440
global.window.innerHeight = 900
function dispatch(type, ev) { (LISTENERS[type] || []).slice().forEach((fn) => fn(ev)) }

const STORE = {}
global.localStorage = {
  getItem: (k) => (k in STORE ? STORE[k] : null),
  setItem: (k, v) => { STORE[k] = String(v) },
  removeItem: (k) => { delete STORE[k] },
}

/* 假 fetch：DIGEST 决定宿主"说什么"。null = 拿不到（走保守分支） */
let DIGEST = null
global.fetch = (url) => {
  if (!DIGEST) return Promise.resolve({ ok: false })
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ digest: DIGEST }) })
}

/* 一次"挂载" = 新模块实例 + 渲染 + 跑首轮 effect。
   之后每推进一段时间都要调 s.render()：假 React 不会自己重渲染。
   开新会话前会先把上一个会话卸载掉（见 unmountSession 的注释）。 */
let LAST_SESSION = null
function session() {
  if (LAST_SESSION) unmountSession(LAST_SESSION.L)
  /* 兜底清扫：section 1~5 是用 renderPet() 直接建的会话，没登记进 LAST_SESSION，
     它们的轮询 interval 会一直活着，混进后面用例的 ANIM_LOG 里（表现为"别人的
     会话在动我的桌宠"）。用例之间本来就该互不影响，所以开新会话时清空遗留 interval。 */
  TIMERS.intervals.length = 0
  const L = loadPet()
  const applied = applyPet(L)
  const s = { L, el: null }
  s.render = () => {
    L.react.__hooks.cursor = 0
    s.el = renderTree(applied.comp({}))
    runEffects(L)
    return s.el
  }
  s.render()
  s.render()
  s.root = () => byClass(s.el, 'dshPetRoot')[0]
  s.style = () => s.root().props.style
  s.data = () => s.root().props['data-dsh-pet']
  LAST_SESSION = s
  return s
}

function tag(s) { return labelOf(s.el) }
/* 现在这张脸归谁：pet = 宠物自己，ai = 她正在替 AI 露面。
   断言"归谁"必须看这个，不能看表情 —— 忙模式的静息脸也叫 calling，
   而小动作（打哈欠）随时可能把表情换成 sleepy，用表情断言会偶发地红。 */
function faceOf(x) { return attrOf(nodeOf(x), 'data-dsh-pet-face') }
function bubbleText(s) {
  const b = byClass(s.el, 'dshPetBubble')[0]
  return b ? String(b.props.children) : null
}
/* 气泡的花样：say / shout / soft。颜色测不了，"哪一套"能测。 */
function bubbleKindOf(x) {
  const b = byClass(nodeOf(x), 'dshPetBubble')[0]
  if (!b) return null
  const k = b.props['data-dsh-pet-bubble']
  return k == null ? null : String(k)
}
function geomOf(s) {
  const st = s.style()
  return { x: parseFloat(st.left), y: parseFloat(st.top), w: parseFloat(st.width), h: parseFloat(st.height) }
}
function clickAt(s, x, y) {
  const ev = pointerEv(x, y)
  s.root().props.onPointerDown(ev)
  s.root().props.onPointerUp(ev)
}
/* 生气门槛是随机的 —— 想断言"第几下生气"就必须先把骰子按住。
   只临时改 Math.random，跑完立刻还原，别污染别的用例。 */
function withRandom(value, fn) {
  const orig = Math.random
  Math.random = () => value
  try { return fn() } finally { Math.random = orig }
}

const ACTION_LABELS = /歪头|抖一下|跳一下|伸懒腰|看向别处|打哈欠|揉眼睛/

;(async () => {
  /* ---- 6.1 待机小动作 ---- */
  DIGEST = null
  {
    const a0 = ANIM_LOG.length
    const s = session()
    if (tag(s) === null) bad('6.1 挂载后拿不到标签')
    advance(9100, 20)
    s.render()
    const acted = ANIM_LOG.slice(a0).some((a) => a.cls === 'dshPetAct')
    if (!acted) bad('6.1 闲到 IDLE_FIRST_MS(9s) 后没有触发自主动作（actRef 上没看到 animate）')
    else ok('6.1 闲 9 秒后触发了自主动作（.dshPetAct 上有 animate 调用）')
    if (!ACTION_LABELS.test(String(tag(s)))) bad('6.1 动作没体现在标签上，实际 = ' + tag(s))
    else ok('6.1 标签显示动作名 = ' + tag(s))
  }

  /* ---- 6.2 闲够 45 秒会游走 ---- */
  {
    const s = session()
    const x0 = geomOf(s).x
    advance(46000, 100)
    s.render()
    const x1 = geomOf(s).x
    if (x1 === x0) bad('6.2 闲 46 秒后位置没变（游走没触发），x 仍是 ' + x0)
    else ok('6.2 闲 46 秒后自己挪了：x ' + x0 + ' → ' + x1)
  }

  /* ---- 6.3 闲够 90 秒会睡觉 ---- */
  {
    const s = session()
    advance(92000, 200)
    s.render()
    const zzz = hasClass(s.el, 'dshPetZzz').length
    if (zzz !== 3) bad('6.3 闲 92 秒后没有出现睡觉的 Z（.dshPetZzz 数量 = ' + zzz + '）')
    else ok('6.3 闲 92 秒后睡着了（3 个 .dshPetZzz）')
    if (String(s.data()) !== 'sleeping') bad('6.3 睡觉时表情应为 sleeping，实际 = ' + s.data())
    else ok('6.3 睡觉用 sleeping 差分')
    /* 呼吸动画也要换成慢的，否则"睡着了还在快喘" */
    if (String(s.style().animation).indexOf('Sleep') < 0) bad('6.3 睡着时没换成慢呼吸动画')
    else ok('6.3 睡着时呼吸改成慢速')
  }

  /* ---- 6.4 【回归】宿主状态只上仪表，绝不碰脸 ----
     这是真踩过的 bug：轮询会把兜底的轮换表情写进 AI 状态，
     于是那条"AI 表情"恒为真，sleepExpr / nearExpr 全被压死 ——
     表现为"睡觉循环"和"靠近抬头"两个功能完全没反应。
     AI 状态现在走 .dshPetMeter，但这条回归必须继续守着。 */
  DIGEST = { intent: 'waiting', texts: [], tool: '', error: false }
  {
    const s = session()
    await advanceAsync(2500, 200)
    s.render()
    if (aiStateOf(s.el) !== 'waiting') bad('6.4 waiting 应体现在仪表上，实际 = ' + aiStateOf(s.el))
    else ok('6.4 waiting 上了仪表 = ' + meterTextOf(s.el))
    const t1 = String(tag(s))
    if (t1.indexOf('等你') >= 0) bad('6.4 waiting 跑到标签上了，实际 = ' + t1)
    else ok('6.4 waiting 没有污染标签 = ' + t1)
    await advanceAsync(93000, 250)
    s.render()
    if (hasClass(s.el, 'dshPetZzz').length !== 3) {
      bad('6.4 回归失败：宿主一直说 waiting 时睡不了觉（AI 状态压住了睡觉）')
    } else ok('6.4 即使宿主一直说 waiting，闲够 90 秒仍然睡得着')
  }

  /* ---- 6.5 「按 AI 说的内容猜表情」整条流水线必须已经拆掉 ----
     它曾经是表情里 AI 那两格的唯一来源：读 AI 的文本 / 工具名挑一个表情，
     再抢进那张脸。现在它不该以**代码**形式存在
     （注释里提到这些名字是允许的——那是在解释为什么删掉）。 */
  DIGEST = { intent: 'idle', texts: [], tool: '', error: false }
  {
    /* 剥掉注释再查，否则"解释为什么删"的注释会把检查顶成假红 */
    const CODE_ONLY = SOURCE
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const GONE = ['pickByScore', 'mindToExprs', 'CONTENT_RULES', 'RULE_WEIGHT', 'INTENT_MAP',
      'TOOL_EMOJI', 'setMind', 'mindExpr', 'mindActive', 'MIND_HOLD_MS',
      'ERROR_LINES', 'SPACE_LINES', 'BUSY_LINES', 'dshPetBtn',
      /* 节拍器：按开机帧号轮换表情。用户报"生硬地每四秒切一次"就是它 */
      'exprFor', 'localState', 'STATUS_MAP', 'FRAME_MS', 'bootRef',
      /* 三刀切的粗分区：只有头/身/裙摆三条横切线，用户报"分区有点少"就是它 */
      'ZONE_HEAD', 'ZONE_BODY', 'ZONE_LINES', 'pickZoneExpr', 'MULTI_CLICK_COUNT']
    const left = GONE.filter((sym) => CODE_ONLY.indexOf(sym) >= 0)
    if (left.length) bad('6.5 AI 猜表情的流水线没删干净，还留着：' + left.join(' / '))
    else ok('6.5 AI 猜表情的流水线（' + GONE.length + ' 个符号）已从代码里移除')
    if (CODE_ONLY.indexOf('dshPetMeter') < 0 || CODE_ONLY.indexOf('dshPetNote') < 0) {
      bad('6.5 仪表 / 仪表提示的节点没找到（分离方案没落地）')
    } else ok('6.5 仪表 .dshPetMeter 与提示 .dshPetNote 都在')

    /* 点击那轮的旋钮：门槛要随机、分区要够多 —— 少一个就退回"戳两下就摸清了" */
    const ZONE_SYMS = ['ZONES', 'ZONE_FALLBACK', 'MULTI_CLICK_MIN', 'MULTI_CLICK_MAX', 'zoneAt']
    const missZone = ZONE_SYMS.filter((sym) => CODE_ONLY.indexOf(sym) < 0)
    if (missZone.length) bad('6.5 点击分区 / 随机门槛的旋钮缺了：' + missZone.join(' / '))
    else ok('6.5 点击分区与随机门槛的旋钮都在（' + ZONE_SYMS.join(' / ') + '）')

    /* 分时复用的四个旋钮必须都在 —— 少一个就意味着"忙闲共用一张脸"又退化成
       同时抢（或者干脆没有迟滞、脸来回跳） */
    const FACE_SYMS = ['REST_FACE', 'AI_FACE', 'FACE_BUSY_DELAY_MS', 'FACE_REST_DELAY_MS']
    const missFace = FACE_SYMS.filter((sym) => CODE_ONLY.indexOf(sym) < 0)
    if (missFace.length) bad('6.5 忙/闲分时复用的旋钮缺了：' + missFace.join(' / '))
    else ok('6.5 忙/闲分时复用的四个旋钮都在（' + FACE_SYMS.join(' / ') + '）')

    const s = session()
    await advanceAsync(2500, 200)
    s.render()
    ok('6.5 idle 时标签 = ' + tag(s))
    DIGEST = { intent: 'tool', tool: 'ops_bash', texts: ['我在读一个很长的文件'], error: false }
    await advanceAsync(1200, 200)
    s.render()
    const t = String(tag(s))
    if (t.indexOf('跑工具') >= 0 || t.indexOf('看内容') >= 0) bad('6.5 AI 内容跑到标签上了 = ' + t)
    else ok('6.5 AI 内容只上仪表，标签仍是 = ' + t)
    if (aiStateOf(s.el) !== 'tool') bad('6.5 工具状态没上仪表，实际 = ' + aiStateOf(s.el))
    else ok('6.5 工具状态上了仪表 = ' + meterTextOf(s.el))
  }

  /* ---- 6.6 数据联动全部改走仪表：细条 / 进度 / 圆点，
     而且**一样都不许爬回标签或宠物气泡**。 */
  DIGEST = { intent: 'idle', texts: [], tool: '', error: false, meter: { pct: 0.9, used: 900, limit: 1000 } }
  {
    const s = session()
    await advanceAsync(1500, 250)
    s.render()
    if (barWidthOf(s.el) !== '90%') bad('6.6 上下文 90% 没体现在仪表细条上，实际 = ' + barWidthOf(s.el))
    else ok('6.6 上下文占用 = 仪表细条 ' + barWidthOf(s.el))
    if (String(tag(s)).indexOf('上下文') >= 0) bad('6.6 上下文又爬回标签了 = ' + tag(s))
    else ok('6.6 上下文不占标签 = ' + tag(s))
    if (!hasClass(s.el, 'dshPetPressure').length) bad('6.6 高压时仪表没有 dshPetPressure 高亮')
    else ok('6.6 高压时仪表有 dshPetPressure 高亮')
    advance(600, 100)
    s.render()
    const n1 = String(noteTextOf(s))
    if (n1.indexOf('上下文 90%') < 0) bad('6.6 高压时仪表没提醒，实际 = ' + n1)
    else ok('6.6 高压仪表提醒 = ' + n1)
    if (bubbleText(s) !== null) bad('6.6 仪表提醒不该借宠物的嘴，实际气泡 = ' + bubbleText(s))
    else ok('6.6 仪表提醒走 .dshPetNote，不借宠物的嘴')
  }

  DIGEST = { intent: 'idle', texts: [], tool: '', error: false, todos: { done: 2, total: 5 } }
  {
    const s = session()
    await advanceAsync(1500, 250)
    s.render()
    const mt = String(meterTextOf(s.el))
    if (mt.indexOf('2/5') < 0) bad('6.6 todo 进度没上仪表，实际 = ' + mt)
    else ok('6.6 todo 进度上仪表 = ' + mt)
    if (String(tag(s)).indexOf('2/5') >= 0) bad('6.6 todo 进度又爬回标签了 = ' + tag(s))
    else ok('6.6 进度不占标签 = ' + tag(s))
  }

  DIGEST = { intent: 'error', texts: [], tool: '', error: true }
  {
    const s = session()
    await advanceAsync(1500, 250)
    s.render()
    if (aiStateOf(s.el) !== 'error') bad('6.6 报错没上仪表，实际 = ' + aiStateOf(s.el))
    else ok('6.6 报错上仪表 = ' + aiStateOf(s.el))
    if (dotColorOf(s.el) !== '#ff7a7a') bad('6.6 报错圆点颜色不对，实际 = ' + dotColorOf(s.el))
    else ok('6.6 报错圆点是红色')
    /* 关键分离：报错**不会立刻**抢脸 —— 要连续忙满 FACE_BUSY_DELAY_MS 才交出去。
       （守的仍是"谁抢到别人就不吭声"那个老毛病：瞬时抢脸一样是静默的，
       用户只会觉得"脸莫名其妙变了"。驻留满之后它会接管静息脸，那是 6.27 的事。） */
    if (String(s.data()) === 'surprised') bad('6.6 报错仍然立刻改写了表情（脸不该被瞬时抢走）')
    else ok('6.6 报错不立刻抢脸，脸仍是 ' + s.data())
    advance(600, 100)
    s.render()
    const n = String(noteTextOf(s))
    if (n.indexOf('出错') < 0) bad('6.6 报错没有仪表提醒，实际 = ' + n)
    else ok('6.6 报错仪表提醒 = ' + n)
    if (bubbleText(s) !== null) bad('6.6 报错不该让宠物说话，实际 = ' + bubbleText(s))
    else ok('6.6 报错不借宠物的嘴')
  }

  /* ---- 6.6b 向后兼容：宿主还是旧版（没有 meter / todos 字段）时
     不能显示「上下文 0%」，也不能崩。用户没重启宿主时就跑在这个分支上。 ---- */
  DIGEST = { intent: 'thinking', texts: [], tool: 'ops_bash', error: false }
  {
    const s = session()
    await advanceAsync(1500, 250)
    s.render()
    if (barWidthOf(s.el) !== '0%') bad('6.6b 旧宿主下细条应为 0%，实际 = ' + barWidthOf(s.el))
    else ok('6.6b 旧宿主（无 meter）细条 = ' + barWidthOf(s.el))
    const mt = String(meterTextOf(s.el))
    if (/上下文/.test(mt)) bad('6.6b 旧宿主下不该显示上下文，实际 = ' + mt)
    else ok('6.6b 旧宿主不显示上下文，仪表文字 = ' + mt)
    if (/\d+\/\d+/.test(mt)) bad('6.6b 旧宿主下不该显示 todo 进度，实际 = ' + mt)
    else ok('6.6b 旧宿主不显示 todo 进度')
    if (String(tag(s)).indexOf('上下文') >= 0) bad('6.6b 标签被污染 = ' + tag(s))
    else ok('6.6b 标签干净 = ' + tag(s))
  }

  /* ---- 6.7 鼠标靠近抬头 / 走远目送 ---- */
  DIGEST = null
  {
    const s = session()
    const g = geomOf(s)
    const cx = g.x + g.w * 0.5
    const cy = g.y + g.h * 0.5
    dispatch('pointermove', { clientX: cx + 600, clientY: cy })
    advance(500, 20)                                   // 留出时间，否则被当成「快速掠过」
    dispatch('pointermove', { clientX: cx, clientY: cy })
    s.render()
    if (String(tag(s)).indexOf('看你') < 0) bad('6.7 鼠标靠近后应显示「看你」，实际 = ' + tag(s))
    else ok('6.7 靠近抬头 = ' + tag(s))
    if (String(s.data()) !== 'calling') bad('6.7 靠近时表情应为 calling，实际 = ' + s.data())
    else ok('6.7 靠近用 calling 差分')
    advance(900, 20)                                   // 走远也要慢，别触发吓一跳
    dispatch('pointermove', { clientX: cx + 900, clientY: cy + 600 })
    s.render()
    if (String(tag(s)).indexOf('目送') < 0) bad('6.7 鼠标走远后应显示「目送」，实际 = ' + tag(s))
    else ok('6.7 走远目送 = ' + tag(s))
  }

  /* ---- 6.8 快速掠过会吓一跳 ---- */
  {
    const s = session()
    const g = geomOf(s)
    const cx = g.x + g.w * 0.5
    const cy = g.y + g.h * 0.5
    dispatch('pointermove', { clientX: cx + 500, clientY: cy })
    advance(40, 20)
    dispatch('pointermove', { clientX: cx, clientY: cy })
    s.render()
    if (String(s.data()) !== 'surprised') bad('6.8 快速掠过应吓一跳（surprised），实际 = ' + s.data())
    else ok('6.8 快速掠过 → 吓一跳')
    if (String(bubbleText(s)) !== '！') bad('6.8 吓一跳应冒出「！」，实际 = ' + bubbleText(s))
    else ok('6.8 吓一跳气泡 = ！')
  }

  /* ---- 6.9 拖起来换成抓狂差分 ---- */
  {
    const s = session()
    const g = geomOf(s)
    const d = pointerEv(g.x + g.w * 0.5, g.y + g.h * 0.5)
    s.root().props.onPointerDown(d)
    advance(30, 16)
    s.root().props.onPointerMove(pointerEv(g.x + g.w * 0.5 + 60, g.y + g.h * 0.5 + 20))
    s.render()
    if (String(tag(s)).indexOf('拖拽中') < 0) bad('6.9 拖动中标签应显示「抓狂 · 拖拽中」，实际 = ' + tag(s))
    else ok('6.9 拖动中 = ' + tag(s))
    if (String(s.data()) !== 'drag') bad('6.9 拖动中 data-dsh-pet 应为 drag，实际 = ' + s.data())
    else ok('6.9 拖动中用 drag 差分')
  }

  /* ---- 6.10 抛掷物理：飞出去 → 落地 ---- */
  {
    const s = session()
    const g = geomOf(s)
    const y0 = geomOf(s).y
    const props = s.root().props
    props.onPointerDown(pointerEv(g.x + 100, g.y + 100))
    advance(120, 16)
    props.onPointerMove(pointerEv(g.x + 240, g.y + 110))
    advance(30, 16)
    props.onPointerUp(pointerEv(g.x + 420, g.y + 130))
    s.render()
    if (String(tag(s)).indexOf('被扔出去') < 0) bad('6.10 快速甩出后应进入物理（标签=被扔出去了），实际 = ' + tag(s))
    else ok('6.10 快速甩出 → 进入物理')
    advance(6000, 16)
    s.render()
    if (String(tag(s)).indexOf('被扔出去') >= 0) bad('6.10 6 秒后还在飞，物理没有收敛（会永久卡住）')
    else ok('6.10 物理会收敛，落回地面')
    const y1 = geomOf(s).y
    if (!(y1 > y0)) bad('6.10 应该被抛到更低的位置（落地），y ' + y0 + ' → ' + y1)
    else ok('6.10 落地了：y ' + y0 + ' → ' + y1)
    if (STORE['dsh-pet:pos'] === undefined) bad('6.10 落地后位置没写进 localStorage（刷新就丢）')
    else ok('6.10 落地位置已持久化')
  }

  /* ---- 6.11 连点会生气（门槛随机，先把骰子按住）---- */
  {
    const s = session()
    /* 假 rect 是 200x270，热区判定读的是它，不是真实 geom。
       Math.random()=0 → 门槛掷到最小值 3 */
    withRandom(0, () => {
      clickAt(s, 104, 138)
      advance(300, 50)
      clickAt(s, 104, 138)
      advance(300, 50)
      clickAt(s, 104, 138)
    })
    s.render()
    if (String(s.data()) !== 'angry') bad('6.11 连点三下应生气（angry），实际 = ' + s.data())
    else ok('6.11 连点三下 → 生气（门槛掷到 3）')
    if (String(bubbleText(s)) !== '别戳了！') bad('6.11 生气台词应为「别戳了！」，实际 = ' + bubbleText(s))
    else ok('6.11 生气台词 = 别戳了！')
  }

  /* ---- 6.12 分区反应：点头顶 vs 点脚 ---- */
  {
    const s = session()
    /* 假 rect 是 200x270：y=70 → 0.26（帽子），y=250 → 0.93（鞋） */
    clickAt(s, 104, 70)
    s.render()
    const head = String(s.data())
    if (head !== 'shy') bad('6.12 点头顶应为 shy，实际 = ' + head)
    else ok('6.12 点头顶 → shy（被摸头会害羞）')
    advance(5000, 200)
    clickAt(s, 104, 250)
    s.render()
    const tail = String(s.data())
    if (tail === 'shy') bad('6.12 点鞋的反应和点头顶一样，分区没生效')
    else ok('6.12 点鞋反应不同 → ' + tail)
  }

  /* ---- 6.13 分区反应的分界确实在动（别是常量） ----
     坐标必须落在 pointerEv 的假 rect（0,0,200,270）里：原来用 geomOf 的屏幕坐标
     会算出 x≈5.9，hitZone 判成没点中 → onPointerUp 直接 return，整条用例是空转的
     （它只断言"标签不是 null"，所以一直假绿）。 */
  {
    const s = session()
    clickAt(s, 104, 60)          // y/270 = 0.22 → 呆毛
    s.render()
    const head = String(tag(s))
    advance(5000, 200)
    s.render()
    clickAt(s, 104, 250)         // y/270 = 0.93 → 脚
    s.render()
    const body = String(tag(s))
    if (!head || head === 'null') bad('6.13 点头顶没反应')
    else if (body === head) bad('6.13 头顶和脚的反应一样（都是 ' + body + '），分区没生效')
    else ok('6.13 分区有分界：呆毛 = ' + head + ' / 脚 = ' + body)
  }

  /* ---- 6.32 生气的门槛是随机的，不是写死三次 ----
     写死 3 的下场：用户戳两下就知道"第三下必炸"，第三下就不再是"她生气了"，
     而是"我触发了那个开关"。 */
  {
    const s = session()
    /* Math.random()=0.999 → 门槛掷到最大值 6：点三下不该生气 */
    withRandom(0.999, () => {
      clickAt(s, 104, 138)
      advance(300, 50)
      clickAt(s, 104, 138)
      advance(300, 50)
      clickAt(s, 104, 138)
    })
    s.render()
    const three = String(s.data())
    if (three === 'angry') bad('6.32 门槛掷到 6 却第三下就生气，说明还是写死的')
    else ok('6.32 门槛掷到 6 时，第三下不生气（还是 ' + three + '）')
    /* 同一窗口内补到六下 —— 无论掷到几都该炸 */
    withRandom(0.999, () => {
      clickAt(s, 104, 138)
      advance(300, 50)
      clickAt(s, 104, 138)
      advance(300, 50)
      clickAt(s, 104, 138)
    })
    s.render()
    if (String(s.data()) !== 'angry') bad('6.32 累计六下应生气，实际 = ' + s.data())
    else ok('6.32 累计六下 → 生气（门槛落在 3~6 之间）')
  }

  /* ---- 6.33 分区够多：扫一遍网格，不同位置得给不同反应 ----
     只有三条横切线时，戳哪儿都差不多。这里在假 rect 上撒 96 个点，
     统计"能触发气泡"的位置各得到什么表情 / 什么台词。 */
  {
    const s = session()
    const exprs = {}
    const lines = {}
    for (let iy = 1; iy <= 12; iy += 1) {
      for (let ix = 1; ix <= 8; ix += 1) {
        clickAt(s, ix * 22, iy * 20)      // x 0.11~0.88，y 0.07~0.89
        s.render()
        const line = bubbleText(s)
        if (line) {
          exprs[String(s.data())] = (exprs[String(s.data())] || 0) + 1
          lines[line] = (lines[line] || 0) + 1
        }
        advance(2400, 400)                // 等手动表情和气泡过期，别串味
      }
    }
    const ek = Object.keys(exprs)
    const lk = Object.keys(lines)
    if (ek.length < 7) bad('6.33 96 个位置只给出 ' + ek.length + ' 种表情（' + ek.join('/') + '），分区还是太粗')
    else ok('6.33 分区有区分度：' + ek.length + ' 种表情 —— ' + ek.join('/'))
    if (lk.length < 8) bad('6.33 只有 ' + lk.length + ' 种台词，各分区该有自己的说法')
    else ok('6.33 台词也分开了：' + lk.length + ' 种')
  }

  /* ---- 6.14 长任务提醒看"间隔"而不是"taskSec 是否正是 15 的倍数" ----
     旧写法 `taskSec % 15 === 0` 几乎永不成立：taskSec 是渲染时按秒取整算的，
     而 1200ms 的 tick 会直接跨过恰好等于 15/30/45 的那一帧。
     这里把 taskSince 固定成「13 秒前开始」，于是 taskSec = 13 + 真实流逝秒数。
     提醒本身也从宠物气泡搬到仪表提示（.dshPetNote）——宠物不替 AI 报数。 */
  DIGEST = { intent: 'tool', tool: 'ops_bash', texts: [], error: false, taskSince: Date.now() - 13000 }
  {
    const s = session()
    await advanceAsync(600, 100)   // info 是异步轮询来的，必须先让微任务落地
    s.render()                     // 这一轮 effect 里 note()
    s.render()                     // note 改了 state，再渲染一次才看得见提示
    const b1 = String(noteTextOf(s))
    if (b1.indexOf('还在跑') < 0) bad('6.14 长任务超 12 秒应报一次耗时，实际 = ' + b1)
    else ok('6.14 长任务提醒 = ' + b1)

    /* 工具台词不该立刻盖掉刚说的那句（SAY_QUIET_MS 让位） */
    if (b1.indexOf('跑个命令') >= 0) bad('6.14 工具台词盖掉了长任务提醒')
    else ok('6.14 闲聊台词给长任务提醒让了位')

    /* 再走 6 秒（累计 19 秒）—— 离上次提醒才 6 秒，不该重复 */
    advance(6000, 200)
    s.render()
    const b2 = noteTextOf(s)
    if (b2 !== null) bad('6.14 间隔没到却重复提醒，实际 = ' + b2)
    else ok('6.14 间隔没到就不重复提醒')

    /* 再走 10 秒（累计 29 秒，距上次提醒 16 秒 > 15）—— 应该再报一次 */
    advance(10000, 200)
    s.render()
    s.render()
    const b3 = String(noteTextOf(s))
    if (b3.indexOf('还在跑') < 0) bad('6.14 超过 15 秒间隔后应再报一次，实际 = ' + b3)
    else ok('6.14 隔够 15 秒再报一次 = ' + b3)
  }

  /* ---- 6.15 上下文提醒有冷却，不会 info 一变就复读 ---- */
  DIGEST = { intent: 'idle', texts: [], tool: '', error: false, meter: { pct: 0.92, used: 920, limit: 1000 } }
  {
    const s = session()
    await advanceAsync(1500, 250)
    s.render()                     // info 到位 → 排下 260ms 的告警定时器
    advance(600, 100)
    s.render()
    const first = String(noteTextOf(s))
    if (!/快满/.test(first)) bad('6.15 高压应有仪表提醒，实际 = ' + first)
    else ok('6.15 高压提醒 = ' + first)

    /* 让提示过期，然后在冷却期（60s）内反复抖 info → 不该再喊 */
    advance(5000, 200)
    s.render()
    let repeated = 0
    for (let i = 0; i < 5; i++) {
      DIGEST = Object.assign({}, DIGEST, { tool: 'ops_bash', intent: i % 2 ? 'tool' : 'idle' })
      await advanceAsync(1600, 250)
      s.render()
      advance(600, 100)
      s.render()
      const b = noteTextOf(s)
      if (b !== null && /快满/.test(String(b))) repeated += 1
    }
    if (repeated > 0) bad('6.15 冷却期内又重复告警了 ' + repeated + ' 次')
    else ok('6.15 冷却期（60 秒）内不重复告警')
  }

  /* ---- 6.16 贴着左边缘往左拖，不能被推到视口外（否则永久消失） ---- */
  {
    /* 先让存档把它放在最左边：游走 45 秒后本来就会挪到这儿 */
    STORE['dsh-pet:pos'] = JSON.stringify({ x: 0, y: 100 })
    const s = session()
    const g0 = geomOf(s)
    const props = s.root().props
    props.onPointerDown(pointerEv(g0.x + 100, g0.y + 100))
    advance(200, 16)                                        // 慢拖，确保走"原地放下"分支
    props.onPointerMove(pointerEv(g0.x + 100 - 400, g0.y + 100))
    advance(200, 16)
    props.onPointerUp(pointerEv(g0.x + 100 - 400, g0.y + 100))
    s.render()

    const a = geomOf(s)
    const vw = global.window.innerWidth
    const visibleW = Math.min(a.x + a.w, vw) - Math.max(a.x, 0)
    if (visibleW < 60) {
      bad('6.16 往左拖出视口后只剩 ' + Math.round(visibleW) + 'px 可见（x=' + Math.round(a.x) +
          '）—— 桌宠会彻底消失且无法点回来')
    } else {
      ok('6.16 拖到最左仍留 ' + Math.round(visibleW) + 'px 可见（x=' + Math.round(a.x) + '）')
    }
    delete STORE['dsh-pet:pos']
  }

  /* ---- 6.17 存档里的越界坐标，加载时必须夹回可见范围 ---- */
  {
    STORE['dsh-pet:pos'] = JSON.stringify({ x: -5000, y: -300 })
    const s = session()
    const a = geomOf(s)
    const vw = global.window.innerWidth
    const visibleW = Math.min(a.x + a.w, vw) - Math.max(a.x, 0)
    if (visibleW < 60) bad('6.17 越界存档没被夹回来，可见宽度 ' + Math.round(visibleW) + 'px')
    else ok('6.17 越界存档已夹回：可见 ' + Math.round(visibleW) + 'px（x=' + Math.round(a.x) + '）')
    if (a.y < 0) bad('6.17 y 仍是负的（' + Math.round(a.y) + '），桌宠跑到视口上方去了')
    else ok('6.17 y 也夹回视口内（y=' + Math.round(a.y) + '）')
    delete STORE['dsh-pet:pos']
  }

  /* ---- 6.18 窗口变小后桌宠被拉回可见范围 ---- */
  {
    STORE['dsh-pet:pos'] = JSON.stringify({ x: 1200, y: 100 })
    const s = session()
    global.window.innerWidth = 700                  // 缩小窗口
    dispatch('resize', {})
    s.render()
    const a = geomOf(s)
    const visibleW = Math.min(a.x + a.w, 700) - Math.max(a.x, 0)
    if (visibleW < 60) bad('6.18 窗口从 1440 缩到 700 后桌宠看不见了（x=' + Math.round(a.x) + '）')
    else ok('6.18 窗口缩小后拉回可见：x 1200 → ' + Math.round(a.x))
    global.window.innerWidth = 1440
    delete STORE['dsh-pet:pos']
  }

  /* ---- 6.19 「甩得越快越甩不出去」的回归 ----
     这是用户实机报的 bug。旧 releaseVelocity 把"窗口内最早的样本"当终点，
     基准点又是窗口外那一个；**所有样本都落在 VEL_WINDOW(110ms) 内**时基准点
     退化成同一个点，位移恒为 0，速度永远是 0 —— 快速一甩必然甩不动。
     所以这条必须让整个拖动短于 110ms，否则测不到那个分支。 */
  {
    const s = session()
    const g = geomOf(s)
    const props = s.root().props
    props.onPointerDown(pointerEv(g.x + 100, g.y + 100))
    advance(30, 16)
    props.onPointerMove(pointerEv(g.x + 220, g.y + 110))
    advance(30, 16)                                   // down→up 全程 60ms < 110ms
    props.onPointerUp(pointerEv(g.x + 340, g.y + 120))
    s.render()
    if (String(tag(s)).indexOf('被扔出去') < 0) {
      bad('6.19 60ms 内甩出去却没进物理（甩得越快越甩不出去），实际 = ' + tag(s))
    } else ok('6.19 短促快甩也能甩出去（所有样本都在速度窗口内）')
  }

  /* ---- 6.20 反过来：拖到位、停一下、再松手 = 轻轻放下，不该飞 ---- */
  {
    const s = session()
    const g = geomOf(s)
    const props = s.root().props
    props.onPointerDown(pointerEv(g.x + 100, g.y + 100))
    advance(30, 16)
    props.onPointerMove(pointerEv(g.x + 300, g.y + 110))
    advance(220, 16)                                  // 停下不动 > VEL_GRACE_MS(60)
    props.onPointerUp(pointerEv(g.x + 300, g.y + 110))
    s.render()
    if (String(tag(s)).indexOf('被扔出去') >= 0) {
      bad('6.20 停手后松手不该被判成抛掷，实际 = ' + tag(s))
    } else ok('6.20 停手再松开 = 原地放下，不会飞')
  }

  /* ---- 6.21 AI 正在干活时，鼠标慢慢靠近也必须露出"抬头看你" ----
     这是分离之前最典型的事故：nearExpr 排在"AI 表情"后面，而我思考/跑工具时
     AI 状态长期有效，靠近就被永久压住。现在脸上没有 AI 的申请者了 ——
     这条用例守的是"即使 AI 正在忙，鼠标互动照样立刻生效"。 */
  DIGEST = { intent: 'tool', tool: 'ops_bash', error: false, texts: [] }
  {
    const s = session()
    await advanceAsync(1500, 250)
    s.render()
    if (aiStateOf(s.el) !== 'tool') {
      // 先确认"AI 确实在干活"这个前提成立，否则这条用例是空转的
      bad('6.21 前置条件不成立：AI 干活时仪表应为 tool，实际 = ' + aiStateOf(s.el))
    } else {
      advanceRendered(s, 2400, 400)          // 先真的进入忙模式，否则这条用例是空转的
      if (String(s.data()) !== 'calling') {
        bad('6.21 前置条件不成立：忙模式下静息脸应是 calling，实际 = ' + s.data())
      } else {
        const g = geomOf(s)
        const cx = g.x + g.w * 0.5
        const cy = g.y + g.h * 0.5
        dispatch('pointermove', { clientX: cx + 600, clientY: cy })
        advanceRendered(s, 500, 100)
        dispatch('pointermove', { clientX: cx + 60, clientY: cy })
        advanceRendered(s, 500, 100)
        s.render()
        /* 忙模式下静息脸也是 calling，所以只断言表情是**测不出**谁赢的 ——
           必须看标签：说"看你"才算宠物自己的互动赢了，说"AI 在忙"就是被压住了。 */
        if (String(tag(s)).indexOf('看你') < 0) {
          bad('6.21 AI 干活时靠近被压住了，表情 = ' + s.data() + '，标签 = ' + tag(s))
        } else ok('6.21 忙模式下靠近照样优先 = ' + tag(s))
        if (String(bubbleText(s)).length === 0) bad('6.21 靠近没有任何气泡反馈')
        else ok('6.21 靠近有气泡 = ' + bubbleText(s))
      }
    }
  }

  /* ---- 6.22 游走不是"平移"：位移期间 .dshPetAct 上必须有循环踏步动画 ---- */
  DIGEST = null
  {
    const s = session()
    const before = ANIM_LOG.length
    advance(46000, 50)                                // 越过 WANDER_AFTER_MS(45000)
    s.render()
    const walked = ANIM_LOG.slice(before).filter((e) =>
      String(e.cls).indexOf('dshPetAct') >= 0
      && e.kf && e.kf.length >= 3
      && e.opts && e.opts.iterations >= 1)            // 循环动画才有 iterations
    if (!walked.length) bad('6.22 游走时 .dshPetAct 上没有循环踏步动画（看起来就是平移）')
    else ok('6.22 游走时有踏步动画：iterations = ' + walked[0].opts.iterations)
  }

  /* ---- 6.23 睡觉是"打盹"，不是一睡不醒 ----
     睡着的分支会 return，如果没人来叫醒就永远躺着 —— 游走和所有小动作
     再也出不来，用户就会"经常见不到揉眼睛、散步"。 */
  DIGEST = null
  {
    const s = session()
    advance(93000, 100)                                  // 越过 SLEEP_AFTER_MS(90000)
    s.render()
    if (String(s.data()) !== 'sleeping') bad('6.23 前置不成立：闲置 93 秒还没睡，实际 = ' + s.data())
    else ok('6.23 闲置 93 秒后睡着（前置条件）')

    advance(40000, 100)                                  // 一觉最长 SLEEP_NAP_MAX_MS(30000)
    s.render()
    if (String(s.data()) === 'sleeping') bad('6.23 睡下 40 秒还没自己醒：其他动作被永久挡住')
    else ok('6.23 无人干涉也会自己醒（睡下 40 秒内已醒）')

    /* 醒来后得能接着活动，而不是立刻又睡回去 */
    const before = ANIM_LOG.length
    advanceRendered(s, 46000)
    const did = ANIM_LOG.slice(before).filter((e) =>
      String(e.cls).indexOf('dshPetAct') >= 0 && e.opts && !e.opts.iterations)
    if (!did.length) bad('6.23 醒来后 46 秒内一次小动作都没有')
    else {
      ok('6.23 醒来后继续活动：46 秒内 ' + did.length + ' 次小动作，'
        + new Set(did.map((e) => JSON.stringify(e.kf))).size + ' 种')
    }
  }

  /* ---- 6.24 小动作走"洗牌袋"，不是纯随机 ----
     纯 random 很容易连着抽到同一个（三次歪头），看起来就"来来回回那么两下"。
     这里每 40 秒碰一下桌宠，把 idleFor 压在 WANDER_AFTER_MS 以内，
     这样不睡、不游走，ANIM_LOG 里记到的全是袋子里抽出来的小动作。 */
  DIGEST = null
  {
    const s = session()
    const before = ANIM_LOG.length
    for (let i = 0; i < 11; i++) {
      advance(40000, 100)
      s.render()

      /* 坐标要落在 pointerEv 里那个固定 rect（0,0,200,270）内，
         直接用 geomOf 的屏幕坐标会让 hitZone 判成没点中 → touch() 不执行
         → idleFor 一路涨到 90 秒，桌宠照样睡过去。 */
      clickAt(s, 104, 70)
    }
    const seq = ANIM_LOG.slice(before)
      .filter((e) => String(e.cls).indexOf('dshPetAct') >= 0
        && e.opts && !e.opts.iterations && e.kf && e.kf.length >= 3)
      .map((e) => JSON.stringify(e.kf))
    if (seq.length < 8) {
      bad('6.24 只采到 ' + seq.length + ' 次小动作，不足以验证洗牌袋')
    } else {
      const uniq = new Set(seq.slice(0, 8))
      if (uniq.size < 8) bad('6.24 前 8 次小动作只有 ' + uniq.size + ' 种（没洗牌，会连着重复）')
      else ok('6.24 洗牌袋生效：前 8 次小动作各不相同')
    }
  }

  /* ---- 6.25 抛出去之后是"越落越快"，不是匀速下落 ----
     用户实机反馈：「抛出后下落的速度有点不符合物理规律，不应该是匀速的」。
     根因是竖直方向也乘了空气阻尼 —— 重力 + 线性阻尼 = 终端速度，而在这个尺度上
     几百毫秒就饱和，于是看起来是匀速平移下落。

     判据不看位移绝对值（那会随 GRAVITY 调参而失效），只看**每帧速度增量**：
     还在自由下落时，速度必须线性增长，每帧涨 g·dt²；被阻尼吃掉时它会一路衰减到 0。
     所以要观察的是**后半程**的增量，而不是首末帧的比值（旧代码前半程照样在加速）。 */
  DIGEST = null
  {
    const gv = Number((/const GRAVITY = ([0-9.]+)/.exec(SOURCE) || [])[1])
    const s = session()
    const g = geomOf(s)
    const props = s.root().props
    props.onPointerDown(pointerEv(g.x + 100, g.y + 60))
    advance(30, 16)
    props.onPointerMove(pointerEv(g.x + 260, g.y + 60))   // 纯水平甩出：竖直初速为 0
    advance(30, 16)
    props.onPointerUp(pointerEv(g.x + 420, g.y + 60))
    s.render()

    const ys = []
    for (let i = 0; i < 30; i++) { advance(16, 16); s.render(); ys.push(geomOf(s).y) }
    const d1 = []
    for (let i = 1; i < ys.length; i++) d1.push(ys[i] - ys[i - 1])
    const d2 = []
    for (let i = 1; i < d1.length; i++) d2.push(d1[i] - d1[i - 1])

    const want = gv * 16 * 16                       // 自由落体每帧该涨这么多 px
    const tail = d2.slice(Math.floor(d2.length / 2)) // 只看后半程
    const hit = tail.filter((v) => v >= want * 0.8).length
    if (!(gv > 0)) bad('6.25 没能从源码里读出 GRAVITY')
    else if (hit < tail.length * 0.8) {
      bad('6.25 下落不是加速的：后半程每帧增速 ' + tail.map((v) => v.toFixed(2)).join('/')
        + '，应约等于 g·dt² = ' + want.toFixed(2) + '（匀速下落时这个值趋近 0）')
    } else {
      const total = ys[ys.length - 1] - ys[0]
      ok('6.25 下落持续加速：30 帧落下 ' + total.toFixed(0) + 'px，'
        + tail.length + ' 帧的每帧增速都约等于 g·dt²(' + want.toFixed(2) + ')')
    }
  }

  /* ---- 6.26 静息脸不再有节拍器 ----
     用户原话：「桌宠现在更像是生硬的每四秒钟切换一次表情」。
     根因是 exprFor(frame)：拿"开机了多少个 2600ms"去池子里轮换 sleepy/calm/shy/happy。
     **一个没有原因的表情变化，看起来就是机械的。**

     判据不看"脸变没变"（小动作、靠近、睡觉都该让它变），而看**变得有没有原因**：
     标签的 source 段（" · " 后面那截）说的是"宠物自己在干什么"。如果 source 一直是
     "待机"而脸却变了，那就是没有原因的变化。 */
  DIGEST = null
  {
    const s = session()
    await advanceAsync(1500, 250)
    s.render()
    const srcOf = (x) => {
      const t = String(tag(x))
      const i = t.lastIndexOf(' · ')
      return i < 0 ? t : t.slice(i + 3)
    }
    let prevData = String(s.data())
    let prevSrc = srcOf(s)
    const flips = []
    for (let i = 0; i < 120; i++) {          // 120 × 1.5 秒 = 3 分钟
      advanceRendered(s, 1500, 500)
      const d = String(s.data())
      const src = srcOf(s)
      if (d !== prevData && src === prevSrc && src === '待机') {
        flips.push(prevData + '→' + d)
      }
      prevData = d
      prevSrc = src
    }
    if (flips.length) {
      bad('6.26 静息时脸自己变了 ' + flips.length + ' 次：' + flips.slice(0, 4).join('、')
        + '（没有原因的表情变化 = 机械感）')
    } else {
      ok('6.26 3 分钟静置：脸一次都没"没原因地"变过（节拍器已拆）')
    }
  }

  /* ---- 6.27 忙满驻留时间才把脸交出去 ----
     AI 是间歇性忙的（调一次工具、想两秒、再调一次）。没有驻留时间，脸会在
     "她"和"仪表"之间来回跳，比节拍器还难看。 */
  DIGEST = { intent: 'tool', tool: 'ops_bash', texts: [], error: false }
  {
    const s = session()
    await advanceAsync(1500, 250)
    s.render()                                 // 这一帧 want 翻转，驻留计时从这里开始
    if (faceOf(s) !== 'pet') bad('6.27 刚忙起来就把脸交出去了，实际 = ' + faceOf(s))
    else ok('6.27 刚忙起来不抢脸（face = ' + faceOf(s) + '，表情 = ' + s.data() + '）')

    advanceRendered(s, 800, 400)               // 驻留还没满 FACE_BUSY_DELAY_MS
    if (faceOf(s) !== 'pet') bad('6.27 驻留没满就换脸了，实际 = ' + faceOf(s))
    else ok('6.27 驻留未满，脸没被抢走 = ' + faceOf(s))

    advanceRendered(s, 1600, 400)              // 累计越过 1500ms
    if (faceOf(s) !== 'ai') bad('6.27 忙满驻留后脸没交给 AI，实际 = ' + faceOf(s))
    else ok('6.27 忙满 1.5 秒后脸交给 AI（face = ' + faceOf(s) + '，表情 = ' + s.data() + '）')
    if (String(tag(s)).indexOf('AI 在忙') < 0) bad('6.27 没说清现在脸归谁，标签 = ' + tag(s))
    else ok('6.27 标签写明现在归谁 = ' + tag(s))
  }

  /* ---- 6.28 闲满驻留时间才把脸收回来 ---- */
  DIGEST = { intent: 'tool', tool: 'ops_bash', texts: [], error: false }
  {
    const s = session()
    await advanceAsync(1500, 250)
    s.render()
    advanceRendered(s, 2400, 400)
    if (faceOf(s) !== 'ai') {
      bad('6.28 前置不成立：没能进入忙模式，实际 = ' + faceOf(s))
    } else {
      DIGEST = { intent: 'idle', texts: [], tool: '', error: false }
      await advanceAsync(1500, 250)
      s.render()                               // want 翻回，计时重置
      if (faceOf(s) !== 'ai') bad('6.28 刚闲下来就把脸收回了，实际 = ' + faceOf(s))
      else ok('6.28 刚闲下来脸没收（不抖），表情仍是 ' + s.data())

      advanceRendered(s, 2000, 400)            // 还没满 FACE_REST_DELAY_MS
      if (faceOf(s) !== 'ai') bad('6.28 闲不满 4 秒就收回了，实际 = ' + faceOf(s))
      else ok('6.28 闲不满 4 秒仍没收 = ' + faceOf(s))

      advanceRendered(s, 3000, 400)            // 累计越过 4000ms
      if (faceOf(s) !== 'pet') bad('6.28 闲满 4 秒后脸没收回来，实际 = ' + faceOf(s))
      else ok('6.28 闲满 4 秒收回静息脸（face = ' + faceOf(s) + '，表情 = ' + s.data() + '）')
      if (String(tag(s)).indexOf('AI 在忙') >= 0) bad('6.28 收回后标签还写着 AI 在忙 = ' + tag(s))
      else ok('6.28 收回后标签回到宠物自己 = ' + tag(s))
    }
  }

  /* ---- 6.29 忙模式下，宠物自己的状态照样优先 ----
     用户在两种模式下都该优先的那几个申请者里，睡觉是最容易被"AI 在忙"压住的
     （它要等 90 秒才发生，而 AI 那 90 秒一直在干活）。 */
  DIGEST = { intent: 'tool', tool: 'ops_bash', texts: [], error: false }
  {
    const s = session()
    await advanceAsync(1500, 250)
    s.render()
    advanceRendered(s, 2400, 400)
    if (faceOf(s) !== 'ai') {
      bad('6.29 前置不成立：没能进入忙模式，实际 = ' + faceOf(s))
    } else {
      advanceRendered(s, 94000, 1000)          // 一直没被摸过
      if (String(s.data()) !== 'sleeping') {
        bad('6.29 AI 一直忙就睡不着了，实际 = ' + s.data() + '，标签 = ' + tag(s))
      } else ok('6.29 AI 全程在忙，她照样打盹 = ' + s.data())
    }
  }

  /* ---- 6.30 气泡是"漫画气泡"，不是一块圆角半透明板子 ----
     长相测不了，但"这套样式在不在"能测：纸面 + 墨线 + 一个真的尖尾巴。
     尾巴是 ::after 画的（一个转 45° 的方块），所以只能在 CSS 文本上断言。 */
  {
    const css = SOURCE
    const tail = /\.dshPetBubble::after \{[^}]*\}/.exec(css)
    if (!tail) bad('6.30 气泡没有尾巴（::after 那一条找不到）')
    else {
      const t = tail[0]
      if (!/transform:\s*rotate\(45deg\)/.test(t)) bad('6.30 尾巴不是那个转 45° 的方块')
      else if (!/border-right:\s*2px solid var\(--dshPetInk\)/.test(t) ||
               !/border-bottom:\s*2px solid var\(--dshPetInk\)/.test(t)) {
        bad('6.30 尾巴没有墨线描边（只有纸面，看着像掉了一块）')
      } else if (!/background:\s*var\(--dshPetPaper\)/.test(t)) {
        bad('6.30 尾巴不是纸面色，和气泡对不上')
      } else ok('6.30 气泡有描边尾巴（转 45° 的方块 + 右下两条墨线）')
    }

    const base = /\.dshPetBubble \{[^}]*\}/.exec(css)
    if (!base) bad('6.30 找不到 .dshPetBubble 的样式')
    else {
      const b = base[0]
      if (!/border:\s*2px solid var\(--dshPetInk\)/.test(b)) bad('6.30 气泡没有粗墨线描边')
      else if (!/background:\s*var\(--dshPetPaper\)/.test(b)) bad('6.30 气泡不是纸面底')
      else if (!/--dshPetTilt:/.test(b)) bad('6.30 没有 --dshPetTilt，动画收尾会弹一下')
      else ok('6.30 气泡是纸面 + 2px 墨线 + 可调倾角')
    }

    /* 收尾的 transform 必须和 keyframes 的 100% 用同一个变量，否则动画播完会跳 */
    if (!/100% \{ opacity: 1; transform: translate\(-50%, 0px\) scale\(1\) rotate\(var\(--dshPetTilt\)\)/.test(css)) {
      bad('6.30 keyframes 的收尾和气泡的静息 transform 不一致（会有跳变）')
    } else if (!/transform: "translateX\(-50%\) rotate\(var\(--dshPetTilt\)\)"/.test(css)) {
      bad('6.30 气泡静息 transform 没跟着倾斜变量走')
    } else ok('6.30 静息角度和动画收尾是同一个变量（不会弹）')

    if (!/cubic-bezier\(\.34, 1\.46, \.64, 1\)/.test(css)) bad('6.30 气泡入场没有过冲，弹不出来')
    else ok('6.30 入场是过冲曲线（先大一下再收回）')
  }

  /* ---- 6.31 气泡按情绪换花样：大声 / 犯困 / 普通 ---- */
  {
    /* 普通：靠近时说"看你~"，此时是呼喊脸 */
    const s = session()
    advanceRendered(s, 300, 100)
    const g = geomOf(s)
    const cx = g.x + g.w * 0.5
    const cy = g.y + g.h * 0.5
    dispatch('pointermove', { clientX: cx + 600, clientY: cy })
    advanceRendered(s, 500, 100)
    dispatch('pointermove', { clientX: cx + 60, clientY: cy })
    advanceRendered(s, 500, 100)
    s.render()
    if (bubbleText(s) === null) bad('6.31 前置不成立：靠近没出气泡')
    else if (bubbleKindOf(s) !== 'say') bad('6.31 普通说话该是 say，实际 = ' + bubbleKindOf(s))
    else ok('6.31 靠近是普通气泡（kind = ' + bubbleKindOf(s) + '，台词 = ' + bubbleText(s) + '）')

    if (byClass(s.el, 'dshPetBubbleShout').length !== 0) bad('6.31 普通气泡上挂了 Shout 类')
    else ok('6.31 普通气泡没挂大声配色')
  }

  {
    /* 大声：连点三次 -> 生气 -> "别戳了！" */
    const s = session()
    /* 假 rect 是 200x270，热区判定读的是它，不是真实 geom。
       门槛随机，按住骰子让它掷到 3，这条用例才可重复 */
    withRandom(0, () => {
      clickAt(s, 104, 138)
      advance(300, 50)
      clickAt(s, 104, 138)
      advance(300, 50)
      clickAt(s, 104, 138)
    })
    s.render()
    if (String(bubbleText(s)) !== '别戳了！') bad('6.31 前置不成立：连点没生气，气泡 = ' + bubbleText(s))
    else if (bubbleKindOf(s) !== 'shout') bad('6.31 生气该用大声气泡，实际 = ' + bubbleKindOf(s))
    else if (byClass(s.el, 'dshPetBubbleShout').length !== 1) bad('6.31 大声配色类没挂上')
    else ok('6.31 生气换成大声气泡（kind = ' + bubbleKindOf(s) + '，台词 = ' + bubbleText(s) + '）')
  }

  {
    /* 犯困：闲置到打出哈欠为止（哈欠自带 sleepy 表情 + 台词「哈啊……」） */
    const s = session()
    let kind = null
    let seen = null
    for (let i = 0; i < 60; i += 1) {
      advanceRendered(s, 1500, 500)
      const t = bubbleText(s)
      if (t !== null && bubbleKindOf(s) === 'soft') { kind = 'soft'; seen = t; break }
      if (t !== null && seen === null) seen = t
    }
    if (kind !== 'soft') bad('6.31 一直没等到犯困气泡，最后看到的是 = ' + seen + ' / ' + bubbleKindOf(s))
    else ok('6.31 犯困/害羞换成软气泡（台词 = ' + seen + '）')
  }

  /* ---- 6.44 生气会换台词：第一句锁死「别戳了！」，之后每生气一次换一句 ----
     台词池用计数器取下标（第一次必然是 0），所以 6.11 / 6.31 认的那句永远不变，
     换花样只发生在第二轮之后。旧写法是写死 say("别戳了！")，戳多少轮都同一句。 */
  {
    const s = session()
    const shouts = []
    withRandom(0, () => {
      for (let round = 0; round < 3; round += 1) {
        advance(2200, 400)              // 先等上一轮气泡过期，免得读到旧的那句
        clickAt(s, 104, 138)
        advance(300, 50)
        clickAt(s, 104, 138)
        advance(300, 50)
        clickAt(s, 104, 138)
        s.render()
        shouts.push(String(bubbleText(s)))
      }
    })
    if (shouts[0] !== '别戳了！') bad('6.44 第一轮生气应是「别戳了！」，实际 = ' + shouts[0])
    else if (shouts[1] === shouts[0]) bad('6.44 第二轮生气还是同一句「' + shouts[1] + '」，ANGRY_LINES 没接上')
    else if (shouts[2] === shouts[1]) bad('6.44 第三轮又撞回上一句「' + shouts[2] + '」')
    else ok('6.44 生气每轮换一句：' + shouts.join(' → '))
  }

  /* ---- 6.45 被吓第二次要换句（第一次永远是「！」，6.8 认那句）---- */
  {
    const s = session()
    const g = geomOf(s)
    const cx = g.x + g.w * 0.5
    const cy = g.y + g.h * 0.5
    const seen = []
    for (let i = 0; i < 2; i += 1) {
      dispatch('pointermove', { clientX: cx + 500, clientY: cy })   // 先退到远处
      advance(60, 20)
      dispatch('pointermove', { clientX: cx, clientY: cy })         // 再快速掠过
      s.render()
      seen.push(String(bubbleText(s)))
      if (i === 0) advance(5000, 100)     // 等过 STARTLE_COOLDOWN_MS(4500)
    }
    if (seen[0] !== '！') bad('6.45 第一次吓一跳应冒「！」，实际 = ' + seen[0])
    else if (seen[1] === 'null') bad('6.45 第二次没被吓到（冷却没到或速度不够）')
    else if (seen[1] === '！') bad('6.45 第二次吓一跳还是「！」，STARTLE_LINES 没接上')
    else ok('6.45 吓一跳换句：' + seen[0] + ' → ' + seen[1])
  }

  /* ---- 6.46 台词池体检：池内不重复、不空、不超长、池子不能太短 ----
     台词是 pick() 取模选词：池里有重复项等于白占一个坑，用户会连着看到同一句；
     池子太短，相邻两次点必然撞同一句；太长的一句会把单行气泡撑成两行。
     这些池子是模块内部常量，行为测试够不到，所以直接扫源码（SOURCE）。
     注意只查**池内**重复：左右蝴蝶结、左右手故意共用一套词，跨池重复是设计。 */
  {
    const span = (text, at) => {
      const start = text.slice(at).search(/[[{]/)
      if (start < 0) return ''
      let d = 0
      for (let i = at + start; i < text.length; i += 1) {
        const ch = text[i]
        if (ch === '[' || ch === '{') d += 1
        else if (ch === ']' || ch === '}') { d -= 1; if (d === 0) return text.slice(at + start, i + 1) }
      }
      return ''
    }
    const stringsOf = (t) => (t.match(/"[^"]*"/g) || []).map((x) => x.slice(1, -1))
    const problems = []
    const check = (name, arr) => {
      const dup = arr.filter((x, i) => arr.indexOf(x) !== i)
      if (dup.length) problems.push(name + ' 里有重复台词：' + dup.join(' / '))
      if (arr.length < 6) problems.push(name + ' 只有 ' + arr.length + ' 句，连点必然撞同一句')
      arr.forEach((x) => {
        if (!x.trim()) problems.push(name + ' 里有空台词')
        else if (x.length > 14) problems.push(name + ' 的「' + x + '」有 ' + x.length + ' 字，单行气泡会被撑成两行')
      })
      return arr.length
    }
    const POOLS = ['CLICK_LINES', 'BORED_LINES', 'WAKE_LINES', 'FLY_LINES',
      'LAND_LINES', 'NEAR_LINES', 'AWAY_LINES', 'STARTLE_LINES', 'ANGRY_LINES']
    let total = 0
    POOLS.forEach((n) => {
      const at = SOURCE.indexOf('const ' + n + ' =')
      if (at < 0) { problems.push('源码里找不到 ' + n); return }
      total += check(n, stringsOf(span(SOURCE, at)))
    })
    const zoneBlock = span(SOURCE, SOURCE.indexOf('const ZONES ='))
    const zones = zoneBlock.split('{ id: "').slice(1)
    if (zones.length < 10) problems.push('只解析出 ' + zones.length + ' 个分区，源码结构变了')
    zones.forEach((chunk) => {
      const id = chunk.slice(0, chunk.indexOf('"'))
      const ls = chunk.indexOf('lines:')
      if (ls < 0) { problems.push('分区 ' + id + ' 没有 lines'); return }
      total += check('ZONES.' + id, stringsOf(span(chunk, ls)))
    })
    const fbAt = SOURCE.indexOf('const ZONE_FALLBACK =')
    total += check('ZONE_FALLBACK', stringsOf(span(SOURCE, SOURCE.indexOf('lines:', fbAt))))
    if (problems.length) bad('6.46 台词池有问题：\n    - ' + problems.join('\n    - '))
    else ok('6.46 台词池体检通过：' + (POOLS.length + zones.length + 1) + ' 个池子 / ' + total + ' 句，无重复、无空句、每句 ≤14 字')
  }

  console.log('')
  /* hook 槽位数必须恒定，否则 React #311（条目会被永久退位，界面直接空白） */
  console.log('  Pet 组件的 hook 槽位数 = ' + petLoaded.react.__hooks.cursor + '（现在是 58）')
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
})().catch((err) => {
  console.log('  FAIL  行为测试段自身抛错: ' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
