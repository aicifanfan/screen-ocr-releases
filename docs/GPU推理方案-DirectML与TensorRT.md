# GPU 推理方案（RapidOCR + onnxruntime 栈）

> 先纠正一个前提：`enable_hpi` / `use_tensorrt` / `precision="fp16"` 是 **PaddleOCR / Paddle Inference** 的参数。
> 我们的栈是 RapidOCR + onnxruntime，没有这些开关，但有**功能等价物**（部分更强）。

## 0. 术语对照

| Paddle 的说法 | 我们的等价物 | 现状 |
|---|---|---|
| `enable_hpi=True`（高性能推理插件，自动挑 TRT/oneDNN/OpenVINO） | 选执行提供者（EP）：`EngineConfig.onnxruntime.use_dml / use_cuda`，或直接换 `engine_type` | 现在全 CPU |
| `use_tensorrt=True` | **RapidOCR 原生有 TRT 引擎**：`engine_type="tensorrt"`（自己从 ONNX 构建 engine，带缓存） | 未启用 |
| `precision="fp16"` | TRT：`EngineConfig.tensorrt.use_fp16=True`；DirectML：内部已自动用 fp16 | — |
| `batch_size` | `Rec.rec_batch_num`（当前 12） | 12 |

RapidOCR 3.10.0 的 `engine_cfg.yaml` 里可用的分支：`onnxruntime`（`use_cuda / use_dml / use_cann / use_coreml`）、
`openvino`、`paddle`、`torch`、`tensorrt`（`use_fp16 / use_int8 / workspace_size / cache_dir / force_rebuild`）、`mnn`。

## 1. 三条路线，先看账

| 路线 | 做法 | 包体增量 | 实测/预估收益 | 覆盖设备 |
|---|---|---:|---|---|
| **A. DirectML**（推荐） | 换 `onnxruntime-directml`，`use_dml=True` | **+32 MB** | **已实测**：均衡 2.1×、精修 21.5× | Windows 任意显卡（NVIDIA/AMD/Intel） |
| B. CUDA EP | `onnxruntime-gpu` + `use_cuda=True` | +700 MB ~ 1 GB | 预估介于 A 与 C 之间 | 仅 NVIDIA，需匹配驱动/CUDA |
| C. TensorRT | `engine_type="tensorrt"` + `use_fp16=True` | +1 GB 以上（TRT 运行库） | 未实测；预估比 A 再快 20–50%（medium 这类大模型） | 仅 NVIDIA，且架构必须匹配 |

**结论：默认走 A；C 作为"高级用户可选"，B 不推荐**（包体最大、收益被 A/C 夹在中间）。

## 2. 已实测数据（路线 A，本机 RTX 5060 Laptop）

真实图片 2560×1600 / 17 行，同一套参数：

| 形态 | CPU | DirectML | 加速 |
|---|---:|---:|---:|
| 均衡：det_small + rec_small | 693.8 ms | **329.8 ms** | 2.1× |
| 精修：det_small + rec_medium | 8951.0 ms | **415.6 ms** | **21.5×** |

- onnxruntime 体积 33 MB → 65 MB；
- 同一张图 **17/17 行文本逐字一致**；
- 会话构建 14 vs 15 ms（首次推理才编译，已被现有预热覆盖）。

预测产品效果：高精度档 100 行精修 ≈53s → **≈2.5s**；均衡 100 行 ≈1.9s → ≈0.5s。

## 3. 关于 fp16 和 batch_size（这两条要具体对待）

### 3.1 fp16

| 路线 | fp16 怎么来 | 风险 |
|---|---|---|
| DirectML | **自动**（DML 对支持的算子用 fp16 内部计算） | 已对拍一致，风险低 |
| TensorRT | 显式 `use_fp16=True` | 需要精度回归：medium 在退化样本上 CER 0.72%，fp16 可能再涨一点，**上线前必须 20 张以上对拍** |
| CUDA EP | 不支持（模型是 fp32 权重，ORT 不自动降精度） | — |

### 3.2 batch_size

