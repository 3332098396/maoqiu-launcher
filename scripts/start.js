// MC启动器 — 启动器
//
// 这个文件有两个身份：
//   1. `npm start` 时运行它
//   2. 双击「启动MC启动器.bat」时也运行它
//
// 【为什么让 .bat 转一手调 Node，而不是直接写命令】
// cmd 的批处理按系统 GBK 码页读文件，而我们的文件是 UTF-8，
// 中文提示会显示成乱码，严重时甚至把整行解析错、报"不是内部或外部命令"。
// 交给 Node 打印就没这个问题（.bat 里先 chcp 65001 切到 UTF-8 即可）。
//
// 【为什么要有下面那句清环境变量】
// 某些编辑器（比如 VS Code）会给它启动的终端注入一个叫 ELECTRON_RUN_AS_NODE
// 的环境变量。它会让 Electron 退化成"普通 Node"运行，于是程序里的 app
// 变成 undefined，报出一句完全看不懂的错：
//     TypeError: Cannot read properties of undefined (reading 'setName')
// 这跟项目代码没关系，纯粹是环境问题，但排查起来非常费劲。
// 所以启动前先把它清掉。

delete process.env.ELECTRON_RUN_AS_NODE

const { spawn } = require('node:child_process')
const path = require('node:path')

// 在普通 Node 环境下，electron 这个包导出的就是 electron.exe 的完整路径
const electronModule = require('electron')
const electronPath =
  typeof electronModule === 'string' ? electronModule : electronModule.default

const projectRoot = path.join(__dirname, '..')

// 把额外参数原样转给 Electron。开发时用得上，例如：
//     npm start -- --game-dir="D:\test"
// 可以临时指定游戏目录，不用改配置文件。
const extraArgs = process.argv.slice(2)

console.log('')
console.log('  正在启动 MC启动器…')
console.log('  稍等几秒，软件窗口会自动出现。')
console.log('')

const child = spawn(electronPath, ['.', ...extraArgs], {
  cwd: projectRoot,
  stdio: 'inherit'
})

child.on('error', (error) => {
  console.log('')
  console.log('  ✗ 启动失败：找不到 Electron 主程序。')
  console.log('    多半是装依赖时没下全。在项目目录里执行这两条试试：')
  console.log('        rm -rf node_modules/electron')
  console.log('        npm install')
  console.log('')
  console.log('  详细错误：', error.message)
  process.exit(1)
})

child.on('close', (code) => {
  if (code === 0) {
    console.log('')
    console.log('  软件已退出。')
  } else {
    console.log('')
    console.log(`  软件异常退出（代码 ${code}），把上面的信息截图发给开发者。`)
  }
  process.exit(code ?? 0)
})
