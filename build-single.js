/* ================================================================
   音乐跳动 · 单文件打包脚本（零依赖，把全部资源内联进一个 HTML）

   用法：node build-single.js [输出文件路径]
   默认：dist/音乐跳动-单文件.html（微信/安卓文件名可靠；若对方反馈
         乱码，可重新生成 ASCII 版：node build-single.js dist/music-beats.html）

   产出：style.css 内联为 <style>，本地 script 按原顺序内联为 <script>
         （歌曲数据在前、game.js 在后），双击即玩（file:// 兼容），
         约 37MB（三首歌的 base64 音频是大头，压缩需另配 ffmpeg）。
   ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || path.join('dist', '音乐跳动-单文件.html');
const sizeStr = (p) => {
  const b = fs.statSync(p).size;
  return (b / 1024 / 1024).toFixed(1) + 'MB（' + (b / 1024 / 1024 / 1024).toFixed(2) + 'GiB）';
};

let html = fs.readFileSync('index.html', 'utf8');

// 1) 内联 CSS：<link ... href="style.css"> → <style>
//    注意用函数式替换：字符串替换参数会把 $&、$'、$1 等解释为特殊序列
const LINK_RE = /<link[^>]*href="style\.css"[^>]*>/;
if (!LINK_RE.test(html)) {
  console.error('自检失败：index.html 中未找到 style.css 的 <link> 标签');
  process.exit(1);
}
const css = fs.readFileSync('style.css', 'utf8').replace(/<\/style/gi, '<\\/style');
html = html.replace(LINK_RE, () => '<style>\n' + css + '\n</style>');

// 2) 内联 JS：按出现顺序提取并替换（歌曲数据必须在 game.js 之前，保序即保正确）
//    </script 转义为防御性措施（base64 字母表不含 <，当前各文件均无此子串）
//    歌曲脚本是 jsDelivr 绝对地址（在线版加速用）：按 URL 的文件名找本地同名文件内联，
//    保证单文件完全离线可玩；其余 http(s) 外部脚本保持引用
const tags = html.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g) || [];
let inlineCount = 0;
for (const tag of tags) {
  const src = tag.match(/src="([^"]+)"/)[1];
  let local = src;
  if (/^https?:/i.test(src)) {
    const base = path.basename(src);
    if (fs.existsSync(base) && /\.js$/.test(base)) local = base;
    else continue; // 其他外部脚本保持引用，不内联
  }
  const js = fs.readFileSync(local, 'utf8').replace(/<\/script/gi, '<\\/script');
  html = html.replace(tag, () => '<script>\n' + js + '\n</script>');
  inlineCount++;
}

// 3) 自检 + 写出
if (/<script[^>]*src=/.test(html) || /href="style\.css"/.test(html)) {
  console.error('自检失败：产物中仍残留未内联的引用');
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('已生成 ' + OUT + '（内联 ' + inlineCount + ' 个脚本 + 1 个样式表，' + sizeStr(OUT) + '）');
