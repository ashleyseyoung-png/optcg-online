// Minimal RFC 6455 WebSocket server built on Node's raw http + net + crypto.
// No 'ws' / 'socket.io' package available in this environment, so this hand-rolls
// just enough of the protocol for JSON text-message game traffic:
//   - the HTTP Upgrade handshake
//   - text frame parsing (handles multi-frame TCP reads, masking, 16/64-bit lengths)
//   - text frame + close/ping/pong writing
// It intentionally does NOT support permessage-deflate or binary frames — we don't need them.
'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => { this.alive = false; this.emit('close'); });
    socket.on('error', (err) => { this.alive = false; this.emit('close', err); });
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    // A connection may deliver multiple frames per TCP chunk, or split one frame
    // across chunks — keep decoding what we can and stop cleanly when data runs out.
    while (true) {
      const parsed = this._tryParseFrame(this.buffer);
      if (!parsed) break;
      this.buffer = this.buffer.subarray(parsed.frameLength);
      this._handleFrame(parsed);
    }
  }

  _tryParseFrame(buf) {
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const b1 = buf[1];
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let offset = 2;
    if (payloadLen === 126) {
      if (buf.length < offset + 2) return null;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      payloadLen = Number(big);
      offset += 8;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + payloadLen) return null;
    let payload = buf.subarray(offset, offset + payloadLen);
    if (masked) {
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }
    return { fin, opcode, payload, frameLength: offset + payloadLen };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) { this.close(); return; } // close
    if (opcode === 0x9) { this._writeFrame(0xA, payload); return; } // ping -> pong
    if (opcode === 0xA) return; // pong, ignore
    if (opcode === 0x1 || opcode === 0x0) {
      // text (or continuation) — we don't stitch multi-frame messages beyond
      // simple continuation since our payloads are small JSON strings.
      this._msgBuf = this._msgBuf ? Buffer.concat([this._msgBuf, payload]) : payload;
      if (fin) {
        const text = this._msgBuf.toString('utf8');
        this._msgBuf = null;
        this.emit('message', text);
      }
    }
  }

  _writeFrame(opcode, payload) {
    if (!this.alive) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (e) { /* socket already gone */ }
  }

  send(str) {
    this._writeFrame(0x1, Buffer.from(str, 'utf8'));
  }

  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this._writeFrame(0x8, Buffer.alloc(0)); this.socket.end(); } catch (e) {}
    this.emit('close');
  }
}

class WSServer extends EventEmitter {
  attach(httpServer) {
    httpServer.on('upgrade', (req, socket, head) => {
      const key = req.headers['sec-websocket-key'];
      if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
        socket.destroy();
        return;
      }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '', '',
      ];
      socket.write(headers.join('\r\n'));
      const conn = new WSConnection(socket);
      if (head && head.length) conn._onData(head);
      this.emit('connection', conn, req);
    });
  }
}

module.exports = { WSServer };
