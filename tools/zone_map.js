#!/usr/bin/env node
/* 把点击分区画到立绘上，一眼看出边界对不对。
 *
 * 分区是一堆 0~1 的比例数字，**光看数字是没法确认它落在哪儿的** ——
 * 尤其是"头发和手的边界"这种地方。所以：从 client.js 里现抠 ZONES 表，
 * 用同一份数据画一张覆盖图（`zone-map.png`），改完分区跑一次。
 *
 * 抠出来的是真表，不是手抄的 —— 画出来的框必然和代码里跑的一致。
 *
 *   node zone_map.js            画图
 *   node zone_map.js --json     只把表打印出来
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const CLIENT = process.env.DSH_PET_CLIENT || path.join(__dirname, '..', 'client.js')
const ASSETS = process.env.DSH_PET_ASSETS || path.join(__dirname, '..', 'assets')
/* 画图借 Python + Pillow。默认用 PATH 里的 python3/python，找不到就用 DSH_PET_PYTHON 指。 */
const PYTHON = process.env.DSH_PET_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const OUT = path.join(__dirname, 'zone-map.png')

const src = fs.readFileSync(CLIENT, 'utf8').replace(/\r\n/g, '\n')

/* ---- 抠出 ZONES 字面量（数括号，别用正则去猜结尾） ---- */
function grabLiteral(name) {
  const at = src.indexOf('const ' + name + ' = [')
  if (at < 0) throw new Error('client.js 里找不到 const ' + name + ' = [')
  const open = src.indexOf('[', at)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '"') {                       // 跳过字符串，别把里面的括号算进去
      i += 1
      while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i += 1; i += 1 }
      continue
    }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(name + ' 的方括号没闭合')
}

const zones = new Function('return ' + grabLiteral('ZONES'))()
const fallbackAt = src.indexOf('const ZONE_FALLBACK = {')
const fallback = fallbackAt < 0 ? null : (function () {
  const open = src.indexOf('{', fallbackAt)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '"') { i += 1; while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i += 1; i += 1 } continue }
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return new Function('return ' + src.slice(open, i + 1))() }
  }
  return null
})()

/* 椭圆热区也从源码里读，省得画出来的框和真实判定不一致 */
const ell = /const CLICK_ELLIPSE = \{ cx: ([0-9.]+), cy: ([0-9.]+), rx: ([0-9.]+), ry: ([0-9.]+) \}/.exec(src)
if (!ell) throw new Error('找不到 CLICK_ELLIPSE')
const ellipse = { cx: +ell[1], cy: +ell[2], rx: +ell[3], ry: +ell[4] }

if (process.argv.indexOf('--json') >= 0) {
  console.log(JSON.stringify({ zones, fallback, ellipse }, null, 2))
  process.exit(0)
}

const payload = path.join(os.tmpdir(), 'dshpet-zones.json')
fs.writeFileSync(payload, JSON.stringify({ zones, fallback, ellipse }), 'utf8')

/* ---- 让 python 画图：分区框 + 名字 + 椭圆热区 ---- */
const py = `
import json, sys
from PIL import Image, ImageDraw
data = json.load(open(sys.argv[1], encoding='utf-8'))
im = Image.open(sys.argv[2]).convert('RGBA')
W, H = im.size
comp = Image.alpha_composite(Image.new('RGBA', im.size, (255,255,255,255)), im).convert('RGB')
ov = Image.new('RGBA', im.size, (0,0,0,0))
d = ImageDraw.Draw(ov)
palette = [(255,64,64),(255,150,0),(230,200,0),(60,190,80),(0,190,190),
           (60,120,255),(150,70,255),(255,60,190),(140,90,40),(20,20,20)]
seen = {}
for i, z in enumerate(data['zones']):
    c = palette[i % len(palette)]
    seen.setdefault(z['id'], c)
    x0, x1 = z['mx']; y0, y1 = z['my']
    d.rectangle([x0*W, y0*H, x1*W, y1*H], fill=c + (46,), outline=c + (235,), width=2)
    d.text((x0*W + 4, y0*H + 3), '%d %s' % (i, z['id']), fill=(0,0,0,255))
e = data['ellipse']
d.ellipse([(e['cx']-e['rx'])*W, (e['cy']-e['ry'])*H, (e['cx']+e['rx'])*W, (e['cy']+e['ry'])*H],
          outline=(0,0,0,200), width=2)
if data.get('fallback'):
    d.text((6, H-16), 'fallback = ' + data['fallback']['id'], fill=(0,0,0,255))
out = Image.alpha_composite(comp.convert('RGBA'), ov).convert('RGB')
out.save(sys.argv[3])
print('分区 %d 条，%d 种 id' % (len(data['zones']), len(seen)))
`
execFileSync(PYTHON, ['-c', py, payload, path.join(ASSETS, 'calm.png'), OUT], {
  stdio: 'inherit',
  /* 不指定的话 python 的子进程会按 GBK 写 stdout，中文提示直接变乱码 */
  env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
})

console.log('已生成 ' + OUT)
console.log('  分区顺序（先匹配者胜）：' + zones.map((z) => z.id).join(' → '))
console.log('  兜底：' + (fallback ? fallback.id : '（无）'))
