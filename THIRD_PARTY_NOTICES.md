# 第三方组件与许可 / Third-party notices

毛球（Maoqiu）**不包含任何 Minecraft 游戏文件**，也**不包含**下面这些组件的二进制文件——
它们是启动器在运行时从各项目的官方发布地址下载、校验哈希之后才使用的。
原作者的版权与许可权利归各作者所有。

---

## 一、运行时用到（由启动器自动下载，不随安装包分发）

| 组件 | 用途 | 许可 | 上游 |
|---|---|---|---|
| EasyTier | 联机：虚拟局域网打洞 | **LGPL-3.0** | https://github.com/EasyTier/EasyTier |
| FRP（frpc） | 樱花内网穿透的端口映射 | **Apache-2.0** | https://github.com/fatedier/frp |
| authlib-injector | 外置登录（皮肤站账号） | 见上游仓库 | https://github.com/yushijinhun/authlib-injector |
| Terracotta | 打洞辅助（配合 VoxLink 使用） | **AGPL-3.0** | https://github.com/burningtnt/Terracotta |

## 二、参考与待移植

| 项目 | 说明 | 许可 |
|---|---|---|
| [VoxLink](https://github.com/AUGUHDAR/VoxLink) | 联机协议参考实现。**本项目移植其协议的部分，将按 LGPL-3.0-only 单独提供** | **LGPL-3.0** |

> **现状说明（请以本段为准）**：截至本文件最后一次更新，毛球**尚未包含**任何从 VoxLink 移植的代码。
> 一旦开始包含，相关文件会在此**逐一点名**，并按 LGPL-3.0-only 提供，其修改部分同样以 LGPL-3.0-only 发布。

## 三、开发时使用（不进入安装包）

- Electron（MIT）、three.js（MIT）等，完整列表见 [`package.json`](package.json) 的 `devDependencies`
- `minizip-asm.js` / `archiver` / `archiver-zip-encrypted` —— **仅用于开发时生成加密压缩包的测试样本**，不进入安装包

## 四、使用的服务

- [Modrinth](https://modrinth.com) 公开 API —— 搜索并下载 Mod / 资源包 / 光影 / 整合包 / 数据包
- Mojang 官方源与 BMCLAPI 镜像 —— 下载游戏本体文件

## 五、你的数据

账号名、设置、皮肤、备份等**全部保存在你自己的电脑上**（`%APPDATA%\毛球\`），**不上传**。
AI 报错助手用的 API Key 只存在本机，**绝不打包进安装包，也不随任何请求发给第三方**。
详见 [docs/06-数据与隐私说明.md](docs/06-数据与隐私说明.md)。

---

## 免责声明

毛球与 Mojang Studios、Microsoft 均无关联，**未获得 Mojang 批准，也不是官方产品**。
Minecraft 是 Mojang Studios 的商标。
