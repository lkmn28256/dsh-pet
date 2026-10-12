/*
 * 粗糙但有效的"未定义标识符"扫描器。
 *
 * 为什么需要它：client.js 是单文件、2600+ 行、塞在一个工厂函数里，
 * `node --check` 只查语法不查引用；而"调了一个没定义的函数"要等到
 * 运行到那一行才炸（React 错误边界会把整个桌宠干掉，表现是"啥都不显示"）。
 * 这一路已经踩过两次（useSessionState 的条件 hook、exprSafe() 的笔误）。
 *
 * 做法：扒出所有 "被调用的标识符"，减去 "声明过的名字" 与 "已知全局"，
 * 剩下的就是可疑目标；再排除 obj.method() 形式（那是属性不是标识符）。
 */
const fs = require('fs')
const path = require('path')

/* 默认扫仓库里这份；想扫"正在运行的那份插件"，用 DSH_PET_CLIENT=... 指过去。 */
const CLIENT = process.env.DSH_PET_CLIENT || path.join(__dirname, '..', 'client.js')
const src = fs.readFileSync(CLIENT, 'utf8')

/* 先粗暴去掉字符串字面量与注释，避免把文本里的词当代码 */
function strip(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && c2 === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i++
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) { i++; break }
        i++
      }
      out += '""'
      continue
    }
    out += c
    i++
  }
  return out
}

const code = strip(src)

/* ---- 声明：function foo / const foo = / let foo / var foo / 形参 ---- */
const declared = new Set()
for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
/* 解构声明 const { a, b } = / const [a, b] = */
for (const m of code.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) {
  for (const part of m[1].split(',')) {
    const name = part.split(':').pop().split('=')[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
  }
}
/* 形参：把每个函数的参数名加进去（不精确但够用） */
for (const m of code.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
  for (const part of m[1].split(',')) {
    const name = part.split('=')[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
  }
}
for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
  for (const part of m[1].split(',')) {
    const name = part.split('=')[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
  }
}
for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1])
/* class 名与方法名 */
for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])

/* ---- 已知全局 / 宿主对象 ---- */
const GLOBALS = new Set([
  'window', 'document', 'console', 'Math', 'Date', 'JSON', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Set', 'Map', 'Promise', 'Error', 'RegExp',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'encodeURIComponent',
  'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'localStorage', 'navigator', 'performance', 'URLSearchParams', 'Symbol',
  'Function', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false',
  'this', 'super', 'arguments', 'require', 'module', 'exports', 'process',
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'delete',
  'void', 'in', 'of', 'do', 'else', 'try', 'finally', 'throw', 'case', 'break',
  'continue', 'default', 'class', 'extends', 'const', 'let', 'var', 'function',
  'get', 'set', 'async', 'await', 'yield', 'static',
])

/* ---- 被调用的标识符：前面不是 . 且后面紧跟 ( ---- */
const called = new Map()
for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
  const name = m[2]
  if (GLOBALS.has(name)) continue
  if (declared.has(name)) continue
  called.set(name, (called.get(name) || 0) + 1)
}

const bad = Array.from(called.entries()).sort((a, b) => b[1] - a[1])
if (bad.length === 0) {
  console.log('OK  没有发现"调用但未声明"的标识符')
} else {
  console.log('可疑的未定义调用（名字 × 次数）：')
  for (const [name, cnt] of bad) console.log('  ' + name + ' ×' + cnt)
}
console.log('已声明 ' + declared.size + ' 个名字，扫描 ' + code.length + ' 字符')
