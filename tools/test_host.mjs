#!/usr/bin/env node
/**
 * 宿主半边（lib/index.js）的单元测试。
 *
 * 为什么需要它：宿主代码改了必须重启 DSH 才生效，而"重启一次"对用户是实打实的成本
 * （重启会打断正在跑的会话）。所以 ⑧ 的三项数据联动不能靠"重启完再看"来验证 ——
 * 这里 fake 一个 ctx 把路由处理器直接调起来，在 Node 里把 sessionDigest() 的每个
 * 输出字段算一遍。重启前就能确定宿主逻辑是对的。
 *
 * 用法：node test_host.mjs
 */

import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

/* 默认测仓库里这份；想测"正在运行的那份插件"，用 DSH_PET_LIB=... 指过去。 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB = process.env.DSH_PET_LIB || path.join(ROOT, 'lib', 'index.js')
const mod = await import(pathToFileURL(LIB).href)

let failures = 0
const ok = (t) => console.log('  \x1b[32mPASS\x1b[0m  ' + t)
const bad = (t) => { failures += 1; console.log('  \x1b[31mFAIL\x1b[0m  ' + t) }
const eq = (actual, want, t) => (JSON.stringify(actual) === JSON.stringify(want)
  ? ok(t)
  : bad(t + '\n         期望 ' + JSON.stringify(want) + '\n         实际 ' + JSON.stringify(actual)))
const truthy = (v, t) => (v ? ok(t) : bad(t + '（实际 ' + JSON.stringify(v) + '）'))

/* ---------------- 假 ctx / 假 req / 假 res ---------------- */

function mount(opts = {}) {
  let handler = null
  let disposed = 0
  const ctx = {
    logger: { warn() {}, info() {} },
    webServer: { register(cfg) { handler = cfg.handler; return () => { disposed += 1 } } },
    effect(fn) { void fn },
    get(name) {
      if (name === 'sessions') return 'sessions' in opts ? opts.sessions : null
      if (name === 'tokenMeter') return 'tokenMeter' in opts ? opts.tokenMeter : null
      return null
    },
  }
  mod.apply(ctx)
  if (!handler) throw new Error('apply() 没有注册路由处理器')
  return { handler, disposedCount: () => disposed }
}

async function call(handler, url) {
  let code = 0, headers = {}, body = null
  const res = {
    writeHead(c, h) { code = c; headers = h || {} },
    end(b) { body = b },
  }
  await handler({ url, method: 'GET' }, res)
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
  let json = null
  try { json = JSON.parse(text) } catch (err) { json = null }
  return { code, headers, body, json }
}

const NOW = Date.now()
const at = (msAgo) => NOW - msAgo

function ev(type, msAgo, data) { return { type, time: at(msAgo), data: data || {} } }

function fakeSession(o = {}) {
  return {
    id: o.id || 'sess-1',
    seq: o.seq === undefined ? 1 : o.seq,
    snapshotEvents: () => o.events || [],
    deriveMessages: () => o.messages || [],
    requestContext: () => ('context' in o ? o.context : { contextWindow: 1000000, provider: 'p', model: 'm' }),
  }
}

const sessionsOf = (list) => ({ list: () => list })

async function mind(opts) {
  const { handler } = mount(opts)
  const r = await call(handler, '/dsh-pet/__mind')
  return r.json
}

const TODO_ARGS = JSON.stringify({
  todos: [
    { status: 'completed' }, { status: 'completed' }, { status: 'completed' },
    { status: 'in_progress' }, { status: 'pending' }, { status: 'pending' },
    { status: 'pending' }, { status: 'pending' }, { status: 'pending' }, { status: 'pending' },
  ],
})

