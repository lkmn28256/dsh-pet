/**
 * dsh-pet 宿主半边
 *
 * 职责：把包内 assets/*.png 通过同源 HTTP 路由下发给浏览器半边。
 * 浏览器半边是 dsh.client（platform=web）声明的 client.js，负责真正渲染。
 *
 * 路由（kind: 'prefix'）：
 *   GET /dsh-pet/sprite/<名字>.png  -> image/png
 *   GET /dsh-pet/                   -> JSON 探针（确认路由有没有注册、req.url 长什么样）
 *
 * ⚠️ prefix 路由下 req.url 的形状（完整路径 vs 已剥掉前缀）在不同宿主版本可能不同，
 *    所以这里两种都兼容：统一按"取末段"解析，并把原始 url 回显出来便于诊断。
 */
import { readFile, appendFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = join(HERE, '..', 'assets')
const DIAG_FILE = join(tmpdir(), 'dsh-pet-diag.log')

const ROUTE_PREFIX = '/dsh-pet'
/* ⚠️ 加了新素材必须同步登记到这里，否则浏览器半边拿到 404。
   而因为 dragReady 永远为 false，表现是"拖拽时表情纹丝不动"，
   看起来像客户端没接线，实际是宿主白名单挡的（踩过一次，查了半天）。 */
const ALLOWED = new Set([
  'calm', 'happy', 'sleepy', 'cool',
  'surprised', 'shy', 'calling', 'angry',
  'sleeping', 'confused', 'love', 'excited',
  'drag',                                  // 拖拽时的抓狂差分
])

/** 只放行白名单内的名字，杜绝路径穿越 */
function resolveSprite(name) {
  if (!ALLOWED.has(name)) return null
  return join(ASSETS_DIR, name + '.png')
}

function send(res, code, headers, body) {
  res.writeHead(code, headers)
  res.end(body)
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  send(res, code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  }, body)
}

/** 把任意形状的 req.url 拆成非空路径段 */
function pathSegments(rawUrl) {
  let pathname = String(rawUrl || '/').split('?')[0].split('#')[0]
  try {
    pathname = decodeURIComponent(pathname)
  } catch (err) {
    /* 解码失败就用原串 */
  }
  return pathname.split('/').filter(Boolean)
}

export const name = 'dsh-pet'

// webServer 是硬依赖：Loader 会等 HTTP 服务器挂载后再激活本插件
export const inject = ['webServer']

/* --------------------------------------------------------------------------
 * 会话"思考内容"读取
 *
 * 目的：让立绘能按当前思考内容切换表情（内容驱动，而不只是状态驱动）。
 * 数据源：宿主内存里的活会话（ctx.sessions），事件里有 ReasoningBlock（推理文本）。
 * 不读磁盘日志 —— 那些是 .jsonl.zstd 压缩格式，本机没有可用的 zstd 解压能力。
 * -------------------------------------------------------------------------- */

/** 取文本块里的纯文本 */
function blocksToText(message) {
  const blocks = (message && message.content) || []
  let out = ''
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text + '\n'
  }
  return out
}

/** 取"最近的思考段落"：从末尾往前攒，最多 2 段 / 500 字 */
function tailThought(reasoning) {
  const raw = String(reasoning || '').trim()
  if (!raw) return ''
  const paras = raw.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  if (paras.length === 0) return raw.slice(-500)
  const out = []
  let len = 0
  for (let i = paras.length - 1; i >= 0 && out.length < 2; i--) {
    out.unshift(paras[i])
    len += paras[i].length
    if (len >= 500) break
  }
  return out.join('\n\n').slice(-500)
}

/** 抽最近一条助手消息的推理（思考）文本。
    ⚠️ 只取**最后几段**，不要返回整段累积的推理：推理是整轮逐步累积的，
    返回全文会让很早以前的词一直留在判定窗口里，表情被旧内容锁死
    （实测：上轮讲"错误/失败"，立绘就一直"生气 · 思考中"）。 */
