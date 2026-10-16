// 毛球 — 编译「离线皮肤小代理」（M25）
//
// 【这是什么】一段 Java 小程序（`-javaagent`），启动游戏时挂上去，
// 它会在这个游戏进程里开一个**只监听本机**的小服务器，把用户选的那张皮肤
// 当成"某个皮肤站上的皮肤"发给游戏。这样**离线账号**进游戏也能穿上自己的皮肤。
//
// 为什么是我们自己编译而不是下现成的：
//   这段 Java 取自 KAMUCL（GPL-3.0-or-later，见 THIRD_PARTY_NOTICES.md），
//   人家没有单独发这个 jar，只能自己编。
//
// 【编译要用 JDK，不是 JRE】需要 `javac`。毛球自己下的那几个 Java 运行时
// （java-runtime-delta 那些）**只有运行时、没有编译器**，编不了。
//
// 找 javac 的顺序：
//   ① 环境变量 `JAVA_HOME`（指到 JDK 根目录）
//   ② 环境变量 `MAOQIU_JDK`（毛球自己用：指到免安装 JDK 的根目录）
//   ③ `D:\jdk-build\jdk-*`（开发时下的那份免安装 JDK）
//   ④ 直接交给系统 PATH
//
// 跑法：`npm run skin-agent`
// 产物：`assets/offline-skin/maoqiu-offline-skin.jar`（**要跟代码一起提交**，
//       这样别人拿到仓库不装 JDK 也能直接打包）

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const project = path.join(root, 'build', 'offline-skin-agent')
const source = path.join(project, 'src', 'cn', 'maoqiu', 'skin', 'OfflineSkinAgent.java')
const classes = path.join(project, 'build', 'classes')
const manifest = path.join(project, 'build', 'MANIFEST.MF')
const output = path.join(root, 'assets', 'offline-skin', 'maoqiu-offline-skin.jar')

/** 在哪儿找 javac / jar */
function findJdk() {
  const isWin = process.platform === 'win32'
  const exe = (name) => (isWin ? `${name}.exe` : name)

  const candidates = []
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin'))
  if (process.env.MAOQIU_JDK) candidates.push(path.join(process.env.MAOQIU_JDK, 'bin'))
  // 开发时那份免安装 JDK（在仓库外面，不进仓库）
  try {
    for (const name of fs.readdirSync('D:\\jdk-build')) {
      const bin = path.join('D:\\jdk-build', name, 'bin')
      if (fs.existsSync(path.join(bin, exe('javac')))) candidates.push(bin)
    }
  } catch {
    // 没有这个目录就算了
  }

  for (const bin of candidates) {
    const javac = path.join(bin, exe('javac'))
    if (fs.existsSync(javac)) return bin
  }
  return '' // 交给 PATH
}

const jdkBin = findJdk()
const tool = (name) => (jdkBin ? path.join(jdkBin, process.platform === 'win32' ? `${name}.exe` : name) : name)

console.log(`[编译] 用的是这份 JDK：${jdkBin || '（PATH 里找）'}`)

try {
  execFileSync(tool('javac'), ['-version'], { stdio: 'pipe', windowsHide: true })
} catch {
  console.error(
    '[编译] 找不到 javac。\n' +
      '       要么设一个环境变量 MAOQIU_JDK 指向 JDK 根目录，\n' +
      '       要么把 JDK 解到 D:\\jdk-build\\jdk-xxx\\ 下面。\n' +
      '       注意：毛球自己下的那几个 Java 运行时只有 JRE、没有编译器，用不了。'
  )
  process.exit(1)
}

// 只认我们自己的输出目录，别一不小心清到别处去
if (!classes.startsWith(project + path.sep)) throw new Error('编译输出目录不对，停手')
fs.rmSync(classes, { recursive: true, force: true })
fs.mkdirSync(classes, { recursive: true })
fs.mkdirSync(path.dirname(output), { recursive: true })

// `--release 8`：这段小程序只用 Java 8 就有的 API，编成 8 就够，
// 免得游戏那边用老版本 Java 时挂不上。
execFileSync(tool('javac'), ['-encoding', 'UTF-8', '--release', '8', '-d', classes, source], {
  stdio: 'inherit',
  windowsHide: true
})

fs.mkdirSync(path.dirname(manifest), { recursive: true })
fs.writeFileSync(
  manifest,
  'Manifest-Version: 1.0\n' +
    'Premain-Class: cn.maoqiu.skin.OfflineSkinAgent\n' +
    'Can-Redefine-Classes: false\n' +
    'Can-Retransform-Classes: false\n\n'
)

execFileSync(tool('jar'), ['cfm', output, manifest, '-C', classes, '.'], { stdio: 'inherit', windowsHide: true })

const size = fs.statSync(output).size
console.log(`[编译] 好了：${path.relative(root, output)}（${(size / 1024).toFixed(1)} KB）`)