console.log('\n== H1. 路由注册与素材下发 ==')
{
  const { handler, disposedCount } = mount({})
  const probe = await call(handler, '/dsh-pet/')
  eq(probe.code, 200, 'H1 探针 200')
  const sprites = probe.json.sprites
  truthy(Array.isArray(sprites) && sprites.length === 13, 'H1 探针登记 13 张素材（实际 ' + (sprites || []).length + '）')
  truthy(sprites.includes('drag'), 'H1 白名单含 drag（漏登记会静默 404，拖拽表情纹丝不动）')

  const png = await call(handler, '/dsh-pet/sprite/happy.png?v=7')
  eq(png.code, 200, 'H1 取 happy.png 200')
  eq(png.headers['Content-Type'], 'image/png', 'H1 Content-Type 是 image/png')
  eq(png.headers['Cache-Control'], 'no-cache', 'H1 必须 no-cache（长缓存会导致换素材后界面不变）')
  truthy(png.body.length > 1000, 'H1 真的读到了 PNG 字节（' + png.body.length + ' 字节）')
  eq(png.body[0], 0x89, 'H1 是 PNG 魔数开头')
  void disposedCount
}

console.log('\n== H2. 素材白名单与路径穿越 ==')
{
  const { handler } = mount({})
  for (const bad_url of [
    '/dsh-pet/sprite/nope.png',
    '/dsh-pet/sprite/../../package.json.png',
    '/dsh-pet/sprite/__proto__.png',
    '/dsh-pet/sprite/constructor.png',
    '/dsh-pet/sprite/happy.txt',
  ]) {
    const r = await call(handler, bad_url)
    if (r.code === 404) ok('H2 ' + bad_url + ' → 404')
    else bad('H2 ' + bad_url + ' 竟然返回 ' + r.code + '（白名单被绕过了）')
  }
}

console.log('\n== H3. ⑧ 长任务进度：从 todo_write 入参数真实完成数 ==')
{
  const s = fakeSession({
    seq: 10,
    events: [
      ev('turn/start', 8000),
      ev('tool/call', 4000, { name: 'todo_write', arguments: TODO_ARGS }),
      ev('tool/result', 3900, {}),
    ],
    messages: [{ role: 'user', blocks: [{ type: 'text', text: '干活' }] }],
  })
  const j = await mind({ sessions: sessionsOf([s]) })
  eq(j.digest.todos, { done: 3, total: 10, at: at(4000) }, 'H3 todos = 3/10（真数字，不是估算）')
  eq(j.digest.taskSince, 0, 'H3 工具已交回结果 → taskSince 归 0（不算"正在跑"）')
}

console.log('\n== H4. ⑧ 上下文压力：tokenMeter ÷ contextWindow ==')
{
  const s = fakeSession({ seq: 11, events: [ev('turn/start', 1000)] })
  const j = await mind({
    sessions: sessionsOf([s]),
    /* 照抄 ctx.tokenMeter.measure() 的真实形状：{ totalTokens, surfaceTokens, nodes } */
    tokenMeter: { measure: () => ({ totalTokens: 250000, surfaceTokens: 250000, nodes: [] }) },
  })
  eq(j.digest.meter, { used: 250000, limit: 1000000, pct: 0.25 }, 'H4 meter 算对了')
}

console.log('\n== H5. ⑧ 报错安慰：只看 30 秒内的新鲜错误 ==')
{
  const fresh = fakeSession({
    seq: 12,
    events: [ev('turn/start', 5000), ev('tool/call', 2000, { name: 'ops_bash' }), ev('tool/result', 1000, { error: 'boom' })],
  })
  const j1 = await mind({ sessions: sessionsOf([fresh]) })
  eq(j1.digest.error, true, 'H5 1 秒前的错误 → error true')
  eq(j1.digest.intent, 'error', 'H5 error 意图优先')

  const stale = fakeSession({
    seq: 13,
    events: [ev('turn/start', 90000), ev('tool/call', 70000, { name: 'ops_bash' }), ev('tool/result', 60000, { error: 'old' })],
  })
  const j2 = await mind({ sessions: sessionsOf([stale]) })
  eq(j2.digest.error, false, 'H5 60 秒前的旧错误 → error false（否则立绘永久停在出错表情）')

  const recovered = fakeSession({
    seq: 14,
    events: [
      ev('turn/start', 9000),
      ev('tool/call', 6000, { name: 'ops_bash' }),
      ev('tool/result', 5000, { error: 'boom' }),
      ev('tool/call', 3000, { name: 'ops_bash' }),
      ev('tool/result', 2000, {}),          // 之后成功了 → 把错误作废
    ],
  })
  const j3 = await mind({ sessions: sessionsOf([recovered]) })
  eq(j3.digest.error, false, 'H5 报错之后又成功了 → error false')
}

