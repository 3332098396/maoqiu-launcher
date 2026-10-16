# 离线皮肤小代理（毛球 M25）

这个目录里是**别人的 Java 代码**，毛球拿来编一下、随安装包发出去。

## 它是谁写的、什么许可

- **`src/cn/maoqiu/skin/OfflineSkinAgent.java`** ——
  [KAMUCL](https://github.com/kamubaba-i/KAMUCL) 的原创组件，**GPL-3.0-or-later**。
  **逻辑一个字没改**；只在 2026-10-16 改了「名字」：
  包名 `cn.kamucl.skin` → `cn.maoqiu.skin`（文件名跟着挪到 `cn/maoqiu/skin/`），
  外加几处会露在游戏日志/游戏界面上的字符串（线程名、启动那行提示、发给游戏的服务名）。
  **署名和许可一处没动**（就在这一节和根目录的 THIRD_PARTY_NOTICES.md）——
  GPL 要求署名的部分**必须留着**，删了就是抄。
- 许可证全文：[`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt)
- 上游对它的说明原文（KAMUCL 的 THIRD_PARTY_NOTICES.md）：

  > offline-skin-agent/src/cn/kamucl/skin/OfflineSkinAgent.java is an original KAMUCL
  > component licensed GPL-3.0-or-later. […] It serves only the captured local appearance
  > inside the game's JVM and does not authenticate access to online servers.

（中文：这是一段 GPL-3.0-or-later 的原创组件；它只在这个游戏自己的 JVM 里提供
"本机这份外观"，**不代管任何联网服务器的登录**。）

毛球这边的用途和声明见仓库根目录的
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) 第三节。

## 它干什么

启动游戏时用 `-javaagent:` 挂进游戏进程，在里面开一个**只监听 `127.0.0.1`** 的小 HTTP 服务；
再配合 authlib-injector 把游戏"去哪儿取皮肤"的地址指到这个本地服务上 ——
离线账号于是也能穿上自己挑的那张皮肤（**只在本机显示**）。

不挂在毛球进程里、而是挂在游戏进程里，是因为**关掉启动器游戏还在跑**，
服务得跟着游戏活。

## 怎么编译

```text
npm run skin-agent
```

产物：`assets/offline-skin/maoqiu-offline-skin.jar`（跟代码一起提交，
别人拿到仓库不装 JDK 也能直接打包）。

要一份 **JDK**（`javac`）——注意毛球自己下的那几个 Java 运行时只有 JRE、没有编译器。
脚本会按这个顺序找：环境变量 `JAVA_HOME` → `MAOQIU_JDK` → `D:\jdk-build\jdk-*` → 系统 PATH。

## 编译出来的中间产物

`build/offline-skin-agent/build/` 里那些（`.class`、`MANIFEST.MF`）是中间产物，
**不入库**（仓库根 `.gitignore` 里挡着）。入库的只有最终那个 jar。
