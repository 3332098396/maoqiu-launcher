// 毛球 — 报错诊断（M22）
//
// 【干什么用的】游戏崩了、启动失败了，用户看到的是一屏英文。
// 这个模块把日志读一遍，认出"这是哪种毛病"，然后给出：
//   ① 一句话说清是什么问题
//   ② 为什么（讲人话）
//   ③ 怎么办（一条一条的步骤）
//
// 【为什么先做本地的，不直接问 AI】
// 用户 2026-10-09 定的：**不填 AI 的 Key 也能用**。
// 常见毛病（Java 版本不对、内存不够、Mod 冲突……）用规则就能认出来——
// 不联网、不花钱、马上有答案，而且**比 AI 靠谱**（AI 会瞎编，规则不会）。
// 规则认不出来的，用户再点「问问 AI」交给大模型。
//
// 【加规则怎么加】往下面 RULES 里加一条就行，别的地方不用动：
//   id      内部名字（给代码看的）
//   test    什么样的日志算命中（正则）
//   title   一句话结论
//   why     为什么（讲人话）
//   steps   怎么办（一步一步）
//   strong  连"正常退出"时出现也算出事（默认只有崩溃时才查）
//   weight  排序用：越大越先显示（越具体的毛病应该越大）
//
// 当前进度：M22 第 1 步。

/**
 * 规则表。**从上往下匹配，命中的都收集起来**（不因为命中一条就不再找别的）——
 * 一个崩掉的日志里常常同时有"缺依赖"和"内存不够"两种线索，都告诉用户比只说一个强。
 */
