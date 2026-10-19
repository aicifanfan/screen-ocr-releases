// 剪贴板
const { clipboard } = require('electron')

function copyText(text) {
  clipboard.writeText(text)
  return text
}

module.exports = { copyText }
