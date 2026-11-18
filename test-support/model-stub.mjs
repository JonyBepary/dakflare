#!/usr/bin/env node
/**
 * test-support/model-stub.mjs — a deterministic OpenAI-compatible chat endpoint.
 *
 * The conformance stack has no live model: Workers AI needs a real account even
 * under `wrangler dev --local`, so a webhook turn or an act tool cannot be
 * exercised without one. This stub answers `POST /v1/chat/completions` with a
 * fixed prose answer, and with one named tool call when the last user message
 * carries the marker `[[ACT:<tool>]]`.
 *
 * The stub is also the countable evidence for "a replay runs no second model
 * turn": every completion is appended to an in-process log that the harness
 * reads at `/__log`. It never decides anything; the assertions stay on the
 * Worker's HTTP answers and D1 rows.
 *
 * Nothing here is a protocol surface. It is a test fixture shaped like the one
 * provider the Worker already knows how to call.
 */

import http from 'node:http';

const PORT = Number(process.env.MODEL_STUB_PORT ?? 8791);

/** Every completion this process served, oldest first. */
const served = [];

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
};

function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (part !== null && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
        .join('');
    }
    return '';
  }
  return '';
}

const TOOLS = {
  send_sms: {
    device_id: 'dev-pool-none',
    to: '+15555550199',
    body: 'pool probe',
    reason: 'conformance pool test',
  },
  create_rule_now: {
    matcher: { type: 'exact', value: 'POOL' },
    body_matcher: { type: 'keyword', value: 'probe' },
    reply_template: 'pool probe',
  },
};

function completion(reqBody) {
  const text = lastUserText(reqBody.messages);
  const alreadyActed =
    Array.isArray(reqBody.messages) &&
    reqBody.messages.some((message) => message !== null && typeof message === 'object' && message.role === 'tool');
  const marker = alreadyActed ? null : /\[\[ACT:([a-z_]+)\]\]/.exec(text);
  const tool = marker === null ? null : marker[1];
  const model = typeof reqBody.model === 'string' ? reqBody.model : 'model-stub';

  if (tool !== null && TOOLS[tool] !== undefined) {
    return {
      id: `chatcmpl-stub-${served.length + 1}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `call_stub_${served.length + 1}`,
                type: 'function',
                function: { name: tool, arguments: JSON.stringify(TOOLS[tool]) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  return {
    id: `chatcmpl-stub-${served.length + 1}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: `stub answer: ${text.slice(0, 200)}` },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/__health') {
    return json(res, 200, { ok: true, served: served.length });
  }

  if (req.method === 'GET' && url.pathname === '/__log') {
    return json(res, 200, { served });
  }

  if (req.method === 'POST' && url.pathname === '/__reset') {
    served.length = 0;
    return json(res, 200, { cleared: true });
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(res, 400, { error: { message: 'body must be JSON' } });
      }
      const text = lastUserText(body.messages);
      const answer = completion(body);
      served.push({
        at: Date.now(),
        model: answer.model,
        user: text.slice(0, 300),
        tool: answer.choices[0].message.tool_calls?.[0]?.function.name ?? null,
        answer: answer.choices[0].message.content,
      });
      // Deliberately non-SSE: the Worker adapter handles a JSON body on the
      // stream path and emits the prose once, so this fixture stays simple.
      return json(res, 200, answer);
    });
    return;
  }

  return json(res, 404, { error: { message: 'not_found' } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`model stub on http://127.0.0.1:${PORT}`);
});