function extractReasoning(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'assistant') continue
    const blocks = m.content || []
    let reasoning = ''
    for (const b of blocks) {
      if (b && b.type === 'reasoning' && typeof b.text === 'string') reasoning += b.text + '\n'
    }
    const picked = tailThought(reasoning)
    if (picked) return picked
    // 没有推理块就退回正文，至少能判断在做什么
    const text = blocksToText(m)
    if (text.trim()) return text.slice(-400)
    return ''
  }
  return ''
}

/** 找"最活跃"的会话：seq 最大者优先 */
function pickActiveSession(sessions) {
  if (!sessions || typeof sessions.list !== 'function') return null
  let best = null
  let bestSeq = -1
  let list = []
  try {
    list = sessions.list() || []
  } catch (err) {
    return null
  }
  for (const s of list) {
    try {
      const seq = Number(s && s.seq)
      if (Number.isFinite(seq) && seq > bestSeq) {
        bestSeq = seq
        best = s
      }
    } catch (err) { /* 跳过异常会话 */ }
  }
  return best
}

/** 从会话事件里判"最近在做什么" —— 意图比情绪词可靠得多 */
function scanEvents(events) {
  const start = Math.max(0, events.length - 50)
  let lastToolName = ''
  let lastTime = 0
  let lastErrorTime = 0        // 最近一次工具报错的时间
  let lastResultTime = 0       // 最近一次成功的工具结果时间
  let lastCallTime = 0         // 最近一次工具调用的时间（算"这一个工具跑了多久"）
  let turnEndTime = 0          // 最近一次 turn/end 的时间（判"回合真的结束了"）
  for (let i = start; i < events.length; i++) {
    const ev = events[i]
    if (!ev) continue
    const t = Number(ev.time)
    if (Number.isFinite(t) && t > lastTime) lastTime = t
    if (ev.type === 'tool/call') {
      lastToolName = String((ev.data && ev.data.name) || '')
      if (Number.isFinite(t) && t > lastCallTime) lastCallTime = t
    } else if (ev.type === 'tool/result') {
      if (ev.data && ev.data.error) {
        if (Number.isFinite(t) && t > lastErrorTime) lastErrorTime = t
      } else if (Number.isFinite(t) && t > lastResultTime) {
        lastResultTime = t     // 成功结果：用来把更早的错误作废
      }
    } else if (ev.type === 'turn/end') {
      if (Number.isFinite(t) && t > turnEndTime) turnEndTime = t
    }
  }
  return { lastToolName, lastTime, lastErrorTime, lastResultTime, lastCallTime, turnEndTime }
}

/**
 * 真实的"任务进度"：从最近一次 todo_write 的**入参**里数已完成条数。
 *
 * 这不是估算 —— todo_write 的 arguments 里就带着完整清单和每条的状态，
 * 所以能给出 "3/10" 这种真数字，而不是"看起来快好了"。
 */
function todoProgress(events) {
  const start = Math.max(0, events.length - 1000)
  for (let i = events.length - 1; i >= start; i--) {
    const ev = events[i]
    if (!ev || ev.type !== 'tool/call') continue
    if (String((ev.data && ev.data.name) || '') !== 'todo_write') continue
    try {
      const args = JSON.parse(String((ev.data && ev.data.arguments) || '{}'))
      const list = Array.isArray(args.todos) ? args.todos : null
      if (!list || list.length === 0) return null
      let done = 0
      for (const t of list) {
        if (t && String(t.status || '') === 'completed') done += 1
      }
      return { done: done, total: list.length, at: Number(ev.time) || 0 }
    } catch (err) {
      return null
    }
  }
  return null
}

/**
 * 上下文压力：tokenMeter 量出当前会话占用的 token，再拿 requestContext().contextWindow 当分母。
 *
 * tokenMeter 是**可选**服务（ctx.get 可能返回 undefined），requestContext 也可能没有
 * contextWindow，任何一步拿不到就返回 null —— 这只是锦上添花的表情信号，绝不该影响主流程。
 */