现在是 `Rec.rec_batch_num = 12`。GPU 上增大批量的收益来自摊薄启动/传输开销，
但 **显存随之增长**（12→64 约 5×），且延迟变高（一批算完才出结果，会影响流式精修的"批"粒度）。

建议：
- 结构化/批量场景：32–48；
- 交互场景（我们）：**维持 12**，靠"多批流式推送"降低首字延迟。实测调参放在实施阶段做（`12 / 24 / 48` 三档对比）。

## 4. 具体改动点

### 4.1 侧车：设备探测 + 回落（`python/ocr_server.py`）

```python
def pick_provider():
    """返回 'dml' | 'cuda' | 'cpu'，失败一律回落 cpu（不能用异常把识别打死）"""
    dev = (os.environ.get("SCREEN_OCR_DEVICE") or "auto").lower()   # auto|cpu|dml|cuda
    if dev == "cpu":
        return "cpu"
    try:
        import onnxruntime as ort
        avail = ort.get_available_providers()
    except Exception:
        return "cpu"
    if dev in ("dml", "cuda"):
        return dev if (f"{dev.upper()}ExecutionProvider" in "".join(avail) or "DirectMLExecutionProvider" in "".join(avail)) else "cpu"
    # auto：优先 DML（Windows 通用），其次 CUDA
    if "DmlExecutionProvider" in avail: return "dml"
    if "CUDAExecutionProvider" in avail: return "cuda"
    return "cpu"
```

- `build_params()` 里按 provider 加 `use_dml` / `use_cuda`，**并在建引擎失败时重试 CPU**：
  ```python
  try: eng = new_engine(profile, provider)
  except Exception as e:
      _emit({"type": "warn", "message": f"{provider} 建引擎失败({e})，回落 CPU"})
      eng = new_engine(profile, "cpu")
  ```
- `ready` 消息里回传实际 provider，主进程写日志、设置页展示。

### 4.2 主进程 / 设置页

| 位置 | 改动 |
|---|---|
| `src/main/config.js` | 新增 `gpuAccel: 'auto'`（auto / cpu），默认 auto |
| `src/shared/profiles.js` 或新 `devices.js` | 设备选项常量（与档位解耦，避免又一堆散落字符串） |
| `src/main/index.js` | 启动/切换时把 `SCREEN_OCR_DEVICE` 传给 sidecar；`ocr:ready` 里记录实际 provider |
| `settings.html/js` | 新增"GPU 加速（自动/仅 CPU）"下拉；显示"当前：DirectML" 之类的只读状态 |

### 4.3 构建与打包

| 文件 | 改动 |
|---|---|
| `python/requirements-perf.txt`（或 build-py 的钉死列表） | `onnxruntime` → **`onnxruntime-directml==1.20.1`**（该包自带 `CPUExecutionProvider`，无 GPU 自动回落） |
| `scripts/build-py.js` | 校验打包后 `_internal/onnxruntime/capi/*.dll` 是否含 DML 相关（`DirectML.dll`、`onnxruntime_providers_dml.dll`） |
| `.venv-perf` | 重装依赖（会替换 onnxruntime，影响现有测试，需一次性验证） |

### 4.4 测试

| 测试 | 内容 |
|---|---|
| `tests/perf/gpu-e2e.py`（已有） | CPU vs DML 的耗时与文本一致性 |
| 新增 `tests/test_device_fallback.py` | 伪造 provider 列表：只有 CPU 时必须回落且不报错；请求 dml 但不可用时回落 |
| 新增 `python/tools/parity_cpu_gpu.py` | 20 张图跑两遍，逐行对比文本，输出差异率（上线门禁：差异率 0） |
| 现有 `npm test` / UI 测试 | 不受影响（不碰渲染层协议） |

## 5. 验证清单

**性能**（同机、同图、交错 A/B，各 3 次取中位）
- [ ] 均衡整屏 100 行：CPU vs DML
- [ ] 高精度精修 100 行：CPU vs DML
- [ ] 快速档（det 占大头）：CPU vs DML
- [ ] batch 12 / 24 / 48 的延迟与显存

