// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 读写 Minecraft 的 NBT 格式（M23）
//
// 【NBT 是什么】游戏存东西用的一种"二进制 JSON"：一棵带类型的树。
// 每个节点前面写着"我是什么类型"（字节？整数？字符串？列表？），后面才是内容。
// `servers.dat`（多人游戏里那个服务器列表）就是它，而且是 gzip 压过的。
//
// 【为什么自己写】项目红线是"运行时不引第三方依赖"。NBT 的格式其实很小，
// 这里只实现读写要用的那几种类型，不碰别的。
//
// 【为什么写这个】以前毛球碰不了 servers.dat，所以做不了"服务器列表"这一页。
// 游戏那边**必须**是这个格式才认，用 JSON 存一份自己的没用。
//
// 格式参考：https://minecraft.wiki/w/NBT_format
//
// 当前进度：M23。

const zlib = require('node:zlib')

const TAG_END = 0
const TAG_BYTE = 1
const TAG_SHORT = 2
const TAG_INT = 3
const TAG_LONG = 4
const TAG_FLOAT = 5
const TAG_DOUBLE = 6
const TAG_BYTE_ARRAY = 7
const TAG_STRING = 8
const TAG_LIST = 9
const TAG_COMPOUND = 10
const TAG_INT_ARRAY = 11
const TAG_LONG_ARRAY = 12

// ——————————————————————————————————————————————
// 读
// ——————————————————————————————————————————————

/** 一个只往前走的读指针 */
function makeReader(buffer) {
  let at = 0
  return {
    get at() {
      return at
    },
    u8() {
      return buffer.readUInt8(at++)
    },
    i8() {
      return buffer.readInt8(at++)
    },
    i16() {
      const v = buffer.readInt16BE(at)
      at += 2
      return v
    },
    u16() {
      const v = buffer.readUInt16BE(at)
      at += 2
      return v
    },
    i32() {
      const v = buffer.readInt32BE(at)
      at += 4
      return v
    },
    i64() {
      const v = buffer.readBigInt64BE(at)
      at += 8
      return v
    },
    f32() {
      const v = buffer.readFloatBE(at)
      at += 4
      return v
    },
    f64() {
      const v = buffer.readDoubleBE(at)
      at += 8
      return v
    },
    bytes(length) {
      const v = buffer.subarray(at, at + length)
      at += length
      return v
    }
  }
}

function readString(reader) {
  const length = reader.u16()
  return reader.bytes(length).toString('utf8')
}

/** 读一个"带类型"的负载（列表里每一项都要先读类型再读内容） */
function readPayload(reader, type) {
  switch (type) {
    case TAG_BYTE:
      return reader.i8()
    case TAG_SHORT:
      return reader.i16()
    case TAG_INT:
      return reader.i32()
    case TAG_LONG:
      // BigInt 太大，服务器列表里用不到这么大的数，转成普通数字更省事
      return Number(reader.i64())
    case TAG_FLOAT:
      return reader.f32()
    case TAG_DOUBLE:
      return reader.f64()
    case TAG_BYTE_ARRAY: {
      const length = reader.i32()
      return Buffer.from(reader.bytes(length))
    }
    case TAG_STRING:
      return readString(reader)
    case TAG_LIST: {
      const itemType = reader.u8()
      const length = reader.i32()
      const out = []
      for (let i = 0; i < length; i++) out.push(readPayload(reader, itemType))
      return out
    }
    case TAG_COMPOUND: {
      const out = {}
      for (;;) {
        const childType = reader.u8()
        if (childType === TAG_END) break
        const name = readString(reader)
        out[name] = readPayload(reader, childType)
      }
      return out
    }
    case TAG_INT_ARRAY: {
      const length = reader.i32()
      const out = []
      for (let i = 0; i < length; i++) out.push(reader.i32())
      return out
    }
    case TAG_LONG_ARRAY: {
      const length = reader.i32()
      const out = []
      for (let i = 0; i < length; i++) out.push(Number(reader.i64()))
      return out
    }
    default:
      throw new Error(`不认识的 NBT 类型：${type}`)
  }
}

/**
 * 把一段 NBT 二进制读成普通对象。
 * gzip 压过的会自动解开（servers.dat 就是压过的）。
 */
function parse(buffer) {
  let raw = Buffer.from(buffer)
  // gzip 的魔数：1f 8b
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    raw = zlib.gunzipSync(raw)
  }

  const reader = makeReader(raw)
  const rootType = reader.u8()
  if (rootType !== TAG_COMPOUND) throw new Error('这不是一个 NBT 文件（根节点不是复合标签）')
  readString(reader) // 根节点的名字，一般是空的，用不上
  return readPayload(reader, TAG_COMPOUND)
}