const RULES = [
  // ——————————————————————————————————————————————
  // 一、Java 和运行环境
  // ——————————————————————————————————————————————
  {
    id: 'java-version',
    test: /UnsupportedClassVersionError|class file version|has been compiled by a more recent version/i,
    title: 'Java 版本不对（游戏要的 Java 比现在这个新）',
    why:
      '每个 Minecraft 版本都要求特定大版本的 Java。这个版本要求的比本机正在用的新，' +
      '游戏读不懂新版本编译出来的文件，启动就崩了。',
    steps: [
      '到「设置 → Java 运行时」看看：如果「自动检测并下载所需 Java」是关着的，把它打开',
      '然后到「下载 → 已安装」，对着这个版本点一次「重装」——正确的 Java 会自动补下',
      '还不行就再点一次「开始游戏」；启动日志里会写清楚这次用的是哪个 Java'
    ],
    strong: true,
    weight: 90
  },
  {
    id: 'java-missing',
    test: /Could not find or load main class|NoClassDefFoundError|ClassNotFoundException/i,
    title: '游戏文件缺失或者坏掉了',
    why: '要用的类文件不在，多半是下载没下全、或者文件被删了/杀毒软件清掉了。',
    steps: [
      '到「下载 → 已安装」，对着这个版本点「重装」（已经下好的不会重下）',
      '如果杀毒软件报过拦截，把游戏目录加进白名单'
    ],
    strong: true,
    weight: 70
  },
  {
    id: 'memory',
    test: /OutOfMemoryError|Java heap space|GC overhead limit exceeded|Direct buffer memory/i,
    title: '内存不够，游戏撑不住了',
    why: '给游戏分配的内存太少。整合包、高清材质、很多 Mod 都吃内存。',
    steps: [
      '到「设置 → 启动选项 → 内存分配」，把内存调大一点（本机内存的 1/4 左右比较稳）',
      '装了整合包的版本可以在「版本设置」里单独给它多分一些',
      '如果本机一共就没多少内存：把游戏视距调小、少装几个 Mod'
    ],
    strong: true,
    weight: 85
  },
  {
    id: 'native-crash',
    test: /EXCEPTION_ACCESS_VIOLATION|EXCEPTION_ILLEGAL_INSTRUCTION|Problematic frame|fatal error in native code/i,
    title: '程序在底层崩了（显卡驱动或内存条的问题居多）',
    why: '这类崩溃发生在 Java 之外（显卡驱动、内存条、动态库），游戏自己都来不及报错。',
    steps: [
      '先把显卡驱动更新到最新（这一条最常见）',
      '关掉超频、换一根内存条试试（如果经常这样）',
      '老显卡跑新版本时，到「版本设置」里把图形相关的 Mod（如光影）先去掉再试'
    ],
    strong: true,
    weight: 60
  },

  // ——————————————————————————————————————————————
  // 二、Mod / 加载器
  // ——————————————————————————————————————————————
  {
    id: 'mod-conflict',
    test: /Incompatible mod set|has failed to load correctly|Mod .* requires|which is missing|duplicate mod/i,
    title: 'Mod 之间打架，或者缺了前置',
    why:
      '两个 Mod 改了同一处东西，或者某个 Mod 要求先装另一个（前置 Mod）才能用。' +
      '日志里通常会点名说是哪个 Mod。',
    steps: [
      '看日志里"requires"或"missing"后面写的是哪个 Mod——那就是缺的那个，去「下载」页搜它装上',
      '如果是"Incompatible mod set"，把最近新加的 Mod 先删掉（到「版本设置 → Mod 文件夹」里删）',
      '确认所有 Mod 都是给同一个游戏版本、同一个加载器（Fabric 的包里别混 Forge 的 Mod）'
    ],
    strong: true,
    weight: 80
  },
  {
    id: 'loader-version',
    test: /requires (?:fabric|forge|neoforge)[a-z-]* ?(?:loader )?(?:version )?[\^>=]/i,
    title: 'Mod 要的 Mod 加载器版本比现在的新',
    why: '某个 Mod 是按新版加载器编译的，现在装的那个加载器太旧，读不了。',
    steps: [
      '到「下载 → 已安装」，对着这个版本重新装一次加载器（会自动装最新的）',
      '或者去「下载」页搜这个 Mod，下它支持当前加载器版本的旧版本'
    ],
    strong: true,
    weight: 75
  },
  {
    id: 'mixins',
    test: /Mixin apply failed|MixinTransformerError|mixin.*(?:failed|error)/i,
    title: 'Mod 动了游戏内部的代码，但没动成',
    why: '这类 Mod（用 Mixin 技术）要改游戏运行时的行为，一旦和别的 Mod 撞上就会失败——多半是 Mod 冲突。',
    steps: [
      '看日志里紧跟在这句后面的类名，去搜它是哪个 Mod 的',
      '把那个 Mod 先删掉试试（「版本设置 → Mod 文件夹」）',
      '确认 Mod 和游戏版本、加载器版本都对得上'
    ],
    strong: true,
    weight: 65
  },

  // ——————————————————————————————————————————————
  // 三、账号与登录
  // ——————————————————————————————————————————————
  {
    id: 'auth-failed',
    test: /Invalid session|Failed to verify username|authentication servers are down|401 Unauthorized/i,
    title: '登录验证没通过',
    why:
      '游戏拿着令牌去问服务器"这个人是不是真的"，服务器不认。常见原因：' +
      '用的是离线账号、令牌过期了、或者那台验证服务器临时出问题。',
    steps: [
      '如果是**离线模式**：这是正常的，单机照样能玩（只是进不了正版服务器）',
      '如果是皮肤站/正版账号：到启动页左边重新登录一次（令牌过期了）',
      '还不行就等几分钟再试——有时候是服务器那边的问题'
    ],
    strong: true,
    weight: 55
  },
  {
    id: 'authlib',
    test: /authlib-injector|Failed to load authentication|prefetched metadata/i,
    title: '外置登录的组件没挂上',
    why: '用皮肤站账号进游戏要靠 authlib-injector 这个组件，它没准备好，游戏就会拿令牌去问 Mojang——当然问不通。',
    steps: [
      '到启动页左边退出账号，重新登录一次（组件会自动重下）',
      '还不行就看看「设置 → 清理」里有没有能清的东西，清完再登录'
    ],
    weight: 50
  },

  // ——————————————————————————————————————————————
  // 四、显卡 / 系统
  // ——————————————————————————————————————————————
  {
    id: 'opengl',
    // 【别写光秃秃的 OpenGL】正常日志里到处是 "OpenGL 4.6" 这种版本号，
    // 那样写会把好日志也判成显卡问题（实测踩到过）。只认明确的报错句式。
    test: /Pixel format not accelerated|Failed to create window|GLFW error|WGL: |OpenGL is not (?:supported|available)|Failed to initialize (?:the )?graphics/i,
    title: '显卡这边出了问题',
    why: '游戏要用的图形接口没能创建成功，多半是显卡驱动太旧，或者显卡不支持。',
    steps: [
      '把显卡驱动更新到最新（NVIDIA / AMD 官网下，别用系统自动装的）',
      '如果是远程桌面/虚拟机里开的，图形加速可能用不了——换本机屏幕试',
      '老电脑跑新版本：到「版本设置」里把光影、材质包先去掉'
    ],
    weight: 60
  },
  {
    id: 'port',
    test: /Address already in use|Failed to bind to port/i,
    title: '端口被占用了',
    why: '上一个游戏（或者别的程序）还没把端口放开，新的这个就起不来。',
    steps: [
      '等几秒再点一次「开始游戏」',
      '还不行就打开任务管理器，把还在的 java.exe / javaw.exe 结束掉（注意别关别的程序）'
    ],
    weight: 40
  },
  {
    id: 'crash-report',
    test: /The game crashed whilst|Exception in thread "main"|crash-reports/i,
    title: '游戏自己崩了',
    why: '游戏写了一份崩溃报告（crash-report），里面有详细原因。',
    steps: [
      '到「版本设置 → 截图文件夹」旁边那一排里打开「游戏目录」，进 crash-reports 文件夹',
      '最新那份报告的开头几行就能看出是哪个组件崩的',
      '看不懂就点下面的「问问 AI」，把日志发给它看看'
    ],
    weight: 30
  },

  // ——————————————————————————————————————————————
  // 五、下载 / 安装（启动器自己的毛病）
  // ——————————————————————————————————————————————
  {
    id: 'download-failed',
    test: /下载失败|校验不通过|ETIMEDOUT|ECONNRESET|getaddrinfo|socket hang up/i,
    title: '文件没下下来（网络问题）',
    why: '连不上下载源，或者中途断了。国内直连官方源经常这样。',
    steps: [
      '到「设置 → 启动选项 → 下载源」换成「优先国内镜像」',
      '再点一次「安装」或「重装」——已经下好的不会重下',
      '如果一直失败：换个网络试试，或者关掉 VPN / 代理'
    ],
    weight: 45
  }
]

