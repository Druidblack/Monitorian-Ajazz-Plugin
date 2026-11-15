'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const net = require('node:net');
const crypto = require('node:crypto');
const { LocalWebSocket } = require('../lib/websocket');

test('built-in websocket client completes handshake, unmasks messages and handles server frames', async () => {
    let received;
    let resolveReceived;
    const recv = new Promise(resolve => { resolveReceived = resolve; });
    const server = net.createServer(socket => {
        let handshake = '';
        socket.on('data', packet => {
            if (handshake !== null) {
                handshake += packet.toString('latin1');
                const boundary = handshake.indexOf('\r\n\r\n');
                if (boundary === -1) return;
                const key = handshake.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i)[1].trim();
                const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
                socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
                handshake = null;
                socket.write(Buffer.from([0x81, 0x02, 0x4f, 0x4b]));
            } else if (packet[0] === 0x81) {
                assert.ok(packet[1] & 0x80, 'client messages must be masked');
                const length = packet[1] & 127;
                const key = packet.subarray(2, 6);
                const data = Buffer.from(packet.subarray(6, 6 + length));
                for (let i = 0; i < data.length; i++) data[i] ^= key[i % 4];
                received = JSON.parse(data.toString());
                resolveReceived();
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new LocalWebSocket(server.address().port);
    const msg = new Promise(resolve => client.once('message', resolve));
    try {
        await new Promise(resolve => client.once('open', resolve));
        assert.equal(await msg, 'OK');
        client.send({ event: 'registerPlugin' });
        await recv;
        assert.deepEqual(received, { event: 'registerPlugin' });
    } finally {
        client.close();
        await new Promise(resolve => server.close(resolve));
    }
});
