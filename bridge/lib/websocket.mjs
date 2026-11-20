import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

/**
 * 够用就好的 RFC 6455 服务端实现。
 *
 * 只做本插件需要的部分：握手校验、文本帧收发、ping/pong、close、分片重组。
 * 不引入 `ws` 依赖，是为了让插件在任何 profile 里都能直接加载（本地 link 安装不会装依赖）。
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }
const MAX_PAYLOAD = 1 << 20 // 1 MiB，协议帧都很小，超了直接断。

function acceptKey(key) {
  return crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64')
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8')
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, data])
}

class Connection extends EventEmitter {
  constructor(socket) {
    super()
    this.socket = socket
    this.closed = false
    this.buffer = Buffer.alloc(0)
    this.fragments = []

    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.drain()
    })
    socket.on('close', () => this.finish(1006, 'socket-closed'))
    socket.on('error', () => this.finish(1006, 'socket-error'))
  }

  send(text) {
    if (this.closed) return false
    try {
      this.socket.write(encodeFrame(OPCODE.TEXT, text))
      return true
    } catch {
      this.finish(1011, 'write-failed')
      return false
    }
  }

  ping() {
    if (this.closed) return
    try {
      this.socket.write(encodeFrame(OPCODE.PING, Buffer.alloc(0)))
    } catch {
      // 忽略：close 事件会清理
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123)
    const payload = Buffer.alloc(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, payload))
    } catch {
      // 忽略
    }
    this.finish(code, reason)
    this.socket.end()
  }

  finish(code, reason) {
    if (this.closed) return
    this.closed = true
    this.emit('close', code, reason)
  }

  drain() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2

      if (length === 126) {
        if (this.buffer.length < offset + 2) return
        length = this.buffer.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return
        const big = this.buffer.readBigUInt64BE(offset)
        if (big > BigInt(MAX_PAYLOAD)) {
          this.close(1009, 'too-large')
          return
        }
        length = Number(big)
        offset += 8
      }

      if (length > MAX_PAYLOAD) {
        this.close(1009, 'too-large')
        return
      }

      let maskKey = null
      if (masked) {
        if (this.buffer.length < offset + 4) return
        maskKey = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }

      if (this.buffer.length < offset + length) return
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      this.buffer = this.buffer.subarray(offset + length)

      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4]
      }

      if (opcode === OPCODE.CLOSE) {
        this.close(1000, 'client-close')
        return
      }
      if (opcode === OPCODE.PING) {
        try {
          this.socket.write(encodeFrame(OPCODE.PONG, payload))
        } catch {
          // 忽略
        }
        continue
      }
      if (opcode === OPCODE.PONG) continue

      if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY || opcode === OPCODE.CONT) {
        this.fragments.push(payload)
        if (!fin) continue
        const full = Buffer.concat(this.fragments)
        this.fragments = []
        this.emit('message', full.toString('utf8'))
        continue
      }
      // 其它 opcode 忽略。
    }
  }
}

/**
 * 在已有 http.Server 上接管 /path 的 WebSocket 升级。
 * @returns {EventEmitter} 触发 'connection'（参数为 Connection）
 */
export function createWebSocketServer(server, { path = '/ws', protocol = '', fallback = null } = {}) {
  const emitter = new EventEmitter()

  server.on('upgrade', (request, socket, head) => {
    const url = request.url ?? '/'
    const pathname = url.split('?')[0]
    if (pathname !== path) {
      // 不是桥的端点：交给调用方决定（比如原样透传给 DSH 自己的长连接），否则直接断开。
      if (typeof fallback === 'function') fallback(request, socket, head)
      else socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    const version = request.headers['sec-websocket-version']
    if (!key || String(version) !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(String(key))}`,
    ]
    if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`)
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    socket.setNoDelay(true)

    const connection = new Connection(socket)
    emitter.emit('connection', connection, request)
  })

  return emitter
}
