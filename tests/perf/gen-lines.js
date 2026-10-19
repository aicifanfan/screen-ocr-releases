// 生成「行数递增」的图（同版式、同字号、同画布），用于测每行边际成本
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})

const LINES = [
  '订单编号：A-2024-001  状态：已发货',
  '收件人：张伟   联系电话 138****6621',
  '地址：杭州市余杭区文一西路 969 号',
  '商品：机械键盘 ×1    USB-C 数据线 ×2',
  '金额：¥ 328.00（含运费 ¥ 0.00）',
  '预计送达 10 月 21 日 · 顺丰速运',
  'Invoice No. A-2024-001  Status: shipped',
  'Total amount: 328.00 CNY (freight 0.00)',
  '备注：请在工作日 9:00-18:00 签收',
  '客服热线：400-820-8820  分机 2',
  '物流轨迹：杭州转运中心 → 上海分拨',
  '签收码：X7K9*Q   （区分大小写）',
  '发票类型：电子普通发票  税率 13%',
  '支付方式：微信支付  交易号 4200001234',
  '仓库：WH-HZ-02   拣货员：李强',
  '称重：2.35 kg   体积：30×20×12 cm',
  '合计：壹佰贰拾捌元整  ¥128.00',
]

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 400, height: 300 })
  await w.loadURL('data:text/html,<html></html>')

  for (const n of [1, 4, 9, 17]) {
    const dataUrl = await w.webContents.executeJavaScript(`(function(){
      const W = 1280, H = 800;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
      x.fillStyle = '#111827'; x.font = '26px "Microsoft YaHei", sans-serif';
      const lines = ${JSON.stringify(LINES)}.slice(0, ${n});
      lines.forEach((t, i) => x.fillText(t, 32, 60 + i * 44));
      return c.toDataURL('image/png');
    })()`)
    fs.writeFileSync(path.join(__dirname, 'lines-' + n + '.b64'), dataUrl.split(',')[1])
    console.log('lines-' + n, 'b64chars=' + (dataUrl.length - 22))
  }

  const blank = await w.webContents.executeJavaScript(`(function(){
    const c = document.createElement('canvas'); c.width = 1280; c.height = 800;
    const x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, 1280, 800);
    return c.toDataURL('image/png');
  })()`)
  fs.writeFileSync(path.join(__dirname, 'blank-1280.b64'), blank.split(',')[1])
  console.log('blank-1280 ok')
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
