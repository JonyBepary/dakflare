#!/usr/bin/env node
// Invoke one JavaScript expression in a debug WebView over CDP.
//
// This is the client half of `device-check.sh`. It talks to a WebView devtools
// socket that adb has already forwarded to 127.0.0.1:
//
//   adb -s "$ANDROID_SERIAL" forward tcp:9339 \
//     localabstract:webview_devtools_remote_<app pid>
//   node simulator/scripts/cdp-invoke.mjs --port 9339 --file expr.js
//
// With no --path it asks /json for the first `page` target, so the caller does
// not have to scrape the page id. With no --file/--expression it prints usage.
//
// Prints the JSON value returned by the expression (or the exception details,
// exit 2). Exit 1 is a transport or CDP error, 2 a JavaScript exception, and
// 2 also covers bad usage. No dependencies: Node's net/http/crypto only.

import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';

const USAGE = `Usage: node cdp-invoke.mjs --port <port> [options]

  --port <port>       local adb-forwarded devtools port (default 9222)
  --path <path>       page websocket path, e.g. /devtools/page/<id>
                      (default: first page target from http://127.0.0.1:<port>/json)
  --expression <js>   JavaScript expression to evaluate
  --file <path>       read the expression from a file instead
  --timeout <ms>      overall deadline (default 60000)

The expression is evaluated with awaitPromise and returnByValue, so an async
function is awaited and its resolved value is printed as JSON.`;

function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

const options = {
  port: 9222,
  path: '',
  expression: '',
  file: '',
  timeout: 60_000,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  const next = () => {
    i += 1;
    if (i >= argv.length) die(`missing value for ${arg}`);
    return argv[i];
  };
  switch (arg) {
    case '--port':
      options.port = Number(next());
      break;
    case '--path':
      options.path = next();
      break;
    case '--expression':
      options.expression = next();
      break;
    case '--file':
      options.file = next();
      break;
    case '--timeout':
      options.timeout = Number(next());
      break;
    case '-h':
    case '--help':
      console.log(USAGE);
      process.exit(0);
      break;
    default:
      die(`unknown argument: ${arg}\n\n${USAGE}`);
  }
}

if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
  die(`invalid --port: ${options.port}`);
}
if (!Number.isFinite(options.timeout) || options.timeout < 1) {
  die(`invalid --timeout: ${options.timeout}`);
}
if (options.file) {
  if (options.expression) die('use --file or --expression, not both');
  try {
    options.expression = readFileSync(options.file, 'utf8');
  } catch (error) {
    die(`cannot read ${options.file}: ${error.message}`);
  }
}
if (!options.expression.trim()) die(USAGE);

const deadline = setTimeout(() => {
  console.error(`timeout after ${options.timeout}ms`);
  process.exit(1);
}, options.timeout);
deadline.unref?.();

function fetchPagePath(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/json', timeout: 5000 },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`/json returned ${response.statusCode}`));
            return;
          }
          let targets;
          try {
            targets = JSON.parse(body);
          } catch (error) {
            reject(new Error(`/json is not JSON: ${error.message}`));
            return;
          }
          const page = targets.find(
            (target) => target.type === 'page' && target.webSocketDebuggerUrl,
          );
          if (!page) {
            reject(new Error('no page target in /json'));
            return;
          }
          try {
            resolve(new URL(page.webSocketDebuggerUrl).pathname);
          } catch (error) {
            reject(new Error(`bad webSocketDebuggerUrl: ${error.message}`));
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('timed out asking /json')));
    request.on('error', reject);
  });
}

// --- websocket framing -----------------------------------------------------
// Client frames must be masked; server frames are not. CDP responses can be
// fragmented, so text/continuation frames are assembled before JSON.parse.

function clientFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    if (masked) headerLength += 4;
    const end = offset + headerLength + length;
    if (end > buffer.length) break;
    let payload = buffer.subarray(offset + headerLength, end);
    if (masked) {
      const maskOffset = offset + headerLength - 4;
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= buffer[maskOffset + (i % 4)];
      }
    }
    frames.push({ fin, opcode, payload });
    offset = end;
  }
  return { frames, rest: buffer.subarray(offset) };
}

const key = crypto.randomBytes(16).toString('base64');
const accept = crypto
  .createHash('sha1')
  .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
  .digest('base64');

async function main() {
  const path = options.path || (await fetchPagePath(options.port));

  const socket = net.connect(options.port, '127.0.0.1');
  let buffer = Buffer.alloc(0);
  let handshake = false;
  let fragments = [];
  let fragmentOpcode = 0;

  const finish = (code) => {
    clearTimeout(deadline);
    try {
      socket.end();
    } catch {
      // already closed
    }
    process.exit(code);
  };

  const handleText = (text) => {
    let reply;
    try {
      reply = JSON.parse(text);
    } catch (error) {
      console.error(`CDP sent malformed JSON: ${error.message}`);
      finish(1);
      return;
    }
    if (reply.id !== 1) return;

    if (reply.error) {
      console.error(JSON.stringify(reply.error));
      finish(1);
      return;
    }
    const result = reply.result || {};
    if (result.exceptionDetails) {
      console.log(JSON.stringify(result.exceptionDetails, null, 2));
      finish(2);
      return;
    }
    const value = result.result ? result.result.value : undefined;
    console.log(JSON.stringify(value, null, 2));
    finish(0);
  };

  const handleFrames = (frames) => {
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        console.error('CDP closed the connection');
        finish(1);
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(clientFrame(frame.payload.toString('utf8'), 0xa));
        continue;
      }
      if (frame.opcode === 0xa) continue;

      if (frame.opcode === 0x1) {
        fragments = [frame.payload];
        fragmentOpcode = 0x1;
      } else if (frame.opcode === 0x0) {
        fragments.push(frame.payload);
      } else {
        continue;
      }
      if (frame.fin && fragmentOpcode === 0x1) {
        handleText(Buffer.concat(fragments).toString('utf8'));
        return;
      }
    }
  };

  socket.on('connect', () => {
    socket.write(
      `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${options.port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
  });

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshake) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString('utf8');
      const lines = head.split('\r\n');
      if (!/^HTTP\/1\.1 101\b/.test(lines[0] || '')) {
        console.error(head);
        finish(1);
        return;
      }
      const headers = new Map();
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      if (headers.get('sec-websocket-accept') !== accept) {
        console.error('bad Sec-WebSocket-Accept');
        finish(1);
        return;
      }
      handshake = true;
      buffer = buffer.subarray(end + 4);
      socket.write(
        clientFrame(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: options.expression,
              awaitPromise: true,
              returnByValue: true,
            },
          }),
        ),
      );
    }
    const parsed = parseFrames(buffer);
    buffer = parsed.rest;
    if (parsed.frames.length) handleFrames(parsed.frames);
  });

  socket.on('error', (error) => {
    console.error(error.message);
    finish(1);
  });

  socket.on('close', () => {
    if (!handshake) {
      console.error('connection closed during handshake');
      finish(1);
    }
  });
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
