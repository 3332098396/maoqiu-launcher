// 毛球 — 社区资源的中文名对照表（M9）
//
// 【这是什么】Modrinth 是个英文站，搜出来的 Mod / 光影 / 资源包都是英文名。
// 而国内玩家平时叫它们的中文名（sodium 叫"钠"、create 叫"机械动力"）。
// 这里维护一张"英文代号 → 中文名"的对照表，界面上显示成
// 「钠（Sodium）」这样，**中文名在前、英文原名在后**——和 PCL 的做法一致，
// 不认识的照样显示英文名，不会瞎编。
//
// 【为什么不自动翻译】
// 机器翻译翻不出这些专有名词（"钠"翻不出来），而且 Modrinth 的接口
// 也不提供中文名。国内有做这件事的（MC 百科），但它**没有公开接口**，
// 爬取有合规风险——这条在需求文档里查证过，不做。
// 所以这张表是**手工维护**的：只收大家公认的叫法，拿不准的不写。
//
// 【怎么扩充】照着下面的格式往里加就行，键是 Modrinth 的 slug
// （网址里那一段，比如 modrinth.com/mod/sodium 的 sodium）。

/** 英文代号（slug）→ 中文名 */
const PROJECT_NAMES = {
  // ——— 优化类（国内玩家几乎人手一个）———
  sodium: '钠',
  lithium: '锂',
  phosphor: '磷',
  krypton: '氪',
  starlight: '星光',
  indium: '铟',
  rubidium: '铷',
  embeddium: 'Embeddium（钠的 Forge 版）',
  'sodium-extra': '钠 · 扩展',
  'reeses-sodium-options': '钠 · 选项菜单',
  ferritecore: '铁氧体磁芯',
  entityculling: '实体渲染机制优化',
  modernfix: 'ModernFix',
  modelfix: 'Model Gap Fix',
  memoryleakfix: '内存泄漏修复',
  lazydfu: 'LazyDFU',
  c2me: 'C2ME（并发区块）',
  noisium: 'Noisium',
  spark: 'spark 性能分析',
  'distant-horizons': '远处的地平线',
  bobby: 'Bobby（远处区块缓存）',
  'fps-reducer': 'FPS Reducer',
  dynamiclights: '动态光源',
  'dynamic-lights': '动态光源',

  // ——— 光影 / 渲染 ———
  iris: 'Iris 光影加载器',
  oculus: 'Oculus（Iris 的 Forge 版）',
  optifine: 'OptiFine',
  'complementary-reimagined': '互补光影 · 重制版',
  'complementary-shaders': '互补光影',
  'complementary-unbound': '互补光影 · Unbound',
  'bsl-shaders': 'BSL 光影',
  'sildurs-vibrant-shaders': 'Sildur\'s 光影',
  'sildurs-shaders': 'Sildur\'s 光影',
  'rethinking-voxels': '重构体素',
  'makeup-ultra-fast-shaders': 'MakeUp 光影',
  'makeup-ultra-fast': 'MakeUp 光影',
  solas_shader: 'Solas 光影',
  'solas-shader': 'Solas 光影',
  'bliss-shader': 'Bliss 光影',
  photon_shader: 'Photon 光影',
  'photon-shader': 'Photon 光影',
  astralex: 'Astralex 光影',

  // ——— 资源包 ———
  'fresh-animations': 'Fresh Animations（生物动画）',
  'fresh-animations-extensions': 'Fresh Animations 扩展',
  'xray-ultimate': 'Xray Ultimate（透视）',
  'fast-better-grass': '快速更好的草',
  'low-on-fire': '低火焰',
  'stay-true': 'Stay True（原版风）',
  faithful: 'Faithful（原版高清）',
  'bare-bones': '极简材质包',
  'translations-for-sodium': '钠的汉化翻译',
  'translations-for-fabric': 'Fabric 模组汉化',

  // ——— 基础库 / API ———
  'fabric-api': 'Fabric API',
  'architectury-api': 'Architectury API',
  'cloth-config': 'Cloth Config API',
  'forge-config-api-port': 'Forge Config API Port',
  'puzzles-lib': 'Puzzles Lib',
  balm: 'Balm',
  midnightlib: 'MidnightLib',
  'geckolib': 'GeckoLib',
  'curios': 'Curios API',
  'trinkets': '饰品（Trinkets）',
  'patchouli': '帕秋莉手册',
  'flywheel': 'Flywheel',
  'kotlin-for-forge': 'Kotlin for Forge',
  'bookshelf-lib': 'Bookshelf',
  'resourceful-lib': 'Resourceful Lib',
  'owo-lib': 'oωo lib',
  'yacl': 'YetAnotherConfigLib',

  // ——— 界面 / 信息 ———
  modmenu: 'Mod 菜单',
  jei: 'JEI 物品管理器',
  rei: 'REI 物品管理器',
  emi: 'EMI 物品管理器',
  'roughly-enough-items': 'REI 物品管理器',
  'appleskin': '苹果皮',
  jade: 'Jade 信息显示',
  wthit: 'WTHIT（这是什么）',
  hwyla: 'HWYLA（这是什么）',
  'journeymap': '旅行地图',
  'xaeros-minimap': 'Xaero 的小地图',
  'xaeros-world-map': 'Xaero 的世界地图',
  minihud: 'MiniHUD',
  litematica: '投影（Litematica）',
  tweakeroo: 'Tweakeroo',
  itemscroller: 'ItemScroller',
  'worldedit': '创世神（WorldEdit）',
  'waila': 'Waila（这是什么）',
  'betterf3': 'BetterF3',
  'mods-command': 'Mods Command',

  // ——— 玩法 / 内容 ———
  create: '机械动力',
  'create-fabric': '机械动力（Fabric）',
  botania: '植物魔法',
  ae2: '应用能源 2',
  'applied-energistics-2': '应用能源 2',
  mekanism: '通用机械',
  'thermal-foundation': '热力基础',
  'immersive-engineering': '沉浸工程',
  'farmers-delight': '农夫乐事',
  'twilightforest': '暮色森林',
  'terralith': 'Terralith（地形扩展）',
  'waystones': '传送石碑',
  'corail-tombstone': '墓碑',
  'travelers-backpack': '旅行者背包',
  'sophisticated-backpacks': '精致背包',
  'backpacked': '背包',
  'iron-chests': '铁箱子',
  'cooking-for-blockheads': '懒人厨房',
  'farmersdelight': '农夫乐事',
  'aquaculture': '水产养殖',
  'quark': '夸克',
  'supplementaries': 'Supplementaries（装饰）',
  'decorative-blocks': '装饰方块',
  'chipped': 'Chipped（方块变体）',
  'handcrafted': 'Handcrafted（家具）',
  'macaws-furniture': 'Macaw\'s 家具',
  'macaws-bridges': 'Macaw\'s 桥梁',
  'macaws-doors': 'Macaw\'s 门',
  'macaws-fences-and-walls': 'Macaw\'s 栅栏和墙',
  'macaws-lights-and-lamps': 'Macaw\'s 灯',
  'macaws-paths-and-pavings': 'Macaw\'s 道路',
  'macaws-roofs': 'Macaw\'s 屋顶',
  'macaws-trapdoors': 'Macaw\'s 活板门',
  'macaws-windows': 'Macaw\'s 窗户',
  'structory': 'Structory（建筑）',
  'when-dungeons-arise': '地牢崛起',
  'yungs-better-dungeons': 'YUNG 的更好地牢',
  'yungs-better-mineshafts': 'YUNG 的更好废弃矿井',
  'yungs-better-strongholds': 'YUNG 的更好要塞',
  'yungs-better-desert-temples': 'YUNG 的更好沙漠神殿',
  'yungs-better-witch-huts': 'YUNG 的更好女巫小屋',
  'yungs-api': 'YUNG\'s API',
  'alexs-mobs': 'Alex 的生物',
  'alexs-delight': 'Alex 的乐事',
  'naturalist': 'Naturalist（生物）',
  'critters-and-companions': '生物与伙伴',
  'bettersniffer' : '更好的嗅探兽',
  'villager-names': '村民名字',
  'guard-villagers': '守卫村民',
  'easy-villagers': '简单村民',
  'trading-post': '交易站',

  // ——— 存档 / 联机 / 服务端 ———
  'carpet': 'Carpet（地毯）',
  'carpet-extra': 'Carpet Extra',
  'servux': 'Servux',
  'fabric-language-kotlin': 'Fabric 语言 Kotlin',
  'chunky': 'Chunky（预生成世界）',
  'chunky-pregenerator': 'Chunky（预生成世界）',
  'ledger': 'Ledger（方块记录）',
  'simple-voice-chat': '简单语音聊天',
  'voicechat': '简单语音聊天',
  'essential-mod': 'Essential（联机）',
  'essential': 'Essential（联机）',
  'e4mc': 'e4mc（开个房间给朋友）',
  'world-host': 'World Host（一键开房）',
  'lan-server-properties': '局域网服务器设置'
}

