// SPDX-License-Identifier: LGPL-3.0-only
// 原作者：VoxLink —— https://github.com/AUGUHDAR/VoxLink （LGPL-3.0-only）
// 毛球只做了移植/改写：Copyright (c) 2026 毛球 (Maoqiu) · https://github.com/3332098396/maoqiu-launcher —— 本文件按 LGPL-3.0-only 提供（详见 THIRD_PARTY_NOTICES.md）
//
// 逐语句移植自 AUGUHDAR/VoxLink 的 `network/ConnectionManager.java`（修订 924845e，LGPL-3.0）里
// **只管"第几轮、用哪套模板、下一轮隔多久"** 那一部分（轮次驱动）。
// 改写参考了 KAMUCL 的 JS 实现（`src/main/core/voxlink/punchRounds.ts`，作者 KAMUCL contributors）。
// 见 THIRD_PARTY_NOTICES.md —— 本文件**不适用**仓库根的 MIT，按 LGPL-3.0-only 提供。
//
// 干什么：打洞不是"发一次包就完事"，而是**一轮一轮地试**（"轮"= 把所有周期跑完一遍）。
// 每一轮打完，这里决定三件事：
//   ① 这一轮算不算失败、是哪种失败（转交 punchPolicy.js 分类）
//   ② **换不换发包模板**（默认 → 激进 → 死磕对称 NAT，20 秒内不许来回换）
//   ③ **下一轮什么时候开始**（当场重试 / 退避 1 秒 / 2 秒 / 4 秒）
//
// 什么时候认输（终局）：**整场会话一个对端的 UDP 包都没收到过**，并且
//   - 轮次到 20（ZERO_RECV_FINAL_ROUND_LIMIT），或
//   - "预测关掉"累计到 50 次（PREDICTION_OFF_CAP）
// 注意：**打洞轮次本身没有上限**（CONTINUOUS_RETRY_MAX_ROUNDS = Integer.MAX_VALUE）——
// 只有上面那两条"全场零收包"的条件才会让人停手。收到过包就继续磨。
//
// §0 纪律：常量与上游一致（2026-10-12 已对 ConnectionManager.java 逐值核过），不许自造简化。

const { PROFILES } = require('./punchProfiles')
const { classifyFailure, nextParams, recommendProfile, symmetric } = require('./punchPolicy')

/** ConnectionManager.java: ZERO_RECV_FINAL_ROUND_LIMIT（整场会话零收包的轮次上限） */
const ZERO_RECV_FINAL_ROUND_LIMIT = 20
/** ConnectionManager.java: PREDICTION_OFF_CAP（**不是**总轮次上限，只管"预测关闭"累计频次） */
const PREDICTION_OFF_CAP = 50
/** ConnectionManager.java: BACKOFF_DELAYS_MS */
const BACKOFF_DELAYS_MS = [1000, 2000, 4000]
/** ConnectionManager.java: switchPunchProfile 里的 20000L（20 秒节流） */
const PROFILE_SWITCH_COOLDOWN_MS = 20000

class PunchRounds {
  constructor(log = () => {}) {
    this.log = log
    this.cycle = 0
    this.round = 0
    this.attempt = 1
    this.receivedEver = false
    this.predictionOffCount = 0
    this.profile = PROFILES.DEFAULT
    this.params = undefined
    this.local = 'UNKNOWN'
    this.remote = 'UNKNOWN'
    this.reachable = 0
    this.switchedAt = 0
    this.lastFailure = null
    this.consecutive = 0
    this.latestFailure = null
  }

  /** ConnectionManager.java: getEffectiveMaxCycles —— 一个"轮"里跑几个周期才算完 */
  get maxCycles() {
    if (!this.reachable) return this.profile.fallbackCycles
    return symmetric(this.local)
      ? Math.max(2, Math.min(this.reachable, this.profile.maxSymCycles))
      : Math.max(1, Math.min(this.reachable, this.profile.maxCycles))
  }

  /** 网络类型判定结果出来了（两边各是什么类型、STUN 探到几个能用的服务器） */
  classify(local, remote, reachable) {
    if (this.local !== local || this.remote !== remote) this.params = undefined
    this.local = local
    this.remote = remote
    this.reachable = reachable
    if (!this.round) this.switchProfile(recommendProfile(local, remote))
  }

