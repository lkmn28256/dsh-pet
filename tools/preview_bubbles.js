#!/usr/bin/env node
/* 把 client.js 里**真正的**气泡 CSS 抠出来，生成一个能直接双击打开的预览页。
 *
 * 为什么要这个：气泡这种东西只能靠眼睛验收，而我没有浏览器可以看。
 * 与其在 DSH 里改一轮问一轮，不如把同一份 CSS 渲染到一个独立页面上，
 * 一次把三套配色、长短台词、入场动画都看完。
 *
 * 关键点是**不复制样式**：CSS 从 client.js 的 CSS_TEXT 里现抠，
 * 所以预览页和插件永远不会漂移。改了 client.js 重跑一次即可。
 */
const fs = require('fs')
const path = require('path')

const CLIENT = process.env.DSH_PET_CLIENT || path.join(__dirname, '..', 'client.js')
const ASSETS = process.env.DSH_PET_ASSETS || path.join(__dirname, '..', 'assets')
const OUT = path.join(__dirname, 'bubble-preview.html')
const SPRITE_COPY = path.join(__dirname, 'bubble-preview-calm.png')

const src = fs.readFileSync(CLIENT, 'utf8').replace(/\r\n/g, '\n')
const lines = src.split('\n')

/* ---- 从 CSS_TEXT 里抠出气泡那一段 ---- */
const start = lines.findIndex((l) => l.indexOf('"@keyframes dshPetBubbleIn {"') >= 0)
if (start < 0) {
  console.error('找不到 @keyframes dshPetBubbleIn —— client.js 里的气泡 CSS 被挪走了？')
  process.exit(1)
}
let end = -1
let seenSoft = false
for (let i = start; i < lines.length; i += 1) {
  if (lines[i].indexOf('.dshPetBubbleSoft {') >= 0) seenSoft = true
  if (seenSoft && /^\s*"}",\s*$/.test(lines[i])) { end = i; break }
}
if (end < 0) {
  console.error('再也找不到 .dshPetBubbleSoft 那一段的结尾 —— 结构变了，脚本要跟着改')
  process.exit(1)
}

const css = lines.slice(start, end + 1)
  .map((l) => {
    const m = /^\s*"(.*)",\s*$/.exec(l)
    return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null
  })
  .filter((x) => x !== null)
  .join('\n')

if (!/\.dshPetBubble::after/.test(css)) {
  console.error('抠出来的 CSS 里没有尾巴那一条，别拿它当验收依据')
  process.exit(1)
}

/* ---- 立绘拷到旁边，预览页用相对路径（file:// 下最省事） ---- */
fs.copyFileSync(path.join(ASSETS, 'calm.png'), SPRITE_COPY)

const cases = [
  { kind: '', name: 'say · 平常说话', text: '嗯？', tip: '靠近时的那一句' },
  { kind: '', name: 'say · 长台词换行', text: '按住拖动可移动，单击换表情', tip: '看换行后的行距和内边距' },
  { kind: 'dshPetBubbleShout', name: 'shout · 大声', text: '别戳了！', tip: '生气 / 受惊 / 被扔出去' },
  { kind: 'dshPetBubbleShout', name: 'shout · 长台词', text: '哇啊啊啊——', tip: '字重和字距都更冲' },
  { kind: 'dshPetBubbleSoft', name: 'soft · 犯困', text: '哈啊……', tip: '打哈欠 / 揉眼睛 / 害羞' },
  { kind: 'dshPetBubbleSoft', name: 'soft · 睡醒', text: '唔…醒了', tip: '虚线边 + 更圆的角' }
]

const cards = cases.map((c, i) => `
  <div class="cell">
    <div class="cap"><b>${c.name}</b><span>${c.tip}</span></div>
    <div class="stage">
      <div class="dshPetRoot">
        <div class="dshPetBubble ${c.kind}" data-dsh-pet-bubble="${c.kind ? (c.kind.indexOf('Shout') > 0 ? 'shout' : 'soft') : 'say'}" id="b${i}">${c.text}</div>
        <img class="sprite" src="./bubble-preview-calm.png" alt="">
      </div>
    </div>
    <button onclick="replay(${i})">重播入场</button>
  </div>`).join('')

