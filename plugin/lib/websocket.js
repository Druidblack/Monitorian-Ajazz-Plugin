'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');

const MAX_MESSAGE = 2 * 1024 * 1024;

class LocalWebSocket extends EventEmitter {
    constructor(port) {
        super();
        this.port = Number(port);
        this.open = false;
        this.buffer = Buffer.alloc(0);
        this.fragment = [];
        this.fragmentSize = 0;
        this.fragmentOpcode = 0;
        this.key = crypto.randomBytes(16).toString('base64');
        this.socket = net.connect({ host: '127.0.0.1', port: this.port });
        this.socket.setNoDelay(true);
        this.socket.on('connect', () => {
            this.socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${this.key}\r\n\r\n`);
        });
        this.socket.on('data', chunk => {
            try { this.receive(chunk); }
            catch (error) { this.emit('error', error); this.close(); }
        });
        this.socket.on('error', err => this.emit('error', err));
        this.socket.on('close', () => { this.open = false; this.emit('close'); });
    }

    receive(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.open) {
            const boundary = this.buffer.indexOf('\r\n\r\n');
            if (boundary === -1) {
                if (this.buffer.length > 16384) throw new Error('Invalid WebSocket handshake');
                return;
            }
            const head = this.buffer.subarray(0, boundary).toString('utf8');
            const expected = crypto.createHash('sha1').update(this.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            if (!/^HTTP\/1\.1 101\b/.test(head) || !head.toLowerCase().includes('upgrade: websocket') || !head.includes(expected)) {
                throw new Error('Stream Dock rejected the WebSocket handshake');
            }
            this.buffer = this.buffer.subarray(boundary + 4);
            this.open = true;
            this.emit('open');
        }
        while (this.open && this.buffer.length >= 2) {
            const first = this.buffer[0];
            const opcode = first & 0x0f;
            const fin = !!(first & 0x80);
            const masked = !!(this.buffer[1] & 0x80);
            let length = this.buffer[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (this.buffer.length < offset + 2) return;
                length = this.buffer.readUInt16BE(offset); offset += 2;
            } else if (length === 127) {
                if (this.buffer.length < offset + 8) return;
                const big = this.buffer.readBigUInt64BE(offset); offset += 8;
                if (big > BigInt(MAX_MESSAGE)) throw new Error('WebSocket message too large');
                length = Number(big);
            }
            if (length > MAX_MESSAGE) throw new Error('WebSocket message too large');
            const maskLength = masked ? 4 : 0;
            if (this.buffer.length < offset + maskLength + length) return;
            let payload = Buffer.from(this.buffer.subarray(offset + maskLength, offset + maskLength + length));
            if (masked) {
                const mask = this.buffer.subarray(offset, offset + 4);
                for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            }
            this.buffer = this.buffer.subarray(offset + maskLength + length);
            if (opcode === 8) { this.close(); return; }
            if (opcode === 9) { this.sendFrame(10, payload); continue; }
            if (opcode === 10) continue;
            if (opcode === 1 || opcode === 2) {
                this.fragment = [payload]; this.fragmentSize = payload.length; this.fragmentOpcode = opcode;
            } else if (opcode === 0 && this.fragmentOpcode) {
                this.fragment.push(payload); this.fragmentSize += payload.length;
            } else throw new Error('Unexpected WebSocket frame');
            if (this.fragmentSize > MAX_MESSAGE) throw new Error('WebSocket message too large');
            if (fin) {
                if (this.fragmentOpcode !== 1) throw new Error('Unexpected binary Stream Dock message');
                this.emit('message', Buffer.concat(this.fragment).toString('utf8'));
                this.fragment = []; this.fragmentSize = 0; this.fragmentOpcode = 0;
            }
        }
    }

    sendFrame(opcode, value) {
        if (!this.open) throw new Error('Stream Dock is not connected');
        const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
        const extra = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
        const header = Buffer.alloc(2 + extra + 4);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | (extra === 0 ? payload.length : extra === 2 ? 126 : 127);
        if (extra === 2) header.writeUInt16BE(payload.length, 2);
        if (extra === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
        const mask = crypto.randomBytes(4);
        mask.copy(header, 2 + extra);
        const encoded = Buffer.from(payload);
        for (let i = 0; i < encoded.length; i++) encoded[i] ^= mask[i % 4];
        this.socket.write(Buffer.concat([header, encoded]));
    }

    send(data) { this.sendFrame(1, JSON.stringify(data)); }
    close() { if (!this.socket.destroyed) this.socket.end(); this.open = false; }
}

module.exports = { LocalWebSocket };
