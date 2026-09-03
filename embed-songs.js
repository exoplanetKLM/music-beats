/* ================================================================
   音乐跳动 · 内嵌歌曲生成脚本（改产物请改本脚本重新生成，勿手改生成文件）

   用法：node embed-songs.js <MP3路径> <输出js路径> <全局变量名> <歌曲名>
   示例：node embed-songs.js "D:\Downlaod\T-ara+-+Sugar+Free.mp3" \
             song-data-sugar-free.js SONG_DATA_SUGAR_FREE "T-ara《Sugar Free》"

   产物格式与 song-data.js 一致（base64 data URL 内嵌，file:// 双击可玩）：
     window.<变量名> = "data:audio/mpeg;base64,..."
   ================================================================ */
'use strict';
const fs = require('fs');

const [, , mp3Path, outPath, varName, songName] = process.argv;
if (!mp3Path || !outPath || !varName) {
  console.error('用法：node embed-songs.js <MP3路径> <输出js路径> <全局变量名> <歌曲名>');
  process.exit(1);
}

const buf = fs.readFileSync(mp3Path);
const sizeMB = (buf.length / 1024 / 1024).toFixed(1);
const header =
  '// 音乐跳动 · 内嵌歌曲数据（base64 data URL，由 embed-songs.js 从 MP3 生成，勿手改）\n' +
  '// 歌曲：' + (songName || mp3Path) + '，约 ' + sizeMB + 'MB（BPM 由页面节拍分析自动校准）\n';
fs.writeFileSync(
  outPath,
  header + 'window.' + varName + ' = "data:audio/mpeg;base64,' + buf.toString('base64') + '";\n'
);
console.log('已生成 ' + outPath + '（源 ' + sizeMB + 'MB，输出 ' +
  (fs.statSync(outPath).size / 1024 / 1024).toFixed(1) + 'MB）');
