# DSH 语音输入的桌面权限

DSH 的语音输入插件通过 `navigator.mediaDevices.getUserMedia` 请求音频，并用 `MediaRecorder` 录制。桌面壳在默认 Electron session 中只允许当前 DSH 主窗口、当前回环端口同源页面申请音频输入；摄像头、混合音视频请求、其他窗口和跨源 iframe 的媒体请求会被拒绝。网页服务热重启并更换端口后，旧源的授权立即失效。

macOS 打包产物还需要两项声明：`package.json` 的 `NSMicrophoneUsageDescription` 用于系统授权弹窗，主应用和继承的 helper entitlements 中的 `com.apple.security.device.audio-input` 用于 hardened runtime。首次点击 DSH 输入框旁的麦克风时才请求系统授权；拒绝后，网页无法录音。

## 验证

1. `npm run build`，然后运行 `node --test test/desktop-microphone.test.cjs`。
2. 用 `npm run dist:mac` 打包并安装，检查 `DSH-Desktop.app/Contents/Info.plist` 含 `NSMicrophoneUsageDescription`，以及 `codesign -d --entitlements :- /Applications/DSH-Desktop.app` 含 `com.apple.security.device.audio-input`。
3. 打开打包版，点击 DSH 输入框旁的麦克风，允许 macOS 弹窗，确认能录入语音。再到“系统设置 → 隐私与安全性 → 麦克风”关闭 DSH-Desktop 的权限，重启应用后确认录音被拒绝。

如果此前拒绝过权限，macOS 不会再次弹窗。到“系统设置 → 隐私与安全性 → 麦克风”手动打开 DSH-Desktop，然后完全退出并重启应用。`npm start` 运行的是 Electron 开发程序，其系统权限身份与打包版不同；最终验证应以打包版为准。
