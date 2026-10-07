// MC启动器 — 启动器
//
// 【为什么需要这个文件，而不直接在 package.json 里写 "electron ."】
//
// 某些编辑器（比如 VS Code）会给它启动的终端注入一个叫 ELECTRON_RUN_AS_NODE
// 的环境变量。这个变量会让 Electron 退化成"普通 Node"来运行，
// 于是程序里的 app 变成 undefined，报出一句完全看不懂的错：
//
//     TypeError: Cannot read properties of undefined (reading 'setName')
//
// 这跟项目代码本身没关系，纯粹是环境问题，但排查起来非常费劲。
// 这个启动器在启动前先把那个变量清掉，让 `npm start` 在任何终端里都能正常跑。
//
// （这套做法在「历史粘贴板」项目里已经踩过坑并验证有效，直接沿用。）

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
// 可以临时指定游戏目录，不用改设置文件。
const extraArgs = process.argv.slice(2)

const child = spawn(electronPath, ['.', ...extraArgs], {
  cwd: projectRoot,
  stdio: 'inherit'
})

child.on('close', (code) => process.exit(code ?? 0))