console.log('\n== H6. taskSince / turnSince 是绝对时间戳（缓存命中也不会过期） ==')
{
  const s = fakeSession({
    seq: 20,
    events: [ev('turn/start', 3000), ev('tool/call', 1500, { name: 'pnpm' })],   // 工具还没交回结果
  })
  const { handler } = mount({ sessions: sessionsOf([s]) })
  const first = (await call(handler, '/dsh-pet/__mind')).json
  eq(first.digest.taskSince, at(1500), 'H6 taskSince = 工具调用时刻（绝对）')
  eq(first.digest.turnSince, at(3000), 'H6 turnSince = 回合开始时刻（绝对）')
  eq(first.cached, undefined, 'H6 首次不算缓存命中')

  /* 关键：seq 没动 → 走缓存。相对毫秒在这里会冻结成过期数字，绝对时间戳不会。 */
  await new Promise((r) => setTimeout(r, 60))
  const second = (await call(handler, '/dsh-pet/__mind')).json
  eq(second.cached, true, 'H6 同一 seq 第二次 → 走缓存')
  eq(second.digest.taskSince, first.digest.taskSince, 'H6 缓存命中时 taskSince 不变（仍是绝对时刻）')
  eq(second.digest.sinceMs, first.digest.sinceMs, 'H6 对照：相对值 sinceMs 在缓存命中时是冻结的')
  truthy(Date.now() - second.digest.taskSince > 1500,
    'H6 客户端自己减就能得到正确的"已经跑了 ' + Math.round((Date.now() - second.digest.taskSince) / 1000) + ' 秒"')

  /* seq 推进 → 必须重算 */
  const j3 = await call(handler, '/dsh-pet/__mind')
  void j3
  const s2 = fakeSession({ seq: 21, events: [ev('turn/start', 100)] })
  const j4 = await mind({ sessions: sessionsOf([s2]) })
  eq(j4.digest.seq, 21, 'H6 换 / 推进 seq 后重算（seq = 21）')
}

