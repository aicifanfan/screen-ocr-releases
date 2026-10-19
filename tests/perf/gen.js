// 生成基准图：同一版式在不同分辨率下渲染（模拟截图选区 / 全屏 2x）
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})

const LINES = [
  '订单编号：A-2024-001  状态：已发货',
  '收件人：张伟   联系电话 138****6621',
  '地址：杭州市余杭区文一西路 969 号 3 幢 502',
  '商品：机械键盘 ×1    USB-C 数据线 ×2',
  '金额：¥ 328.00（含运费 ¥ 0.00）',
  '预计送达 10 月 21 日 · 顺丰速运 SF1234567890',
  'Invoice No. A-2024-001  Status: shipped',
  'Total amount: 328.00 CNY  (freight 0.00)',
  '备注：请在工作日 9:00-18:00 签收',
  '客服热线：400-820-8820  分机 2',
  '物流轨迹：杭州转运中心 → 上海分拨中心',
  '签收码：X7K9*Q   （区分大小写）',
  '发票类型：电子普通发票  税率 13%',
  '支付方式：微信支付  交易号 4200001234',
  '仓库：WH-HZ-02   拣货员：李强',
  '称重：2.35 kg   体积：30×20×12 cm',
]

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 400, height: 300 })
  await w.loadURL('data:text/html,<html></html>')

  // 基准画布 2560×1600（模拟 2x DPI 全屏截图），再按比例缩到其它尺寸
  const png = await w.webContents.executeJavaScript(`(function(){
    const W = 2560, H = 1600;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
    // 折叠面板式的浅灰分隔，接近真实截图
    x.fillStyle = '#f1f5f9'; x.fillRect(0, 0, W, 120);
    x.fillStyle = '#111827'; x.font = '600 34px "Microsoft YaHei", sans-serif';
    x.fillText('订单详情 · 已发货', 48, 76);
    x.font = '26px "Microsoft YaHei", sans-serif';
    const lines = ${JSON.stringify(LINES)};
    lines.forEach((t, i) => {
      x.fillStyle = i % 2 ? '#111827' : '#334155';
      x.fillText(t, 48, 190 + i * 78);
    });
    // 右下角一小块二维码占位（非文字区域）
    x.fillStyle = '#e2e8f0'; x.fillRect(2080, 1300, 380, 220);
    return c.toDataURL('image/png');
  })()`)

  const write = (name, dataUrl) => {
    fs.writeFileSync(path.join(__dirname, name + '.b64'), dataUrl.split(',')[1])
    console.log(name, 'b64chars=' + (dataUrl.length - 22))
  }
  write('shot-2560', png)

  // 用 canvas 缩放出 1600 / 1280 / 960 宽，模拟「先降采样再识别」
  for (const width of [1600, 1280, 960]) {
    const scaled = await w.webContents.executeJavaScript(`(function(){
      const img = new Image();
      return new Promise((res) => {
        img.onload = () => {
          const s = ${width} / img.width;
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
          const x = c.getContext('2d');
          x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
          x.drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL('image/png'));
        };
        img.src = ${JSON.stringify(png)};
      });
    })()`)
    write('shot-' + width, scaled)
  }

  // 空白图：det 找不到文字框，用于隔离「检测阶段」耗时
  const blank = await w.webContents.executeJavaScript(`(function(){
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1000;
    const x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, 1600, 1000);
    return c.toDataURL('image/png');
  })()`)
  write('blank-1600', blank)

  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
