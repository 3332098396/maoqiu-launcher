// 毛球 — 打包脚本
//
// 【为什么不直接在 package.json 里写 "electron-builder --win nsis"】
//
// electron-builder 打包 NSIS 安装包时，要从 GitHub 下载几个编译资源
// （nsis、nsis-resources、7zip 等）。在国内直连 GitHub 经常超时——
// 上一个项目实际撞过一次：`connect ETIMEDOUT 20.205.243.166:443`，
// 前面所有步骤都成功了，卡在最后一步前功尽弃。
//
// 所以这里先把下载源指向国内镜像，再启动打包。
// 思路和 scripts/start.js 一样：把"环境相关的坑"堵在脚本里，
// 让 `npm run dist` 在任何网络环境下都能用。
//
// 【为什么用 node + cli.js，而不是直接执行 .bin 里的命令】
// Windows 上 .bin 目录里是 .cmd 批处理，用子进程执行要经过一层 cmd.exe，
// 而项目路径可能含有中文，经过 cmd 容易出乱码。直接用 node 跑 JS 文件
// 绕开这一层，最稳。

// 如果外面已经指定了镜像（比如公司内网有自己的源），就用外部的，不覆盖
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://npmmirror.com/mirrors/electron-builder-binaries/'

const { spawn } = require('node:child_process')
const path = require('node:path')

const projectRoot = path.join(__dirname, '..')
const cli = path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js')

console.log('正在打包…（第一次会下载打包工具，可能要几分钟）')
console.log('下载源：', process.env.ELECTRON_BUILDER_BINARIES_MIRROR)
console.log('')

const child = spawn(process.execPath, [cli, '--win', 'nsis'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env
})

child.on('close', (code) => {
  if (code === 0) {
    console.log('')
    console.log('打包完成。安装程序在 release 文件夹里。')
  }
  process.exit(code ?? 0)
})