**精度**
- [ ] 20 张图 CPU vs GPU 逐行文本一致率 = 100%
- [ ] 退化样本（小字、低对比、混合中英）单独看

**稳定性**
- [ ] 无 GPU 机器（或禁用显卡）：自动回落 CPU，日志有 warn
- [ ] 老驱动/虚拟机：DML 建会话失败 → 回落且不影响使用
- [ ] 连续 50 次截图：无显存泄漏、无会话堆积（每次复用同一 engine）
- [ ] 与"精修可抢占"共存：切档位、连续截图不阻塞

## 6. 风险与回滚

| 风险 | 处置 |
|---|---|
| 老驱动 DML 建会话失败 | try/except 回落 CPU，`ready` 上报实际 provider |
| 多显卡笔记本（独显/核显切换） | DML 默认选系统默认适配器；异常时回落；设置页可切"仅 CPU" |
| 显存不足（大图 + medium + 大 batch） | batch 维持 12；异常回落 |
| 精度漂移 | 门禁：对拍差异率必须为 0，否则回滚到 CPU |
| 包体 | +32 MB，可接受；不做可选组件 |

**回滚开关**：设置页"仅 CPU"即可，无需重装。

## 7. 分期实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0**（0.5 天） | 侧车设备探测 + 回落 + `ready` 上报 provider；`SCREEN_OCR_DEVICE` 环境变量可控 | 强制 cpu/dml 都能起，异常时回落 |
| **P1**（1 天） | 构建换 `onnxruntime-directml`，重打包；跑 `gpu-e2e.py` 与对拍 | 包体 +32 MB 内，精度 100% 一致 |
| **P2**（0.5 天） | 设置页"GPU 加速：自动/仅 CPU" + 状态展示 + i18n | 设置页测试通过 |
| **P3**（可选，1–2 天） | TensorRT 路线：`engine_type="tensorrt"` + `use_fp16`，单独构建一个"NVIDIA 加速版" | 与 DML 对比再快 20%+ 才值得发布 |

**先做 P0–P2**：改动小、收益确定（精修 21.5×）。TRT 等有实测数据再决定是否发第二个包。

---

## 实施结果（0.3.7，仅 P0–P2）

已落地：设备探测 `pick_device()`（auto/cpu/dml/cuda）、建会话失败回落 CPU、`ready` 上报实际设备、
设置页「识别加速：自动 / 仅 CPU」、构建换 `onnxruntime-directml==1.20.1` 并在打包后校验 `DirectML.dll`。

| 验证项 | 结果 |
|---|---|
| 均衡档（2560×1600 / 17 行） | 754 ms → **217 ms**（3.5×） |
| 精修 medium 全量 17 行 | 26.5 s → **307 ms**（86×） |
| 包内侧车 accurate 端到端 | 2611 ms → **442 ms**（5.9×） |
| 精度对拍 | 10 张图 / 99 行，**逐行 100% 一致** |
| 回落路径 | 请求 cuda（未装）→ `device=cpu, fallback=true`，功能正常 |
| 应用冒烟 | 启动日志 `OCR 就绪：实际档位 balanced \| 推理设备 dml` |
| 回归 | npm test / 结果页 61 项 / 设置页 / 遮罩 / 截屏 / 复制 / 多屏 / 精修抢占 全 PASS |

**遗留（P3，未做）**：TensorRT 路线（`engine_type="tensorrt"` + `use_fp16`）。
需额外 ~1 GB 运行时，且 engine 与 GPU 架构/TRT 版本绑定（RTX 50 系要 CUDA 12.8+ / TRT 10.7+）。

**踩坑记录**：打包校验最初写成期待 `onnxruntime_providers_dml.dll`，实际 DirectML EP 编在
`onnxruntime.dll` 内，独立文件只有 `DirectML.dll` —— 校验误报了一次，已修正为检查
`DirectML.dll` + `onnxruntime_providers_shared.dll`。