// ——————————————————————————————————————————————
// 写
// ——————————————————————————————————————————————

/**
 * 写的时候要带类型，但 JS 的普通对象里没有类型信息。
 * 所以用一个"打包"的小盒子：{ type, value }。
 * 【为什么不用猜类型】猜会出事：数字 1 到底该写成字节还是整数？
 * `hideAddress` 必须是字节，写成整数游戏就读不动了。
 */
function tag(type, value) {
  return { __nbt: true, type, value }
}

const byte = (value) => tag(TAG_BYTE, value ? 1 : 0)
const int = (value) => tag(TAG_INT, value)
const str = (value) => tag(TAG_STRING, String(value))
const compound = (fields) => tag(TAG_COMPOUND, fields)
const list = (itemType, items) => tag(TAG_LIST, { itemType, items })

/** 把一个打包好的值写成二进制（片段叠加） */
function writePayload(node) {
  const { type, value } = node
  switch (type) {
    case TAG_BYTE:
      return Buffer.from([value & 0xff])
    case TAG_SHORT: {
      const b = Buffer.alloc(2)
      b.writeInt16BE(value)
      return b
    }
    case TAG_INT: {
      const b = Buffer.alloc(4)
      b.writeInt32BE(value)
      return b
    }
    case TAG_LONG: {
      const b = Buffer.alloc(8)
      b.writeBigInt64BE(BigInt(value))
      return b
    }
    case TAG_FLOAT: {
      const b = Buffer.alloc(4)
      b.writeFloatBE(value)
      return b
    }
    case TAG_DOUBLE: {
      const b = Buffer.alloc(8)
      b.writeDoubleBE(value)
      return b
    }
    case TAG_STRING: {
      const body = Buffer.from(String(value), 'utf8')
      const head = Buffer.alloc(2)
      head.writeUInt16BE(body.length)
      return Buffer.concat([head, body])
    }
    case TAG_BYTE_ARRAY: {
      const body = Buffer.from(value)
      const head = Buffer.alloc(4)
      head.writeInt32BE(body.length)
      return Buffer.concat([head, body])
    }
    case TAG_COMPOUND: {
      const parts = []
      for (const [name, child] of Object.entries(value || {})) {
        if (!child || !child.__nbt) continue
        parts.push(Buffer.from([child.type]), writeString(name), writePayload(child))
      }
      parts.push(Buffer.from([TAG_END]))
      return Buffer.concat(parts)
    }
    case TAG_LIST: {
      const { itemType, items } = value
      const head = Buffer.alloc(5)
      head.writeUInt8(itemType, 0)
      head.writeInt32BE(items.length, 1)
      return Buffer.concat([head, ...items.map(writePayload)])
    }
    case TAG_INT_ARRAY: {
      const head = Buffer.alloc(4)
      head.writeInt32BE(value.length)
      const body = Buffer.alloc(value.length * 4)
      value.forEach((one, i) => body.writeInt32BE(one, i * 4))
      return Buffer.concat([head, body])
    }
    default:
      throw new Error(`不会写这种 NBT 类型：${type}`)
  }
}

function writeString(text) {
  const body = Buffer.from(String(text), 'utf8')
  const head = Buffer.alloc(2)
  head.writeUInt16BE(body.length)
  return Buffer.concat([head, body])
}

/** 打包成一整个 NBT 文件的内容（默认 gzip 压过，和游戏写的一样） */
function write(rootCompound, { gzip = true } = {}) {
  const head = Buffer.concat([
    Buffer.from([TAG_COMPOUND]),
    writeString(''), // 根节点名字，游戏写空串
    writePayload(rootCompound)
  ])
  return gzip ? zlib.gzipSync(head) : head
}

module.exports = {
  parse,
  write,
  tag,
  byte,
  int,
  str,
  compound,
  list,
  TAG: {
    BYTE: TAG_BYTE,
    SHORT: TAG_SHORT,
    INT: TAG_INT,
    LONG: TAG_LONG,
    FLOAT: TAG_FLOAT,
    DOUBLE: TAG_DOUBLE,
    BYTE_ARRAY: TAG_BYTE_ARRAY,
    STRING: TAG_STRING,
    LIST: TAG_LIST,
    COMPOUND: TAG_COMPOUND,
    INT_ARRAY: TAG_INT_ARRAY,
    LONG_ARRAY: TAG_LONG_ARRAY
  }
}