console.log('\n== H7. 缺服务 / 坏数据都不能崩 ==')
{
  const s = fakeSession({ seq: 30, events: [ev('turn/start', 100)] })
  const noMeter = await mind({ sessions: sessionsOf([s]) })
  eq(noMeter.digest.meter, null, 'H7 没有 tokenMeter → meter null，其余照常')
  truthy(noMeter.digest.intent, 'H7 没有 tokenMeter 时 intent 仍算得出来')

  const badMeter = await mind({ sessions: sessionsOf([s]), tokenMeter: { measure() { throw new Error('炸了') } } })
  eq(badMeter.digest.meter, null, 'H7 tokenMeter.measure() 抛错 → meter null，不冒泡')

  const noWindow = await mind({
    sessions: sessionsOf([fakeSession({ seq: 31, context: null, events: [ev('turn/start', 100)] })]),
    tokenMeter: { measure: () => ({ totalTokens: 999, surfaceTokens: 999, nodes: [] }) },
  })
  eq(noWindow.digest.meter, { used: 999, limit: 0, pct: 0 },
    'H7 拿不到 contextWindow → limit 0 / pct 0（不会算出 NaN 或 Infinity）')

  /* TokenUsage.totalTokens 是可选字段：真会缺。缺了必须退化成 0，
     绝不能变成 NaN —— NaN 会一路显示成「上下文 NaN%」。 */
  const noTotal = await mind({
    sessions: sessionsOf([s]),
    tokenMeter: { measure: () => ({ surfaceTokens: 1234, nodes: [] }) },
  })
  eq(noTotal.digest.meter, { used: 0, limit: 1000000, pct: 0 },
    'H7 measure() 没有 totalTokens（可选字段缺失）→ used 0 / pct 0，不是 NaN')
  /* 写成可选链形式：meter 为 null 时要"断言失败"，不能"抛 TypeError 把整个测试打断" */
  truthy(noTotal.digest.meter && Number.isFinite(noTotal.digest.meter.pct), 'H7 pct 是有限数')

  const noSession = await mind({ sessions: null })
  eq(noSession.digest, null, 'H7 没有活跃会话 → digest null，不崩')
  eq(noSession.ok, true, 'H7 没有活跃会话时仍返回 200')

  const badTodo = fakeSession({
    seq: 32,
    events: [ev('turn/start', 100), ev('tool/call', 50, { name: 'todo_write', arguments: '{坏 JSON' })],
  })
  const j = await mind({ sessions: sessionsOf([badTodo]) })
  eq(j.digest.todos, null, 'H7 todo_write 参数是坏 JSON → todos null，不冒泡')

  const emptyTodo = fakeSession({
    seq: 33,
    events: [ev('turn/start', 100), ev('tool/call', 50, { name: 'todo_write', arguments: JSON.stringify({ todos: [] }) })],
  })
  eq((await mind({ sessions: sessionsOf([emptyTodo]) })).digest.todos, null, 'H7 空清单 → todos null')

  const noEvents = fakeSession({ seq: 34, events: [], messages: [] })
  const j5 = await mind({ sessions: sessionsOf([noEvents]) })
  eq(j5.digest.intent, 'idle', 'H7 什么都没有 → idle')
  eq(j5.digest.todos, null, 'H7 没有事件 → todos null')
  eq(j5.digest.taskSince, 0, 'H7 没有事件 → taskSince 0')
  eq(j5.digest.turnSince, 0, 'H7 没有事件 → turnSince 0')
}

console.log('\n== H8. 只看最近的 todo_write + 活跃会话按 seq 最大选 ==')
{
  const s = fakeSession({
    seq: 40,
    events: [
      ev('turn/start', 9000),
      ev('tool/call', 8000, { name: 'todo_write', arguments: JSON.stringify({ todos: [{ status: 'completed' }, { status: 'pending' }] }) }),
      ev('tool/call', 2000, { name: 'todo_write', arguments: TODO_ARGS }),
    ],
  })
  const j = await mind({ sessions: sessionsOf([s]) })
  eq(j.digest.todos, { done: 3, total: 10, at: at(2000) }, 'H8 取最近一次 todo_write（3/10），不是第一次的 1/2')

  const older = fakeSession({ id: 'old', seq: 5, events: [ev('turn/start', 100)] })
  const newer = fakeSession({ id: 'new', seq: 99, events: [ev('turn/start', 100)] })
  const j2 = await mind({ sessions: sessionsOf([older, newer]) })
  eq(j2.digest.id, 'new', 'H8 按 seq 最大选会话')
}

console.log('\n== H9. __events / __diag 仍然工作（回归） ==')
{
  const { handler } = mount({ sessions: sessionsOf([fakeSession({ seq: 50, events: [ev('tool/call', 100, { name: 'x' })] })]) })
  const e = await call(handler, '/dsh-pet/__events')
  eq(e.code, 200, 'H9 __events 200')
  eq(e.json.info.totalEvents, 1, 'H9 __events 报出事件总数')
  eq(e.json.info.tail.length, 1, 'H9 __events 带 tail')

  const d = await call(handler, '/dsh-pet/__diag?data=' + encodeURIComponent('boom'))
  eq(d.code, 200, 'H9 __diag 200')
  truthy(d.json.logged, 'H9 __diag 回传落盘路径')
}

console.log('\n' + (failures === 0
  ? '\x1b[32m宿主半边全部通过 —— ⑧ 的三项在重启前就已经验证过逻辑了。\x1b[0m\n'
  : '\x1b[31m' + failures + ' 项失败，见上。\x1b[0m\n'))
process.exit(failures === 0 ? 0 : 1)
