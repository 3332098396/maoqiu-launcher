// SPDX-License-Identifier: LGPL-3.0-only
// Copyright (c) 2026 毛球 (Maoqiu) · https://github.com/3332098396/maoqiu-launcher —— 移植/改编自 VoxLink，本文件按 LGPL-3.0 提供（见 THIRD_PARTY_NOTICES.md）
//
// 逐语句移植自 AUGUHDAR/VoxLink（修订 924845e，LGPL-3.0）的
// `network/` 下 PunchParams / PunchTuner / PortPredictor / NatClass /
// PunchStrategySelector / PunchFailureClassifier 这几个 Java 文件。
// 改写参考了 KAMUCL 的 JS 实现（`src/main/core/voxlink/punchPolicy.ts`，作者 KAMUCL contributors）。
// 见 THIRD_PARTY_NOTICES.md —— 本文件**不适用**仓库根的 MIT，按 LGPL-3.0-only 提供。
//
// 干什么：打洞打完之后要回答三个问题 ——
//   ① 这一轮**为什么没成功**（分类）→ ② 下一轮**参数怎么调**（自适应调参）→ ③ 对方的端口**跳到哪儿去了**（端口预测）。
// 对称 NAT 每次发包都会换一个新端口，所以只能"算"它下一步跳到哪个端口，然后往那一圈猛敲。
//
// §0 纪律：常量、公式全部与上游一致（含 Math.trunc 的位置）；不许自造简化版扫描。

const { PROFILES } = require('./punchProfiles')

const symmetric = (nat) => nat === 'EASY_SYM' || nat === 'HARD_SYM'

/** 两边的网络类型 → 该用哪套模板。**唯一签名就是两个参数**（官方文档 §9 机制修正：三参数旧版必须删） */
function recommendProfile(local, remote) {
  // NatClass.java: recommendProfile (ScenarioTier currently does not change the matrix).
  if (local === 'UNKNOWN' || remote === 'UNKNOWN') return PROFILES.AGGRESSIVE
  if (symmetric(local) && symmetric(remote)) return local === 'EASY_SYM' && remote === 'EASY_SYM' ? PROFILES.EASY_SYM_DUAL : PROFILES.HARDSYM
  if (local === 'CONE' && remote === 'CONE') return PROFILES.FAST_LANE
  if (local === 'EASY_SYM' || remote === 'EASY_SYM') return PROFILES.V100
  if (local === 'HARD_SYM' || remote === 'HARD_SYM') return PROFILES.AGGRESSIVE
  return PROFILES.DEFAULT
}

/** 打法方向：谁先敲谁（跟"谁先发起"无关，是协议层面的先后） */
function selectStrategy(local, remote, cycle, legacy) {
  // PunchStrategySelector.java: select; no launcher-specific NAT shortcuts.
  if (legacy) return 'DIRECT_ONLY'
  if (!local || !remote) return 'DIRECT_WITH_REVERSE_PARALLEL'
  if (local === 'UNKNOWN' || remote === 'UNKNOWN') return symmetric(local === 'UNKNOWN' ? remote : local) ? 'REVERSE_FIRST' : 'DIRECT_WITH_REVERSE_PARALLEL'
  if ((local === 'CONE' && remote === 'HARD_SYM') || (local === 'HARD_SYM' && remote === 'CONE')) return cycle === 0 ? 'REVERSE_ONLY' : 'REVERSE_THEN_FORWARD'
  if (local === remote) return local === 'CONE' ? 'DIRECT_ONLY' : 'DIRECT_WITH_REVERSE_PARALLEL'
  return 'REVERSE_FIRST'
}

/** 自适应调参的九个上限（官方文档 §9.1，逐值核对） */
const TUNER = {
  MAX_PORT_RANGE: 500, // PunchTuner.java: MAX_PORT_RANGE
  MAX_TIMEOUT_MS: 30000, // PunchTuner.java: MAX_TIMEOUT_MS
  MIN_SEND_INTERVAL_MS: 50, // PunchTuner.java: MIN_SEND_INTERVAL_MS
  LATE_CYCLE_TIMEOUT_MS: 5000, // PunchTuner.java: LATE_CYCLE_TIMEOUT_MS
  ACK_RETRIES_ON_TIMEOUT: 3, // PunchTuner.java: ACK_RETRIES_ON_TIMEOUT
  PREDICTION_DELTA_THRESHOLD: 100, // PunchTuner.java: PREDICTION_DELTA_THRESHOLD
  PORT_RANGE_MULTIPLIER: 2, // PunchTuner.java: PORT_RANGE_MULTIPLIER
  TIMEOUT_INCREMENT_MS: 4000, // PunchTuner.java: TIMEOUT_INCREMENT_MS
  SEND_INTERVAL_DIVISOR: 2 // PunchTuner.java: SEND_INTERVAL_DIVISOR
}