const html = `<!doctype html>
<meta charset="utf-8">
<title>桌宠气泡预览 · dsh-pet</title>
<style>
  /* 下面这一段是从 client.js 的 CSS_TEXT 里现抠的，不是抄的 */
${css}

  /* ---- 预览页自己的脚手架，不属于插件 ---- */
  body { margin: 0; padding: 26px 22px 60px; background: #14161d; color: #dfe5f2;
         font: 13px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
  .lede { color: #8b94a8; margin-bottom: 22px; max-width: 900px; }
  .lede code { color: #a9c4ff; }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(220px, 1fr)); gap: 34px 18px; }
  .cell { display: flex; flex-direction: column; }
  .cap { display: flex; flex-direction: column; margin-bottom: 8px; }
  .cap b { font-size: 12.5px; color: #cfd8ea; }
  .cap span { font-size: 11.5px; color: #6f7a90; }
  .stage { position: relative; height: 300px; border-radius: 10px;
           background: linear-gradient(180deg, #1b1f2a, #14161d);
           border: 1px solid rgba(255,255,255,0.06); }
  /* 复刻 .dshPetRoot 的定位：气泡在立绘上方居中，立绘高 29vh 折算成这里的高度 */
  .dshPetRoot { position: absolute; left: 50%; bottom: 24px; width: 132px; height: 176px;
                transform: translateX(-50%); }
  .sprite { display: block; width: 100%; height: 100%; object-fit: contain; }
  /* 定位不在 CSS_TEXT 里，而在内联的 bubbleStyle 里，这里照抄一份 */
  .dshPetBubble { position: absolute; left: 50%; bottom: calc(100% + 6px);
                  transform: translateX(-50%) rotate(var(--dshPetTilt)); }
  button { margin-top: 10px; align-self: flex-start; padding: 4px 10px; border-radius: 6px;
           border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.05);
           color: #c9d3e6; font-size: 11.5px; cursor: pointer; }
  button:hover { background: rgba(255,255,255,.1); }
  .note { margin-top: 30px; padding: 12px 14px; border-left: 2px solid #4a6fa8;
          background: rgba(74,111,168,.08); color: #9fb0cc; max-width: 900px; font-size: 12.5px; }
</style>
<h1>桌宠气泡预览</h1>
<div class="lede">
  这一段 CSS 是从 <code>client.js</code> 的 <code>CSS_TEXT</code> 里现抠的，所以这里看到的就是插件里跑的。
  尾巴是 <code>::after</code> 那个转 45° 的方块 —— 注意它上半截被纸面盖住，底边墨线在尾巴处"断口"是故意的。
</div>
<div class="grid">${cards}</div>
<div class="note">
  改完 <code>client.js</code> 的样式后重跑 <code>node preview_bubbles.js</code> 刷新这一页即可。<br>
  想调的地方：<code>--dshPetPaper</code>（纸面）<code>--dshPetInk</code>（墨线）<code>--dshPetTilt</code>（倾角），
  尾巴位置在 <code>.dshPetBubble::after</code> 的 <code>left</code>。
</div>
<script>
  function replay(i) {
    var el = document.getElementById('b' + i)
    var cls = el.className
    el.className = ''
    void el.offsetWidth          /* 强制重排，动画才会重放 */
    el.className = cls
  }
  /* 进页面时挨个弹一遍，方便一次看全 */
  window.addEventListener('load', function () {
    document.querySelectorAll('.dshPetBubble').forEach(function (el, i) {
      var cls = el.className
      el.style.animation = 'none'
      setTimeout(function () { el.style.animation = ''; el.className = ''; void el.offsetWidth; el.className = cls }, 220 * i)
    })
  })
</script>
`

fs.writeFileSync(OUT, html, 'utf8')
console.log('已生成 ' + OUT)
console.log('  CSS 从 ' + start + '~' + end + ' 行抠出，共 ' + css.split('\n').length + ' 行')
console.log('  立绘副本 ' + SPRITE_COPY)
console.log('双击打开即可；改了 client.js 就重跑本脚本。')