function tokenPressure(session, tokenMeter, context) {
  if (!session || !tokenMeter || typeof tokenMeter.measure !== 'function') return null
  try {
    const m = tokenMeter.measure(session)
    if (!m) return null
    /* 真实形状是 { totalTokens, surfaceTokens, nodes }。
       totalTokens 在 TokenUsage 里是**可选**字段，缺失时 Number(undefined) 是 NaN，
       所以必须 `|| 0` —— 否则 pct 会变成 NaN 一路传到界面上的「上下文 NaN%」。 */
    const used = Number(m.totalTokens) || 0
    let limit = 0
    try { limit = Number(context && context.contextWindow) || 0 } catch (err) { limit = 0 }
    return {
      used: used,
      limit: limit,
      pct: limit > 0 ? Math.min(1, used / limit) : 0,
    }
  } catch (err) {
    return null
  }
}

/** 从消息派生里补一层判断：最后一条是工具结果 = 还在忙 */
function scanMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { lastRole: '', lastToolName: '', sawToolCall: false, sawToolResult: false, sawError: false }
  }
  let sawToolCall = false
  let sawToolResult = false
  let sawError = false
  let lastToolName = ''
  const from = Math.max(0, messages.length - 30)
  for (let i = from; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue
    const blocks = m.content || []
    for (const b of blocks) {
      if (!b) continue
      if (b.type === 'tool-call') {
        sawToolCall = true
        lastToolName = String(b.name || '')
      } else if (b.type === 'tool-result') {
        sawToolResult = true
      }
    }
    if (m.role === 'tool' && m.isError) sawError = true
  }
  const last = messages[messages.length - 1] || {}
  /* 最后一条助手消息发起的工具调用，是否已经拿到结果？
     ⚠️ 不能只看"最后一条消息里有没有 tool-call 块"——最后一条常常是 tool 结果消息，
     那里没有 tool-call，于是会被误判成"没有待处理工具" → 立绘中途回到"呼唤·等你"。 */
  let pendingToolCall = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (m.role === 'assistant') {
      const hasCall = (m.content || []).some((b) => b && b.type === 'tool-call')
      if (hasCall) pendingToolCall = true     // 最后一条助手消息有工具调用、后面没有结果
      break
    }
    if (m.role === 'tool') break              // 结果已经回来了，不是待处理
  }
  return {
    lastRole: String(last.role || ''),
    lastToolName: lastToolName,
    sawToolCall: sawToolCall,
    sawToolResult: sawToolResult,
    sawError: sawError,
    lastHasToolCall: pendingToolCall,
    /* 最后一条是用户消息 = 新回合已开始、但 turn/start 还没产生（事件有延迟）。
       用它挡住"上一轮的 turn/end 还没被取代"这个窗口。 */
    lastIsUser: String(last.role || '') === 'user',
  }
}

/**
 * 判"当前这一轮是否还在进行中"。
 *
 * ⚠️ 必须用**大窗口**（千级事件，而非尾部 50 个）：
 * 干活密集时一轮就有几十个工具事件，只看尾部会把这一轮的 turn/start 挤出去，
 * 于是"回合进行中"被误判成"已结束"，立绘提前变成"等你"。
 */
function turnState(events) {
  const start = Math.max(0, events.length - 1000)
  let lastStart = 0
  let lastEnd = 0
  for (let i = start; i < events.length; i++) {
    const ev = events[i]
    if (!ev) continue
    const t = Number(ev.time)
    if (!Number.isFinite(t)) continue
    if (ev.type === 'turn/start') {
      if (t > lastStart) lastStart = t
    } else if (ev.type === 'turn/end') {
      if (t > lastEnd) lastEnd = t
    }
  }
  return {
    running: lastStart > 0 && lastStart > lastEnd,
    lastEndTime: lastEnd,
    lastStartTime: lastStart,
  }
}

