// 生成可独立打开的演示页：把 result.html 的样式/结构、i18n 与 result.js 内联，
// 并注入一份模拟 window.api + 示例识别结果。
// 目的：不启动 OCR、不装 Electron 也能体验真实的结果页交互；页面永远由源码生成，避免与实现脱节。
// 用法：npm run demo:html
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const LINES = [
  '订单编号 A-2024-001 已发货',
  '收件人：张伟　联系电话 138****6621',
  '地址：杭州市余杭区文一西路 969 号',
  '商品：机械键盘 ×1　USB-C 数据线 ×2',
  '金额：¥ 328.00（含运费 ¥ 0.00）',
  '预计送达 10 月 21 日 · 顺丰速运 SF1234567890'
]

// 用 SVG 充当“截图”，文字与识别行一一对应，识别框才有意义
function sampleImage() {
  const rows = LINES.map((text, i) =>
    `<text x="26" y="${50 + i * 48}" font-family="Microsoft YaHei, sans-serif" font-size="19" fill="#1f2937">${text}</text>`
  ).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="340">
    <rect width="720" height="340" fill="#ffffff"/>
    <rect x="0" y="0" width="720" height="34" fill="#f1f5f9"/>
    <text x="26" y="23" font-family="Microsoft YaHei, sans-serif" font-size="13" fill="#64748b">订单详情 · 2026-10-19</text>
    ${rows}
  </svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

const boxes = LINES.map((_, i) => [24, 24 + i * 48, 640, 64 + i * 48])
const sample = {
  screens: [{
    label: '',
    image: sampleImage(),
    texts: LINES,
    boxes,
    scores: [0.99, 0.98, 0.97, 0.96, 0.95, 0.93]
  }]
}

const mock = `
<script>
/* 演示用的主进程替身：只实现结果页会调用到的接口 */
(function () {
  var SAMPLE = ${JSON.stringify(sample)};
  var copied = null;

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta);
  }

  window.api = {
    initialLanguage: 'zh',
    getResult: function () { return Promise.resolve(SAMPLE); },
    getSettings: function () { return Promise.resolve({ autoCloseAfterCopy: false }); },
    setSettings: function () { return Promise.resolve({ ok: true }); },
    copyText: function (text) {
      copied = text;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
      } else {
        fallbackCopy(text);
      }
      return Promise.resolve();
    },
    // 演示模式不真的关窗，避免页面直接消失
    closeResult: function () { return Promise.resolve(); },
    openSettings: function () { return Promise.resolve(); },
    onUpdate: function () {},
    onLanguageChanged: function () {},
    __copied: function () { return copied; }
  };
})();
</script>`

const html = read('src/renderer/result.html')
  // 外链样式表内联：演示页要能脱离 styles/ 目录单独打开/分享
  .replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/g, (_m, href) => {
    const css = read(path.join('src/renderer', href))
    return `<style>\n/* ${href} */\n${css}\n</style>`
  })
  .replace(
    '<script src="../shared/i18n.js"></script>',
    // 内联的 JS 里若出现 </script>（哪怕在注释中），HTML 解析器也会提前结束脚本块，
    // 因此统一转义为 <\/script。
    `<script>\n${read('src/shared/i18n.js').replace(/<\/script/gi, '<\\/script')}\n</script>`
  )
  .replace(
    '<script src="result.js"></script>',
    `${mock}\n<script>\n${read('src/renderer/result.js').replace(/<\/script/gi, '<\\/script')}\n</script>`
  )
  .replace(
    '<head>',
    '<head>\n<!-- 自动生成，请勿手改：npm run demo:html（源：src/renderer/result.html） -->'
  )

const out = path.join(ROOT, 'docs', 'result-demo.html')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, html)
console.log('generated: ' + path.relative(ROOT, out) + '  (' + Buffer.byteLength(html) + ' bytes)')