/** 把模板摊平成"这一轮实际要用的参数"（PunchParams.java: fromProfile 的取值，与上游一致） */
function fromProfile(p) {
  // PunchParams.java: fromProfile and constructor defaults.
  return {
    portRange: p.portPredictionMaxRange, timeoutMs: p.punchTimeoutMs, sendInterval: p.send.intervalMs,
    ackRetries: 1, skipDirectPunch: false, reuseSuccessfulSockets: false, successfulPortRange: null,
    sendMinRounds: 0, sendMinPass: 0, hardSymSpray: p === PROFILES.HARDSYM, easySymBomb: p === PROFILES.EASY_SYM_DUAL,
    sprayPortCountMin: p.sym.hardSymSprayPortMin, sprayPortCountMax: p.sym.hardSymSprayPortMax,
    sprayPacketsPerPort: p.sym.hardSymPacketsPerPort, sprayPortIntervalMs: p.sym.hardSymPortIntervalMs,
    sprayDecayNumerator: p.sym.hardSymDecayNumerator, sprayDecayFloor: p.sym.hardSymDecayFloor,
    bombWindow: p.sym.easySymBombWindow, bombRoundIntervalMs: p.sym.easySymRoundIntervalMs, bombDurationMs: p.sym.easySymBombDurationMs
  }
}

/** 一轮打洞的失败原因分类（顺序很重要：预测失效 / 防火墙 要排在"没回应"前面） */
function classifyFailure(r) {
  // PunchFailureClassifier.java: classify, including the ordering of prediction/firewall checks.
  if (!r) return 'NO_RESPONSE'
  if (r.portPredictionActive && r.socketsReceivedPunch === 0 && r.socketsReceivedAck === 0 && !r.firewallDetected) return 'PREDICTION_OFF'
  if (r.predictionDelta > TUNER.PREDICTION_DELTA_THRESHOLD) return 'PREDICTION_OFF'
  if (!r.socketsReceivedPunch && !r.socketsReceivedAck) return r.firewallDetected ? 'FIREWALL_DETECTED' : 'NO_RESPONSE'
  if (r.socketsReceivedPunch > 0 && r.socketsReceivedAck === 0) return 'RESPONSE_NO_ACK'
  if (r.socketsReceivedAck > 0 && !r.success) return 'ACK_TIMEOUT'
  if (r.socketsReceivedPunch > 0 && r.socketsReceivedPunch < r.socketsTried) return 'PARTIAL_SUCCESS'
  return 'NO_RESPONSE'
}

/** 下一轮怎么调参：按失败原因走（每个分支的数值都与源码一致） */
function nextParams(profile, cycle, maxCycles, failure, result) {
  let p = fromProfile(profile)
  if (failure) {
    switch (failure) {
      case 'NO_RESPONSE':
        p.portRange = Math.min(p.portRange * TUNER.PORT_RANGE_MULTIPLIER, TUNER.MAX_PORT_RANGE)
        p.timeoutMs = Math.min(p.timeoutMs + TUNER.TIMEOUT_INCREMENT_MS, TUNER.MAX_TIMEOUT_MS)
        p.sendMinRounds = 3; p.sendMinPass = 3 // PunchTuner.java: NO_RESPONSE
        break
      case 'PREDICTION_OFF':
        p = fromProfile(PROFILES.HARDSYM)
        p.portRange = Math.min(p.portRange * TUNER.PORT_RANGE_MULTIPLIER, TUNER.MAX_PORT_RANGE)
        p.sendMinRounds = 3; p.sendMinPass = 3 // PunchTuner.java: PREDICTION_OFF
        break
      case 'RESPONSE_NO_ACK':
        p.sendInterval = Math.max(Math.trunc(p.sendInterval / TUNER.SEND_INTERVAL_DIVISOR), TUNER.MIN_SEND_INTERVAL_MS)
        p.sendMinPass = 3 // PunchTuner.java: RESPONSE_NO_ACK
        break
      case 'FIREWALL_DETECTED': p.skipDirectPunch = true; break
      case 'PARTIAL_SUCCESS':
        if (result && result.predictionDelta > 0) {
          p.reuseSuccessfulSockets = true
          p.successfulPortRange = [result.predictionDelta - 5, result.predictionDelta + 5] // PunchTuner.java: PARTIAL_SUCCESS
        }
        break
      case 'ACK_TIMEOUT': p.ackRetries = TUNER.ACK_RETRIES_ON_TIMEOUT; p.sendMinPass = 3; break // PunchTuner.java: ACK_TIMEOUT
    }
    if (result && result.elapsedMs > 0) {
      if (result.elapsedMs > 10000) p.timeoutMs = Math.min(Math.trunc(p.timeoutMs * 3 / 2), TUNER.MAX_TIMEOUT_MS) // PunchTuner.java: elapsed adaptation
      else if (result.elapsedMs < 3000 && failure === 'NO_RESPONSE') p.portRange = Math.min(p.portRange * TUNER.PORT_RANGE_MULTIPLIER, TUNER.MAX_PORT_RANGE)
    }
  }
  if (cycle >= maxCycles - 2 && p.timeoutMs > TUNER.LATE_CYCLE_TIMEOUT_MS) p.timeoutMs = Math.max(TUNER.LATE_CYCLE_TIMEOUT_MS, Math.trunc(p.timeoutMs * 3 / 4)) // PunchTuner.java: applyLateCycleLimit
  return p
}