/** Modrinth 的分类标签 → 中文。没收录的照原样显示 */
const CATEGORY_NAMES = {
  // 玩法/主题
  adventure: '冒险',
  cursed: '猎奇',
  decoration: '装饰',
  economy: '经济',
  equipment: '装备',
  food: '食物',
  'game-mechanics': '游戏机制',
  library: '前置库',
  magic: '魔法',
  management: '管理',
  minigame: '小游戏',
  mobs: '生物',
  optimization: '性能优化',
  social: '社交',
  storage: '存储',
  technology: '科技',
  transportation: '交通',
  utility: '实用工具',
  worldgen: '世界生成',
  // 资源包风格
  'vanilla-like': '原版风',
  themed: '主题风',
  realistic: '写实风',
  'semi-realistic': '半写实',
  fantasy: '幻想风',
  cartoon: '卡通风',
  medieval: '中世纪',
  modern: '现代风',
  rustic: '乡村风',
  steampunk: '蒸汽朋克',
  simplistic: '极简',
  colorful: '多彩',
  horror: '恐怖',
  'core-shaders': '核心光影',
  // 资源包的部位
  audio: '音效',
  blocks: '方块',
  entities: '生物',
  environment: '环境',
  fonts: '字体',
  gui: '界面',
  items: '物品',
  locale: '语言',
  models: '模型',
  tweaks: '细节调整',
  // 光影风格
  bloom: '泛光',
  blur: '模糊',
  crosshair: '准星',
  reflections: '反射',
  shadows: '阴影',
  'path-tracing': '光追',
  pbr: 'PBR 材质',
  'colored-lighting': '彩色光照',
  'low-end': '低配可用',
  potato: '低配可用',
  screeneffects: '画面特效',
  // 分辨率（原样也挺好认，但统一一下）
  '8x': '8x 分辨率',
  '16x': '16x 分辨率',
  '32x': '32x 分辨率',
  '48x': '48x 分辨率',
  '64x': '64x 分辨率',
  '128x': '128x 分辨率',
  '256x': '256x 分辨率',
  '512x': '512x 分辨率',
  minecraft: 'Minecraft'
}

/** 这个 slug 的中文名（没有就返回空字符串，界面会显示英文名） */
function chineseName(slug) {
  if (!slug) return ''
  return PROJECT_NAMES[String(slug).toLowerCase()] || ''
}

/** 把一批分类标签翻成中文（没收录的保持原样） */
function chineseCategories(categories) {
  return (categories || []).map((name) => CATEGORY_NAMES[String(name).toLowerCase()] || name)
}

module.exports = { chineseName, chineseCategories, PROJECT_NAMES, CATEGORY_NAMES }
