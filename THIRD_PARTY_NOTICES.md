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

## 二、从 VoxLink 移植的代码（LGPL-3.0-only，逐个点名）

[VoxLink](https://github.com/AUGUHDAR/VoxLink)（作者 AUGUHDAR 及贡献者，**LGPL-3.0**）
的联机协议实现被移植进毛球，用于「联机」页的 VoxLink 房间功能。

**下列文件是移植/改写成果，按 LGPL-3.0-only 提供（不是 MIT）**；
对这些文件的修改部分，同样以 LGPL-3.0-only 发布：

| 毛球里的文件 | 来源（上游） | 许可 |
|---|---|---|
| `src/main/voxlink/api.js` | `network/SignalingClient.java` — HTTP 信封与端点契约 | **LGPL-3.0-only** |
| `src/main/voxlink/index.js` | `room/ConnectionManager.java` — 房间流程、加入重试节奏 | **LGPL-3.0-only** |
| `src/main/voxlink/room.js` | `network/NatLabels.java` — 网络类型取值与显示名 | **LGPL-3.0-only** |
| `src/main/voxlink/ports.js` | 上游的「本机游戏端口探测」行为（对应文件待核实） | **LGPL-3.0-only** |
| `src/main/voxlink/punchAuth.js` | `network/PunchAuth.java` — 打洞包的 HMAC 防伪章 | **LGPL-3.0-only** |
| `src/main/voxlink/rudp.js` | `network/ReliableUdpTransport.java` — 可靠 UDP 传输、XOR 校验、RTT 估计 | **LGPL-3.0-only** |
| `src/main/voxlink/stun.js` | `network/StunProbe.java` — 公网地址探测与 NAT 类型判断（含 RFC 5389 客户端） | **LGPL-3.0-only** |

改写过程中参考了 [KAMUCL](https://github.com/kamubaba-i/KAMUCL) 的 JS 实现
（`src/main/core/voxlink/`；该项目中对应部分同样按 LGPL-3.0-only 声明）。

毛球其余全部代码仍为 [MIT](LICENSE)。

> **据实说明**：KAMUCL 在其 `LICENSE` 中写明"上游代码的历史许可尚未理清"
> （*upstream code whose historical permission remains unresolved*）。
> 毛球沿用同样的处理办法——按 LGPL-3.0-only 提供、在此逐一点名，不作超出此范围的主张。

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