/** 端口预测参数（官方文档 §9.4，逐值核对） */
const PREDICTOR = {
  SAMPLES_HIGH: 10, RANGE_HIGH: 32, // PortPredictor.java: SAMPLES_HIGH, RANGE_HIGH
  SAMPLES_MID: 5, RANGE_MID: 64, // PortPredictor.java: SAMPLES_MID, RANGE_MID
  SAMPLES_LOW: 3, RANGE_LOW: 100, // PortPredictor.java: SAMPLES_LOW, RANGE_LOW
  RANGE_DEFAULT: 200, EPSILON: 1e-9, // PortPredictor.java: RANGE_DEFAULT, EPSILON
  ALPHA: 0.4, LR_WEIGHT: 0.6, DELTA_WEIGHT: 0.4, // PortPredictor.java: ALPHA, LR_WEIGHT, DELTA_WEIGHT
  MIN_PORT: 1024, MAX_PORT: 65535 // PortPredictor.java: MIN_PORT, MAX_PORT
}

/** 最小二乘拟合出的"下一个端口" */
function linearRegressionPredict(ports) {
  if (!ports.length) return -1
  if (ports.length === 1) return ports[0]
  let x = 0, y = 0, xy = 0, xx = 0
  ports.forEach((p, i) => { x += i; y += p; xy += i * p; xx += i * i })
  const n = ports.length, denom = n * xx - x * x
  if (Math.abs(denom) < PREDICTOR.EPSILON) return Math.round(y / n)
  const slope = (n * xy - x * y) / denom
  return Math.round(slope * n + (y - slope * x) / n)
}

/** 看"每次跳多少"的增量趋势外推（掐头去尾去掉四分之一的极端值再取指数平均） */
function deltaPredict(ports) {
  if (ports.length < 2) return -1
  const sorted = ports.slice(1).map((p, i) => p - ports[i]).sort((a, b) => a - b)
  const trim = Math.trunc(sorted.length / 4) // PortPredictor.java: deltaPredict quartile trim
  const values = sorted.slice(trim, sorted.length - trim)
  let ema = values[0]
  for (const value of values.slice(1)) ema += PREDICTOR.ALPHA * (value - ema)
  return ports[ports.length - 1] + Math.round(ema)
}

/** 两种预测按 0.6 / 0.4 加权融合，再按样本数决定"往多宽的范围敲" */
function predict(ports) {
  if (ports.length < 2) return { predictedPort: ports[0] ?? -1, range: PREDICTOR.RANGE_DEFAULT, strategy: ports.length ? 'single_sample' : 'no_samples' }
  const lr = linearRegressionPredict(ports), delta = deltaPredict(ports)
  const value = lr > 0 && delta > 0 ? Math.round(lr * PREDICTOR.LR_WEIGHT + delta * PREDICTOR.DELTA_WEIGHT) : lr > 0 ? lr : delta
  const range = ports.length >= PREDICTOR.SAMPLES_HIGH ? PREDICTOR.RANGE_HIGH : ports.length >= PREDICTOR.SAMPLES_MID ? PREDICTOR.RANGE_MID : ports.length >= PREDICTOR.SAMPLES_LOW ? PREDICTOR.RANGE_LOW : PREDICTOR.RANGE_DEFAULT
  return { predictedPort: Math.max(PREDICTOR.MIN_PORT, Math.min(PREDICTOR.MAX_PORT, value)), range, strategy: 'combined' }
}

/** 围绕预测值展开要敲的端口，**上下交替**（不是先敲上面一圈再敲下面一圈） */
function generateTargetPorts(port, range) {
  const lo = Math.max(PREDICTOR.MIN_PORT, port - range), hi = Math.min(PREDICTOR.MAX_PORT, port + range), out = [port]
  for (let offset = 1; offset <= range; offset++) {
    if (port + offset <= hi) out.push(port + offset)
    if (port - offset >= lo) out.push(port - offset)
  }
  return out
}

module.exports = {
  symmetric, recommendProfile, selectStrategy, TUNER, fromProfile,
  classifyFailure, nextParams, PREDICTOR, linearRegressionPredict, deltaPredict, predict, generateTargetPorts,
}
