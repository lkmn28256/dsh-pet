#!/usr/bin/env python3
"""全仓行尾检查：任何文本文件出现 CRLF 或混合行尾就失败（退出码 1）。

为什么对这个项目较真：client.js 是单文件，而变异测试靠字符串锚点定位，
锚点里的换行写的是 \n。文件一旦被某个编辑器改成 CRLF，所有含换行的锚点
会集体落空 —— mutation_check.js 会报"跳过"，看起来像没事发生。
行尾在这个项目里不是风格问题，是正确性问题。
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv"}
TEXT_EXT = {".js", ".mjs", ".cjs", ".py", ".json", ".md", ".yml", ".yaml",
            ".html", ".css", ".txt", ".sh", ".ts", ".tsx"}

bad = 0
total = 0
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
    for name in sorted(filenames):
        if os.path.splitext(name)[1].lower() not in TEXT_EXT:
            continue
        p = os.path.join(dirpath, name)
        with open(p, "rb") as f:
            b = f.read()
        crlf = b.count(b"\r\n")
        lf = b.count(b"\n")
        total += 1
        if crlf == 0:
            kind = "LF"
        elif crlf == lf:
            kind = "CRLF"
        else:
            kind = "MIXED"
        if kind != "LF":
            bad += 1
        rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
        print("%-42s CRLF=%-5d LF=%-5d %s%s" % (rel, crlf, lf, kind,
                                                "" if kind == "LF" else "   <- 要改成 LF"))

print()
if bad:
    print("%d/%d 个文本文件不是纯 LF —— 先修好再提交。" % (bad, total))
    sys.exit(1)
print("%d 个文本文件全部是纯 LF。" % total)
