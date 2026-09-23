/* ================================================================
   音乐跳动 · 单文件打包脚本（零依赖，把全部资源内联进一个 HTML）

   用法：node build-single.js [输出文件路径]
   默认：dist/音乐跳动-单文件.html（微信/安卓文件名可靠；若对方反馈
         乱码，可重新生成 ASCII 版：node build-single.js dist/music-beats.html）

   产出：style.css 内联为 <style>，本地 script 按原顺序内联为 <script>
         （歌曲数据在前、game.js 在后），双击即玩（file:// 兼容），
         约 20MB（内置 5 首歌的 base64 音频是大头；网页版是按需加载、且 18 首全可用）。
         单文件版**刻意只内置 5 首**——全量内联会让产物涨到约 78MB，手机浏览器解析
         不动、微信也传不动。要换内置哪几首，改下面的 SONGS 子集即可（自检会核对）。
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
//    其余 http(s) 外部脚本保持引用（当前没有这样的脚本）
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

// 2b) 歌曲数据加载器 → 「按需加载短路桩 + 内联数据」
//     单文件没有网络可言（也常在 file:// 下打开），内联的歌必须整段嵌进来；同时把
//     __loadSongScript 短路成「永远已就绪」，game.js 一行都不用为单文件版特判。
//
//     ★ 这是**刻意的子集**：曲库 2026-09-23 扩到 18 首后，全量内联会让产物从
//       约 20MB 涨到约 78MB，手机浏览器解析不动、微信也传不动。所以单文件版只内置
//       下面这 5 首，其余 13 首只在网页版可选（网页版按需加载，首屏不受影响）。
//       game.js 会读 __SINGLE_SONG_IDS 把弹窗里其余的曲目滤掉，避免「点了却静默回退」。
// id ↔ 数据文件的对应关系。id 必须与 game.js 的 SONGS 里一致，否则启动时按 id 找不到曲目。
const SONGS = [
  { id: 'no9', file: 'song-data.js' },
  { id: 'sugar-free', file: 'song-data-sugar-free.js' },
  { id: 'sexy-love', file: 'song-data-sexy-love.js' },
  { id: 'shattered', file: 'song-data-shattered.js' },
  { id: 'flower', file: 'song-data-flower.js' },
];
const SHIM = '<script>\n' +
  '  // 单文件版：下面的歌曲数据已内联，按需加载直接短路成「已就绪」\n' +
  '  window.__loadSongScript = function () { return Promise.resolve(true); };\n' +
  '  window.__SINGLE_SONG_IDS = [' + SONGS.map((s) => JSON.stringify(s.id)).join(', ') + '];\n' +
  '</script>';
const LOADER_RE = /<!--\s*SONG_DATA:START\s*-->[\s\S]*?<!--\s*SONG_DATA:END\s*-->/;
if (!LOADER_RE.test(html)) {
  console.error('自检失败：index.html 中未找到 SONG_DATA:START/END 标记');
  process.exit(1);
}
// 自检：上面每一对 (id, file) 都要能在 game.js 里找到对应的一行 SONGS 条目。
// 过去这里只有「列表里的文件在不在」的正向检查，漏写新歌**不会报错**——产物里点那首歌会
// 静默回退 No.9，是最难自查的失败模式。现在改成双向核对，对不上当场退出。
const gameSrc = fs.readFileSync('game.js', 'utf8');
for (const { id, file } of SONGS) {
  const row = new RegExp("\\{\\s*id:\\s*'" + id + "'\\s*,\\s*name:\\s*'[^']*'\\s*,\\s*file:\\s*'" + file + "'");
  if (!row.test(gameSrc)) {
    console.error('自检失败：game.js 的 SONGS 里找不到 id=' + id + ' 且 file=' + file + ' 的条目');
    process.exit(1);
  }
}
const songs = SHIM + '\n' + SONGS.map(({ file }) => {
  if (!fs.existsSync(file)) { console.error('自检失败：缺少歌曲数据文件 ' + file); process.exit(1); }
  return '<script>\n' + fs.readFileSync(file, 'utf8').replace(/<\/script/gi, '<\\/script') + '\n</script>';
}).join('\n');
html = html.replace(LOADER_RE, () => songs);
inlineCount += SONGS.length;
if (html.length > 40 * 1024 * 1024) {
  console.warn('警告：产物超过 40MB，手机浏览器解析会明显变慢——请确认 SONGS 子集没被误扩大');
}

// 3) 自检 + 写出
if (/<script[^>]*src=/.test(html) || /href="style\.css"/.test(html)) {
  console.error('自检失败：产物中仍残留未内联的引用');
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('已生成 ' + OUT + '（内联 ' + inlineCount + ' 个脚本 + 1 个样式表，' + sizeStr(OUT) + '）');
