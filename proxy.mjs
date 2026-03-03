#!/usr/bin/env node

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// --- Configuration ---

const PORT = parseInt(process.env.PORT || '3456');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'sonnet';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT || '360') * 1000;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3');
const MAX_BUDGET = process.env.MAX_BUDGET || '0.5';

// --- Model mapping ---

const MODEL_MAP = {
  'claude-opus-4': 'opus',
  'claude-opus-4-20250514': 'opus',
  'claude-sonnet-4': 'sonnet',
  'claude-sonnet-4-20250514': 'sonnet',
  'claude-haiku-4': 'haiku',
  'claude-haiku-4-5-20251001': 'haiku',
  'opus': 'opus',
  'sonnet': 'sonnet',
  'haiku': 'haiku',
};

const AVAILABLE_MODELS = [
  { id: 'claude-opus-4', owned_by: 'anthropic' },
  { id: 'claude-sonnet-4', owned_by: 'anthropic' },
  { id: 'claude-haiku-4', owned_by: 'anthropic' },
];

// --- State ---

let activeRequests = 0;
const activeProcesses = new Set();

// --- Helpers ---

function resolveModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  return MODEL_MAP[requested] || requested;
}

function parseMessages(messages) {
  const systemParts = [];
  const promptParts = [];
  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        systemParts.push(msg.content);
        break;
      case 'user':
        promptParts.push(typeof msg.content === 'string'
          ? msg.content
          : msg.content.map(c => c.text || '').join('\n'));
        break;
      case 'assistant':
        promptParts.push(`<previous_response>\n${msg.content}\n</previous_response>`);
        break;
    }
  }
  return {
    systemPrompt: systemParts.join('\n\n') || null,
    prompt: promptParts.join('\n\n'),
  };
}

function makeCompletionResponse(id, model, content, usage) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: usage?.input_tokens || 0,
      completion_tokens: usage?.output_tokens || 0,
      total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
    },
  };
}

function makeChunk(id, model, delta, finishReason) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason || null,
    }],
  };
}

function buildCliArgs(model, streaming, systemPrompt) {
  const args = [
    '-p',
    '--model', model,
    '--setting-sources', '',
    '--strict-mcp-config',
    '--tools', '',
    '--system-prompt', systemPrompt || 'You are a helpful assistant.',
    '--max-budget-usd', MAX_BUDGET,
  ];
  if (streaming) {
    args.push('--output-format', 'stream-json');
    args.push('--verbose');
    args.push('--include-partial-messages');
  }
  return args;
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function errorResponse(res, status, message) {
  jsonResponse(res, status, {
    error: { message, type: 'error', code: status },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// --- Request handlers ---

function handleHealth(req, res) {
  jsonResponse(res, 200, {
    status: 'ok',
    active_requests: activeRequests,
    max_concurrent: MAX_CONCURRENT,
  });
}

function handleModels(req, res) {
  jsonResponse(res, 200, {
    object: 'list',
    data: AVAILABLE_MODELS.map(m => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: m.owned_by,
    })),
  });
}

async function handleCompletions(req, res) {
  if (activeRequests >= MAX_CONCURRENT) {
    return errorResponse(res, 429, `Too many concurrent requests (max ${MAX_CONCURRENT})`);
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return errorResponse(res, 400, 'Invalid JSON body');
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return errorResponse(res, 400, 'messages array is required');
  }

  const model = resolveModel(body.model);
  const requestModel = body.model || `claude-${DEFAULT_MODEL}-4`;
  const streaming = body.stream === true;
  const { systemPrompt, prompt } = parseMessages(body.messages);
  const requestId = `chatcmpl-${randomUUID()}`;

  activeRequests++;

  try {
    if (streaming) {
      await handleStreaming(res, prompt, model, requestModel, requestId, systemPrompt);
    } else {
      await handleNonStreaming(res, prompt, model, requestModel, requestId, systemPrompt);
    }
  } finally {
    activeRequests--;
  }
}

function spawnClaude(model, streaming, prompt, systemPrompt) {
  const args = buildCliArgs(model, streaming, systemPrompt);
  const proc = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDECODE: undefined },
  });

  activeProcesses.add(proc);
  proc.on('close', () => activeProcesses.delete(proc));

  // Write prompt to stdin
  proc.stdin.write(prompt);
  proc.stdin.end();

  return proc;
}

function handleNonStreaming(res, prompt, model, requestModel, requestId, systemPrompt) {
  return new Promise((resolve) => {
    const proc = spawnClaude(model, false, prompt, systemPrompt);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        errorResponse(res, 504, 'Request timed out');
        resolve();
      }
    }, TIMEOUT_MS);

    // Kill subprocess on client disconnect
    res.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        proc.kill('SIGTERM');
        resolve();
      }
    });

    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0 || !stdout.trim()) {
        const errMsg = stderr.trim() || `Process exited with code ${code}`;
        errorResponse(res, 502, errMsg);
      } else {
        const response = makeCompletionResponse(requestId, requestModel, stdout.trim(), null);
        jsonResponse(res, 200, response);
      }
      resolve();
    });
  });
}

function handleStreaming(res, prompt, model, requestModel, requestId, systemPrompt) {
  return new Promise((resolve) => {
    const proc = spawnClaude(model, true, prompt, systemPrompt);
    let buffer = '';
    let settled = false;
    let firstChunkSent = false;

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(':ok\n\n');

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        res.write('data: [DONE]\n\n');
        res.end();
        resolve();
      }
    }, TIMEOUT_MS);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Send finish chunk
      const doneChunk = makeChunk(requestId, requestModel, {}, 'stop');
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      resolve();
    };

    // Kill subprocess on client disconnect
    res.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        proc.kill('SIGTERM');
        resolve();
      }
    });

    proc.stdout.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        // Handle content_block_delta for streaming text
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
          const text = event.event.delta?.text;
          if (text) {
            const delta = firstChunkSent ? { content: text } : { role: 'assistant', content: text };
            const sseChunk = makeChunk(requestId, requestModel, delta, null);
            res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
            firstChunkSent = true;
          }
        }

        // Result event signals completion
        if (event.type === 'result') {
          finish();
          return;
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      // Log stderr for debugging but don't fail
      const msg = chunk.toString().trim();
      if (msg) console.error(`[stderr] ${msg}`);
    });

    proc.on('close', (code) => {
      if (!settled) {
        if (code !== 0 && !firstChunkSent) {
          // Error before any content was sent
          settled = true;
          clearTimeout(timer);
          res.write(`data: ${JSON.stringify({ error: { message: `Process exited with code ${code}` } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          resolve();
        } else {
          finish();
        }
      }
    });
  });
}

// --- Router ---

function handleRequest(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === '/health' && req.method === 'GET') {
    return handleHealth(req, res);
  }
  if ((path === '/v1/models' || path === '/models') && req.method === 'GET') {
    return handleModels(req, res);
  }
  if ((path === '/v1/chat/completions' || path === '/chat/completions') && req.method === 'POST') {
    return handleCompletions(req, res);
  }

  errorResponse(res, 404, 'Not found');
}

// --- Server ---

const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`claude-cli-proxy listening on http://localhost:${PORT}`);
  console.log(`  Default model: ${DEFAULT_MODEL}`);
  console.log(`  Max concurrent: ${MAX_CONCURRENT}`);
  console.log(`  Timeout: ${TIMEOUT_MS / 1000}s`);
  console.log(`  Budget per request: $${MAX_BUDGET}`);
});

// --- Cleanup ---

function cleanup() {
  console.log('\nShutting down...');
  for (const proc of activeProcesses) {
    proc.kill('SIGTERM');
  }
  server.close();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
