#!/usr/bin/env node
/* 实盘验收：确认宿主已加载新代码、素材全部可访问、数据字段齐全。
   用法：node verify_live.js        （DSH 必须在跑）
   重启 DSH 之前跑一次、之后跑一次，对比 _mind 字段那一节的差异。 */

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:19387'
const PET = BASE + '/dsh-pet'

let fail = 0
const ok = (t) => console.log('  \x1b[32mOK  \x1b[0m' + t)
const no = (t) => { fail++; console.log('  \x1b[31m缺  \x1b[0m' + t) }

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status)
  return r.json()
}

;(async () => {
  console.log('\n== 1. 素材路由（13 张逐个取，确认没有静默 404） ==')
  let probe
  try {
    probe = await getJSON(PET + '/')
  } catch (e) {
    console.log('  \x1b[31m插件路由不通：' + e.message + '\x1b[0m')
    console.log('  → DSH 没跑，或插件没加载。请先确认 DSH 在 ' + BASE + ' 上。\n')
    process.exit(1)
  }
  const sprites = probe.sprites || []
  console.log('  宿主已登记 ' + sprites.length + ' 张')
  for (const name of sprites) {
    const r = await fetch(PET + '/sprite/' + name + '.png?v=0', { cache: 'no-store' })
    if (r.ok && (r.headers.get('content-type') || '').includes('png')) ok(name + '.png')
    else no(name + '.png  HTTP ' + r.status)
  }
  for (const want of ['drag']) {
    if (!sprites.includes(want)) no('白名单少了 ' + want + '（拖拽差分不会出现，且不报错）')
  }

  console.log('\n== 2. __mind 字段（这一节就是"宿主新旧代码"的判据） ==')
  const mind = await getJSON(PET + '/__mind')
  const d = mind.digest || {}
  console.log('  intent=' + d.intent + '  tool=' + JSON.stringify(d.tool) +
              '  error=' + !!d.error + '  running=' + !!d.running)
  console.log('  seq=' + d.seq + '  sinceMs=' + d.sinceMs +
              '  contextWindow=' + ((d.context || {}).contextWindow))

  const need = ['todos', 'meter', 'taskSince', 'turnSince']
  const missing = need.filter((k) => !(k in d))
  if (missing.length === 0) {
    ok('⑧ 的四个新字段全在 → 宿主已是新代码')
    console.log('     todos     = ' + JSON.stringify(d.todos))
    console.log('     meter     = ' + JSON.stringify(d.meter))
    console.log('     taskSince = ' + d.taskSince + '   turnSince = ' + d.turnSince)
    if (d.taskSince) {
      const age = Date.now() - Number(d.taskSince)
      console.log('     （taskSince 距今 ' + Math.round(age / 1000) + ' 秒；'
        + (age > 0 && age < 86400000 ? '是绝对时间戳，正确' : '数值可疑，检查是否写成了相对毫秒'))
    }
  } else {
    no('缺字段：' + missing.join(', '))
    console.log('\n  → 宿主还在跑旧代码。lib/index.js 的改动必须重启 DSH 才生效。')
    console.log('    当前进度条 / 上下文压力不会显示（界面不会报错，只是安静地不出现）。')
  }
  if (d.todos && Number(d.todos.total) > 0) {
    ok('todo 有数据：' + d.todos.done + '/' + d.todos.total + '（标签上应常显这个分数）')
  } else {
    console.log('  --  todo 暂无数据（本会话还没调用过 todo_write，正常）')
  }
  if (d.meter && Number.isFinite(Number(d.meter.pct))) {
    const p = Math.round(Number(d.meter.pct) * 100)
    ok('上下文压力 = ' + p + '%' + (p >= 75 ? '（≥75% 标签会高亮）' : '') +
       (p >= 80 ? '（≥80% 会主动提醒）' : ''))
  } else {
    console.log('  --  上下文压力暂无数据')
  }

  console.log('\n== 3. __events（排查意图判定用） ==')
  try {
    const ev = await getJSON(PET + '/__events')
    const info = ev.info || ev   /* 旧宿主挂在 info 下，新宿主兼容两种 */
    ok('事件通道通，最近 ' + (info.tail || []).length + ' 条（共 ' + info.totalEvents + '）')
    const errs = (info.tail || []).filter((e) => e.isError)
    if (errs.length) console.log('     其中报错事件 ' + errs.length + ' 条（error 意图的来源）')
  } catch (e) { no('__events 不通：' + e.message) }

  console.log('\n== 4. __diag（客户端崩溃回传） ==')
  try {
    const r = await fetch(PET + '/__diag')
    r.ok ? ok('收到（HTTP ' + r.status + '）') : no('HTTP ' + r.status)
  } catch (e) { no('__diag 不通：' + e.message) }

  console.log('\n' + (fail === 0
    ? '\x1b[32m实盘验收通过。\x1b[0m别忘了浏览器里 Ctrl+Shift+R 刷新页面（client.js 是热重载）。\n'
    : '\x1b[31m' + fail + ' 项不通过，见上。\x1b[0m\n'))
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.log('\n运行出错：' + e.message + '\n'); process.exit(1) })