/**
 * 诊断一段日志。
 *
 * @param {string} logText 日志内容（一般是最后一段）
 * @param {object} [context] 额外线索：{ crashed, exitCode, java, memoryMB, versionId }
 * @returns {{found: Array, unknown: boolean}}
 *   found   按重要程度排好的结果（可能不止一条）
 *   unknown true = 一条都没认出来（这时候才值得去问 AI）
 */
/**
 * 每条规则"有多大把握"（M23，照 KAMUCL 的 diagnosticRules 那套分级）。
 *
 * 【为什么要分这个】以前所有结论都长得一样肯定，用户分不清
 * "这是铁证"还是"我猜的"。可实际上差别很大：
 *   certain  —— 这个字符串出现 = 就是它，没有第二种解释。
 *               比如 `UnsupportedClassVersionError`，除了 Java 版本不对没别的可能。
 *   possible —— 有可能，但也可能是别的原因。比如日志里出现 "OutOfMemoryError"
 *               也可能是某个 Mod 自己把内存吃光了，不一定是给游戏的太少。
 * 分了级，界面就能说"**很可能**是内存不够"和"**就是**Java 版本不对"，
 * 用户按哪个先试心里有数。
 *
 * 【没有列在这儿的规则】默认按 possible 算——宁可说轻一点。
 */
const CERTAIN_RULES = new Set([
  'java-version', // UnsupportedClassVersionError 只可能是这个原因
  'java-missing', // ClassNotFoundException 同理
  'native-crash', // EXCEPTION_ACCESS_VIOLATION 是 JVM 自己报的底层崩溃
  'mixins', // mixin 的报错格式很固定
  'authlib', // authlib-injector 挂载失败是它自己吐的
  'download-failed' // 下载失败的报错是我们自己写的
])

