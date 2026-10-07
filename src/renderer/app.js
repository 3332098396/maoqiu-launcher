// MC启动器 — 界面逻辑
//
// 当前进度：M0（骨架）。只把版本号填到页脚，证明"界面 ↔ 安全桥"是通的。
// M1 起这里会负责页面切换；M2 起会渲染版本列表。

document.getElementById('version').textContent = window.api?.appVersion ?? '未知'
