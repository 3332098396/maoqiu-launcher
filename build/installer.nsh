; 毛球 — 安装程序的自定义脚本
;
; 【这个文件解决什么问题】
; 如果以后加了"开机自动启动"这类功能，程序运行时会往
;     HKCU\Software\Microsoft\Windows\CurrentVersion\Run
; 写注册表项。这条记录是**程序运行时**创建的，不是安装程序创建的，
; 所以卸载程序不认识它、不会删，会留下一条指向已删除程序的启动项。
; （「历史粘贴板」项目实际踩过这个坑。）
;
; 现在先把清理逻辑放在这里，等真加了自启功能就能直接用。
; 值是 electron.app.<程序名>，这是 Electron 的 setLoginItemSettings 固定命名。

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.${PRODUCT_NAME}"
!macroend
