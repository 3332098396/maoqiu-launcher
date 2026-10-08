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

; 装的时候就替用户把「皮肤文件夹」建好（M21）。
;
; 【为什么要在这儿建】用户一装完就能往里丢皮肤图片，点「打开皮肤文件夹」也马上能打开——
; 不用先开一次软件。程序自己第一次运行时也会建（复制随包那几张皮肤时），
; 两边都建、谁也不依赖谁。
;
; 【注意】路径里那个中文名走的是 ${PRODUCT_NAME}（构建时注入的），
; **不要在脚本里写中文字面量**：这个 .nsh 没有 BOM，NSIS 按 ANSI 读，
; 写中文会变成乱码文件夹名。
!macro customInstall
  CreateDirectory "$APPDATA\${PRODUCT_NAME}\skins"
!macroend

; 卸载时**不删**这个文件夹（里面可能有用户自己下的皮肤）——
; 跟 deleteAppDataOnUninstall: false 一个道理。
!macro customRemoveFiles
!macroend