  switchProfile(next) {
    if (next === this.profile) return
    if (this.switchedAt && Date.now() - this.switchedAt < PROFILE_SWITCH_COOLDOWN_MS) {
      this.log(`模板切换被 20 秒节流：目标 ${next.name}，保留 ${this.profile.name}，剩余 ${PROFILE_SWITCH_COOLDOWN_MS - (Date.now() - this.switchedAt)} ms`)
      return
    }
    // 换模板要留痕：把"相对 DEFAULT 到底改了哪些字段"整个打出来，否则事后没人知道当时换的是什么
    const differences = Object.fromEntries(
      Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(PROFILES.DEFAULT[key]))
    )
    this.log(`模板切换：${this.profile.name} → ${next.name}；相对 DEFAULT 的全部差异：${JSON.stringify(differences)}`)
    this.profile = next
    this.switchedAt = Date.now()
  }

  /** 一轮打完：记账，并算出下一轮的参数 */
  record(result) {
    this.receivedEver ||= result.socketsReceivedPunch > 0 || result.socketsReceivedAck > 0
    const reason = classifyFailure(result)
    if (reason === 'PREDICTION_OFF') this.predictionOffCount++
    this.params = nextParams(this.profile, this.cycle + 1, this.maxCycles, reason, result)
    this.latestFailure = reason
    return reason
  }

  /** 判终局：源码用的是"整场会话的收包证据"，不是"可以重置的超时预算" */
  get terminal() {
    return !this.receivedEver && (this.round >= ZERO_RECV_FINAL_ROUND_LIMIT || this.predictionOffCount >= PREDICTION_OFF_CAP)
  }

  /**
   * 往前走一步，返回**下一轮要等多久（毫秒）**；返回 0 表示"立刻开下一轮"。
   * ConnectionManager.java: tryUdpPunch —— 先在同一周期里重试 punchMaxAttempts 次，指数退避封顶 2^4。
   */
  advance(firewall = false) {
    if (!firewall && this.attempt < this.profile.punchMaxAttempts) {
      return this.profile.punchRetryDelayMs * 2 ** Math.min(this.attempt++ - 1, 4)
    }
    this.attempt = 1
    const oldCycle = this.cycle++
    if (this.cycle >= this.maxCycles) {
      this.cycle = 0
      this.round++
      // 一个轮跑完还没通：默认/激进 → 死磕对称 NAT 那套，已经是死磕那套 → 换回激进
      if (this.profile !== PROFILES.HARDSYM) {
        this.switchProfile(this.profile === PROFILES.AGGRESSIVE ? PROFILES.HARDSYM : PROFILES.AGGRESSIVE)
      }
      return 0 // ConnectionManager.java: enterContinuousRetryRound 直接从周期 0 开始
    }
    // ConnectionManager.java: advanceToNextCycle 数的是"失败的周期"，不是 socket 个数
    if (oldCycle === 0 && this.profile === PROFILES.DEFAULT && (symmetric(this.local) || symmetric(this.remote))) {
      this.switchProfile(PROFILES.AGGRESSIVE)
    }
    if (this.latestFailure) {
      if (this.latestFailure === this.lastFailure) this.consecutive++
      else {
        this.lastFailure = this.latestFailure
        this.consecutive = 1
      }
      if (this.consecutive >= 3) {
        if (this.latestFailure === 'NO_RESPONSE') this.switchProfile(PROFILES.HARDSYM)
        else if (this.latestFailure !== 'FIREWALL_DETECTED') this.switchProfile(PROFILES.AGGRESSIVE)
        this.consecutive = 0
      }
    }
    return BACKOFF_DELAYS_MS[Math.min(oldCycle, BACKOFF_DELAYS_MS.length - 1)]
  }
}

module.exports = {
  PunchRounds,
  ZERO_RECV_FINAL_ROUND_LIMIT,
  PREDICTION_OFF_CAP,
  BACKOFF_DELAYS_MS,
  PROFILE_SWITCH_COOLDOWN_MS,
}
