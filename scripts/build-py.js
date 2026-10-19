// 构建 Python 侧车：优先用项目内钉死版本的 venv，构建完自动同步模型。
//
// 为什么不用裸 pyinstaller：
//   1) 版本漂移会让「优化前后」不可比（rapidocr / onnxruntime / numpy 必须与包内一致）；
//   2) PyInstaller 产物里的 rapidocr/models 是空的（模型不在 wheel 里），
//      不同步就会出现「联网现场下载 / 离线静默回退 balanced」。
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const VENV_PY = path.join(ROOT, '.venv-perf', 'Scripts', 'python.exe')
const PY = fs.existsSync(VENV_PY) ? VENV_PY : 'python'

function run(args, label) {
  console.log('[build-py] ' + label + ': ' + PY + ' ' + args.join(' '))
  const r = spawnSync(PY, args, { cwd: ROOT, stdio: 'inherit' })
  if (r.error) {
    console.error('[build-py] 启动失败: ' + r.error.message)
    if (PY === 'python') {
      console.error('[build-py] 建议先建 venv：')
      console.error('  uv venv .venv-perf --python 3.12')
      console.error('  uv pip install --python .venv-perf/Scripts/python.exe rapidocr==3.10.0 onnxruntime==1.20.1 numpy==2.5.4 onnx pyinstaller')
    }
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error('[build-py] ' + label + ' 失败（exit ' + r.status + '）')
    process.exit(r.status || 1)
  }
}

run([
  '-m', 'PyInstaller',
  'python/ocr_server.py',
  '--onedir',
  '--name', 'ocr_server',
  '--distpath', 'python/ocr_pkg',
  '--workpath', 'build/pyi',
  '--noconfirm',
  '--collect-all', 'rapidocr',
  '--collect-all', 'onnxruntime',
], 'pyinstaller')

// 构建后必须同步模型（含 INT8 覆盖与 yaml 哈希对齐），否则产物不可用
run(['python/tools/sync_models.py'], 'sync_models')

console.log('[build-py] 完成 -> python/ocr_pkg/ocr_server')