/** 每条结论最多带几行"证据" */
const MAX_EVIDENCE_LINES = 4

/**
 * 从日志里把"命中那一行"连同前后一两行抓出来给用户看。
 *
 * 【为什么要这一步】只说"内存不够"，用户会问"你怎么知道？"。
 * 把日志里那几行原样摆出来，他既能自己判断，也能直接复制给别人看。
 *
 * @returns {Array<{line: number, text: string}>} line 是行号（从 1 数，日志里就长这样）
 */
function collectEvidence(text, pattern) {
  const lines = text.split(/\r?\n/)
  const hits = []

  for (let i = 0; i < lines.length; i++) {
    // 正则带 g 的话 lastIndex 会串味，每次现造一个
    const one = new RegExp(pattern.source, pattern.flags.replace('g', ''))
    if (!one.test(lines[i])) continue

    // 命中那一行 + 前后各一行；太长的行截一下（日志里有整段 JSON）
    const from = Math.max(0, i - 1)
    const to = Math.min(lines.length - 1, i + 1)
    const block = []
    for (let j = from; j <= to; j++) {
      block.push({ line: j + 1, text: lines[j].slice(0, 300) })
    }

    hits.push(block)
    if (hits.length >= 3) break
  }

  return hits.slice(0, 3).flat().slice(0, MAX_EVIDENCE_LINES + 6)
}

function diagnose(logText, context = {}) {
  const text = String(logText || '')
  const crashed = context.crashed !== false // 不传就当崩了算（宁可多认几条）

  const found = []
  for (const rule of RULES) {
    if (!crashed && !rule.strong) continue
    if (!rule.test.test(text)) continue
    found.push({
      id: rule.id,
      title: rule.title,
      why: rule.why,
      steps: rule.steps,
      weight: rule.weight || 0,
      // 把握程度：明确写了的按写的算，其余的按"有可能"
      confidence: rule.confidence || (CERTAIN_RULES.has(rule.id) ? 'certain' : 'possible'),
      // 证据：日志里那几行（界面会高亮出来）
      evidence: rule.evidence === false ? [] : collectEvidence(text, rule.test)
    })
  }

  // 越具体的排前面
  found.sort((a, b) => b.weight - a.weight)

  // 退出码那几条也算规则的一部分（放在最后，权重低）
  if (crashed && context.exitCode !== undefined && found.length === 0) {
    const byCode = EXIT_CODES[context.exitCode]
    if (byCode) {
      found.push({
        id: 'exit-code',
        title: byCode.title,
        why: byCode.why,
        steps: byCode.steps,
        weight: 10,
        // 退出码是很硬的证据：进程就是这个码退的
        confidence: 'certain',
        evidence: []
      })
    }
  }

  return { found, unknown: found.length === 0 }
}

/**
 * Windows 上进程被"打死"时的退出码（十进制，Node 报的就是十进制）。
 * 内容是"人话版"：为什么 + 怎么办。
 */
const EXIT_CODES = {
  3221225477: {
    title: '程序崩了（内存访问出错）',
    why: '常见的两个原因：显卡驱动老旧，或者内存条有问题。',
    steps: ['先把显卡驱动更新到最新', '如果经常这样：关掉内存超频，或者换根内存条试试']
  },
  3221225725: {
    title: '程序崩了（栈溢出）',
    why: '通常是某个 Mod 递归调用太深，或者整合包里两个 Mod 打架。',
    steps: ['看日志最后提到的那个 Mod，先把它删掉试试', '到「版本设置 → Mod 文件夹」里删']
  },
  3221225781: {
    title: '程序起不来（缺系统运行库）',
    why: '少了一个 Windows 的系统组件（常见是 VC++ 运行库）。',
    steps: ['装一下微软官方的 "Visual C++ Redistributable"（搜这个名字，装 x64 那个）']
  },
  1: {
    title: '游戏报错退出了（退出码 1）',
    why: '游戏自己发现了问题然后主动退出——具体原因写在日志里。',
    steps: ['看日志（面板下面那份）最后几行', '看不懂就点「问问 AI」']
  }
}

module.exports = { diagnose, RULES, EXIT_CODES }
