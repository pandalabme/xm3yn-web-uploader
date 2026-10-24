# XM3YN Web Uploader

面向 `XM3YN@ E31A`（296 × 152 黑白黄屏）的纯网页图片导入工具。图片只在浏览器本地处理；网页通过 Web Bluetooth 完成握手、分包、确认、刷新和诊断记录。

## 本地开发

```powershell
npm install
npm test
npm run typecheck
npm run dev
```

旧版 Android Chrome（例如 Chrome 78）不能运行 Vite 8 的开发客户端。通过 ADB 连接这类手机时，停止 `npm run dev`，改用兼容生产构建：

```powershell
npm run phone
```

该命令会构建 Chrome 78 目标并在 `127.0.0.1:5173` 提供静态预览；随后继续使用 `adb reverse tcp:5173 tcp:5173` 和手机端 `http://localhost:5173`。

兼容构建只保证页面和图片预览能够显示。Chrome 78 仅公开旧版 `writeValue()`，不能显式选择已经由 nRF Connect Macro 验证的 `WRITE_REQUEST`。应用会允许设备发现和握手诊断，但会禁用清屏和图片上传；更新 Chrome 并重新连接后，页面必须显示“显式 WRITE_REQUEST”才允许写屏。

桌面浏览器可用于检查界面和图片预览，但本项目的实机目标环境是 Android Chrome。手机直接访问电脑的普通局域网 `http://电脑IP:5173` 不属于安全上下文，通常不能使用 Web Bluetooth。

可选的 USB 调试方式是在安装 ADB 并启用手机 USB 调试后执行：

```powershell
adb reverse tcp:5173 tcp:5173
```

随后在手机 Chrome 打开 `http://localhost:5173`。正式使用应执行 `npm run build`，把 `dist/` 部署到 HTTPS 静态站点。

## 使用顺序

1. 在 Android Chrome 打开 HTTPS 页面，点击“连接价签”。
2. 选择 XM3YN 设备，等待连接、服务发现和握手全部完成。
3. 选择图片并确认 296 × 152 三色预览。默认启用“红色映射为黄色”，与项目现有 Python/Macro 基线一致。
4. 首次实机验证使用“安全”模式；完成三次稳定上传后再试“自动探测”。
5. 上传期间保持页面在前台，不要锁屏；出现失败时导出诊断记录。

“双平面纯白诊断”不会使用含义不可靠的 `00 FF` 短清屏命令，而是走正式图片协议：完整写入 5,624 字节的全 `FF` 黑白平面和 5,624 字节的全 `00` 黄色平面，再执行全屏刷新。它仅在浏览器提供显式 `writeValueWithResponse()` 时启用。

安全模式使用 16 字节图像负载；自动模式先尝试 240 字节负载，失败后从当前颜色平面起点降级到安全模式。程序只在设备确认数据包后推进进度。

## 验证与文档

- `npm test`：协议、图像金标、状态机、Macro 与诊断测试。
- `npm run build`：类型检查并生成 `dist/`。
- [`docs/protocol.md`](docs/protocol.md)：已验证的 UUID、命令和 ACK 规则。
- [`docs/device-test-checklist.md`](docs/device-test-checklist.md)：Android Chrome 实机验收清单。

当前 nRF Connect Macro 解析/执行兼容层位于 `src/macro/`，用于回归和辅助诊断；主图片上传路径不依赖 nRF Connect。

如果网页上传完成但屏幕内容异常，可在图片处理完成后点击“导出快速 Macro”。导出的
`xm3yn-current-fast-nrf.xml` 直接使用当前预览对应的两块平面数据，并生成与已验证
`XM3YN weather fast v2` 相同的 MTU 247、240 字节负载 WRITE_REQUEST 序列。把它导入 Android
nRF Connect 播放：如果 Macro 正常而网页异常，问题在 Web Bluetooth 运行时或传输节奏；如果
二者结果相同，优先检查图片编码方向、价签供电和屏幕驱动。