/** 汇总一个会话的"可驱动表情"的信息（含意图、进度、上下文压力） */
function sessionDigest(session, tokenMeter) {
  if (!session) return null
  const out = {
    id: null, seq: 0, running: false, texts: [],
    intent: 'idle', tool: '', working: false, sinceMs: 0, error: false,
    todos: null, meter: null, taskSince: 0, turnSince: 0,
  }
  try { out.id = String(session.id || '') } catch (err) { /* 忽略 */ }
  try { out.seq = Number(session.seq) || 0 } catch (err) { /* 忽略 */ }
  try {
    if (typeof session.requestContext === 'function') {
      out.context = session.requestContext() || null
    }
  } catch (err) { /* 忽略 */ }

  /* ---- 事件层：判断"在干活 / 干完了 / 出错" ---- */
  let rawEvents = []
  try {
    if (typeof session.snapshotEvents === 'function') {
      rawEvents = session.snapshotEvents() || []
    }
  } catch (err) { rawEvents = [] }
  const ev = scanEvents(rawEvents)
  const ts = turnState(rawEvents)

  /* ---- 消息层：最后一条是谁、有没有工具活动 ---- */
  let messages = []
  try {
    messages = (typeof session.deriveMessages === 'function' && session.deriveMessages()) || []
  } catch (err) {
    messages = []
  }
  const msg = scanMessages(messages)

  /* ---- 汇总：running 以 turn 事件为准（大窗口），事件层拿不到才退回消息层 ---- */
  out.running = rawEvents.length > 0 ? ts.running : msg.sawToolCall

  /* ⚠️ 错误判定要同时满足两条，否则会出现"会话结束了还一直惊讶/出错"：
     ① 新鲜：报错发生在最近 30 秒内（历史上修 bug 时的旧错误不算）
     ② 未被覆盖：报错之后没有再出现**成功的**工具结果
     曾经只判 `sawError`（扫到就置真），于是旧错误让立绘永久停在"出错"表情。 */
  const nowMs = Date.now()
  const ERROR_FRESH_MS = 30000
  const errAfterSuccess = ev.lastErrorTime > ev.lastResultTime
  out.error = (ev.lastErrorTime > 0 && (nowMs - ev.lastErrorTime) <= ERROR_FRESH_MS && errAfterSuccess)
    || (ev.lastTime === 0 && msg.sawError)
  out.tool = ev.lastToolName || msg.lastToolName || ''
  out.working = out.running
  out.sinceMs = ev.lastTime > 0 ? Math.max(0, nowMs - ev.lastTime) : 0

  /* ---- 给客户端"长任务进度 / 上下文压力"用的真实数据 ----
     ① todos：最近一次 todo_write 入参里的 完成数/总数（真数字，不是估算）
     ② meter：tokenMeter 量出的上下文占用 与 contextWindow 的比值
     ③ taskSince / turnSince：**绝对时间戳**（不是"已经过了多久"）
        —— 因为 __mind 有按 seq 的缓存，缓存的 digest 会被直接复用，
        写成相对毫秒的话缓存命中时就是过期数字；绝对时间戳则由客户端自己减，
        缓存多久都不会错。 */
  out.todos = todoProgress(rawEvents)
  out.meter = tokenPressure(session, tokenMeter, out.context)
  out.taskSince = (ev.lastCallTime > 0 && ev.lastCallTime > ev.lastResultTime) ? ev.lastCallTime : 0
  out.turnSince = ts.running && ts.lastStartTime > 0 ? ts.lastStartTime : 0

  /* ---- 判定"回合是否真的结束了" ----
     用大窗口的 turn 事件；turn/end 之后只要没有更新的消息，就算这一轮结束。
     这一条必须优先于 thinking：否则会话结束后仍会停在"思考中"。 */
  const turnEndedByEvent = ts.lastEndTime > 0 && (nowMs - ts.lastEndTime) < 3600000

  /* ---- 意图判定：顺序即优先级 ----
     注意 thinking 与 tool 的区分：
     回合进行中，只有当"工具已经交回结果、我正在消化它"时才算 thinking；
     刚发出工具调用（还没结果）或最后一条消息还是工具结果，都算 tool。 */
  const toolSettled = ev.lastToolName && msg.lastRole !== 'tool' && !msg.sawToolResult
  /* 兜底只防"真的卡死"：阈值给到 5 分钟。
     ⚠️ 曾经是 90 秒，结果跑一次 pnpm install（20~30s）或思考久一点就被判成"卡住"，
     立绘在对话中途跳回"呼喊·等你"。turn 判定已经可靠，这个兜底不该抢戏。 */
  const staleRunning = out.sinceMs >= 300000
  /* 用户刚发消息 = 新回合已开始（事件可能还没跟上），不该判成"等你" */
  const userJustSpoke = msg.lastIsUser
  const endedState = turnEndedByEvent && !msg.lastHasToolCall && !staleRunning
  if (out.error) out.intent = 'error'
  /* 结束态优先级落在 running 之后：只有"回合确实收尾了"才谈得上等你 */
  else if (out.running && msg.lastRole === 'tool') out.intent = 'tool'
  else if (out.running && msg.sawToolResult) out.intent = 'tool'
  else if (out.running && out.tool && !toolSettled) out.intent = 'tool'
  else if (out.running) out.intent = 'thinking'
  else if (endedState && !userJustSpoke) out.intent = 'waiting'
  else if (Array.isArray(messages) && messages.length > 0 && !userJustSpoke) out.intent = 'waiting'
  else if (staleRunning && !userJustSpoke) out.intent = 'waiting'
  else if (Array.isArray(messages) && messages.length > 0) out.intent = 'thinking'
  else out.intent = 'idle'
  out.turnEnded = turnEndedByEvent
  out.userJustSpoke = userJustSpoke
  out.pendingToolCall = !!msg.lastHasToolCall

  /* ---- 文本：留给内容层做情绪微调 ---- */
  if (Array.isArray(messages) && messages.length > 0) {
    const reasoning = extractReasoning(messages)
    if (reasoning) out.texts.push(reasoning)
    const lastText = blocksToText(messages[messages.length - 1])
    if (lastText && lastText !== reasoning) out.texts.push(lastText.slice(-500))
  }
  return out
}

