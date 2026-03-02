# claude-cli-proxy

Lightweight OpenAI-compatible proxy for Claude Code CLI. Zero npm dependencies.

Claude Max/Pro subscribers get unlimited Claude access via the CLI but no API key. This proxy wraps `claude -p` as an HTTP server that speaks the OpenAI API format, so you can use any OpenAI-compatible client with your Claude subscription.

## Why not claude-max-api-proxy?

The existing [claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy) spawns `claude -p` without isolating the subprocess from your user config. Each request loads all your hooks, plugins, and MCP servers — causing infinite loops and massive token waste.

**claude-cli-proxy** fixes this with clean subprocess flags:

```bash
claude -p \
  --setting-sources ""      # skip ALL settings (hooks, plugins)
  --strict-mcp-config       # skip ALL MCP servers
  --tools ""                # no tool use
  --max-budget-usd 0.5      # safety cap per request
```

## Quick Start

```bash
git clone https://github.com/SenZhangAI/claude-cli-proxy.git
cd claude-cli-proxy
node proxy.mjs
```

No `npm install` needed — zero dependencies.

## Usage

### Test with curl

```bash
# Non-streaming
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4","messages":[{"role":"user","content":"Hello"}]}'

# Streaming
curl -N http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

### Use with any OpenAI client

```bash
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=not-needed

# Python
from openai import OpenAI
client = OpenAI()
response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello"}]
)

# Node.js
import OpenAI from 'openai';
const client = new OpenAI();
const response = await client.chat.completions.create({
    model: 'claude-sonnet-4',
    messages: [{ role: 'user', content: 'Hello' }],
});
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `DEFAULT_MODEL` | `sonnet` | Model when none specified |
| `TIMEOUT` | `120` | Request timeout in seconds |
| `MAX_CONCURRENT` | `3` | Max simultaneous requests |
| `MAX_BUDGET` | `0.5` | Dollar cap per request |

```bash
PORT=8080 DEFAULT_MODEL=haiku MAX_CONCURRENT=5 node proxy.mjs
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions |
| `GET` | `/v1/models` | List available models |
| `GET` | `/health` | Health check with active request count |

## Available Models

| OpenAI Model ID | Claude Model |
|-----------------|--------------|
| `claude-opus-4` | Opus |
| `claude-sonnet-4` | Sonnet |
| `claude-haiku-4` | Haiku |

Short aliases (`opus`, `sonnet`, `haiku`) also work.

## Prerequisites

- Node.js 18+
- Claude Code CLI installed and authenticated (`claude auth`)

## How It Works

1. Receives OpenAI-format request
2. Converts messages to a prompt string
3. Spawns `claude -p` with clean isolation flags
4. Pipes prompt via stdin, reads response from stdout
5. Returns OpenAI-format JSON (or SSE for streaming)

Subprocess cleanup is handled automatically — client disconnects kill the subprocess, timeouts are enforced, and all processes are cleaned up on server exit.

## License

MIT
