// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — VoxLink 联机 · 房间名与网络类型的中文名
//
// 两件小事放一起：
//   ① 房间名的规矩（不能空、不能超过 32 个字）
//   ② 「网络类型」那一串英文代号 → 给人看的中文
//
// ② 单独说一句：服务器会告诉你"你这边的网络是哪种 NAT"。这串代号
// （full_cone / symmetric / ...）是给程序看的，直接甩给用户没人看得懂。
// 但要注意——**中文名只用来显示，绝不用来判断该用哪种打洞方式**。
// 万一哪天改了个错别字，也绝不能影响到能不能连上。
//
// SPDX-License-Identifier: LGPL-3.0-only
// 本文件按 VoxLink（LGPL-3.0）的取值改写，来源与许可见 THIRD_PARTY_NOTICES.md

/** 新建房间时最常叫的名字。用户可以改。 */
const DEFAULT_ROOM_NAME = '我的世界联机'

/** 房间名最长多少字（服务器那边也是这个数）。 */
const ROOM_NAME_MAX = 32

/**
 * 把用户填的房间名收拾干净。
 * 空的不行、太长的也不行 —— 与其让服务器拒了再来回试，不如当场说清楚。
 */
function normalizeRoomName(value) {
  const name = String(value ?? '').trim()
  if (!name) throw new Error('请输入房间名')
  if (name.length > ROOM_NAME_MAX) throw new Error(`房间名不能超过 ${ROOM_NAME_MAX} 个字符`)
  return name
}

/** 服务器给的"原始网络类型"代号 → 中文。 */
const NAT_RAW_LABELS = {
  unknown: '未知',
  full_cone: '完全锥形 NAT',
  restricted_cone: '受限锥形 NAT',
  port_restricted_cone: '端口受限锥形 NAT',
  symmetric_easy_inc: '易打洞对称 NAT（端口递增）',
  symmetric_easy_dec: '易打洞对称 NAT（端口递减）',
  symmetric: '对称 NAT',
  open: '开放',
  moderate: '中等限制',
  strict: '严格限制'
}

/** 归类后的网络类型 → 中文。 */
const NAT_CLASS_LABELS = {
  CONE: '锥形 NAT',
  EASY_SYM: '易打洞对称 NAT',
  HARD_SYM: '困难对称 NAT',
  UNKNOWN: '未知'
}

/** 挑一个人话名字。有归类就用归类，没有就退回原始代号，再没有就说"未知"。 */
function natLabel(natClass, raw) {
  if (natClass && natClass !== 'UNKNOWN') return NAT_CLASS_LABELS[natClass] ?? '未知'
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : 'unknown'
  return NAT_RAW_LABELS[key] ?? '未知'
}

module.exports = { DEFAULT_ROOM_NAME, ROOM_NAME_MAX, normalizeRoomName, NAT_RAW_LABELS, NAT_CLASS_LABELS, natLabel }