export function apply(ctx) {
  const webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    try {
      ctx.logger?.warn?.('[dsh-pet] webServer unavailable, sprite route not registered')
    } catch (err) { /* 日志失败不影响主流程 */ }
    return
  }

  /* tokenMeter 是**可选**服务（ctx.get 可能给 undefined）。
     拿不到就只是少了"上下文压力"这一个表情信号，其它功能照常。 */
  let tokenMeter = null
  try {
    tokenMeter = typeof ctx.get === 'function' ? ctx.get('tokenMeter') : null
  } catch (err) { tokenMeter = null }

  const started = Date.now()
  let hits = 0
  let lastUrl = null
  /* __mind 的缓存：客户端轮询很密，只在 seq 推进时重算消息派生 */
  const mindCache = { sid: null, seq: -1, digest: null }

  const dispose = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      hits += 1
      lastUrl = String(req.url || '')
      try {
        const segs = pathSegments(req.url)

        // 诊断：GET /dsh-pet/__events  → 宿主眼里的最近事件（排查意图判定）
        if (segs[segs.length - 1] === '__events') {
          let info = null
          try {
            const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
            const session = pickActiveSession(sessions)
            const events = (session && typeof session.snapshotEvents === 'function')
              ? (session.snapshotEvents() || []) : []
            const tail = events.slice(-60)
            const nowMs = Date.now()
            info = {
              now: nowMs,
              sessionId: session ? String(session.id || '') : null,
              totalEvents: events.length,
              tail: tail.map((e) => {
                const t = Number(e && e.time)
                return {
                  type: String((e && e.type) || ''),
                  ageMs: Number.isFinite(t) ? (nowMs - t) : null,
                  tool: e && e.data ? String(e.data.name || '') : '',
                  isError: !!(e && e.data && e.data.error),
                }
              }),
            }
          } catch (err) {
            info = { error: String((err && err.message) || err) }
          }
          sendJson(res, 200, { ok: true, info: info })
          return
        }

        // 思考内容：GET /dsh-pet/__mind  → 当前会话的推理/正文摘要
        if (segs[segs.length - 1] === '__mind') {
          let digest = null
          try {
            const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
            const session = pickActiveSession(sessions)

            /* 缓存：客户端每 1.5s 轮询一次，但 deriveMessages() 对大会话并不便宜。
               只在"换了会话"或"seq 推进了"时才重算，其余情况直接回缓存。 */
            let seqNow = -1
            try { seqNow = session ? Number(session.seq) || 0 : -1 } catch (err) { seqNow = -1 }
            const sid = String((session && session.id) || '')

            if (mindCache.sid === sid && mindCache.seq === seqNow) {
              sendJson(res, 200, { ok: true, digest: mindCache.digest, cached: true })
              return
            }

            digest = sessionDigest(session, tokenMeter)
            mindCache.sid = sid
            mindCache.seq = seqNow
            mindCache.digest = digest
          } catch (err) {
            digest = { error: String((err && err.message) || err) }
          }
          sendJson(res, 200, { ok: true, digest: digest })
          return
        }

        // 探针：GET /dsh-pet 或 /dsh-pet/  → 证明路由活着
        if (segs.length === 0 || (segs.length === 1 && segs[0] === 'dsh-pet')) {
          sendJson(res, 200, {
            ok: true,
            route: ROUTE_PREFIX,
            hits: hits,
            lastUrl: lastUrl,
            sprites: Array.from(ALLOWED),
          })
          return
        }

        // 诊断上报：客户端崩溃时由浏览器半边回传真实堆栈，落到本地文件供排查
        if (segs[segs.length - 1] === '__diag') {
          let payload = null
          try {
            const raw = String(req.url || '')
            const q = raw.indexOf('?')
            const params = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '')
            payload = params.get('data')
          } catch (err) { /* 解析失败就记 null */ }
          const line = new Date().toISOString() + ' ' + String(payload || '(empty)') + '\n'
          try {
            await appendFile(DIAG_FILE, line, 'utf8')
          } catch (err) { /* 写不进去也不影响回包 */ }
          sendJson(res, 200, { ok: true, logged: DIAG_FILE })
          return
        }

        // 取末段当文件名；同时兼容"完整路径"与"已剥前缀"两种形状
        const last = segs[segs.length - 1]

        if (!last || !last.endsWith('.png')) {
          sendJson(res, 404, { ok: false, reason: 'not a png request', segs: segs, lastUrl: lastUrl })
          return
        }
        const spriteName = last.slice(0, -'.png'.length)
        const abs = resolveSprite(spriteName)
        if (!abs) {
          sendJson(res, 404, { ok: false, reason: 'unknown sprite: ' + spriteName, segs: segs })
          return
        }

        const bytes = await readFile(abs)
        send(res, 200, {
          'Content-Type': 'image/png',
          'Content-Length': String(bytes.length),
          /* ⚠️ 不能用长缓存：以前写的是 max-age=86400，换掉素材后浏览器一直吃旧图，
             表现就是"文件明明改了、界面毫无变化"（实测踩到）。
             no-cache 仍然缓存，但每次都会回源校验，文件一变立刻生效。 */
          'Cache-Control': 'no-cache',
        }, bytes)
      } catch (err) {
        sendJson(res, 500, { ok: false, reason: String((err && err.message) || err), lastUrl: lastUrl })
      }
    },
  })

  ctx.effect(() => () => {
    try {
      if (typeof dispose === 'function') dispose()
    } catch (err) { /* 卸载期失败无所谓 */ }
  }, 'dsh-pet: sprite route')

  try {
    ctx.logger?.info?.(
      '[dsh-pet] sprite route registered at ' + ROUTE_PREFIX +
      '/sprite/<name>.png (assets: ' + ASSETS_DIR + ', t=' + started + ')')
  } catch (err) { /* 忽略 */ }
}
