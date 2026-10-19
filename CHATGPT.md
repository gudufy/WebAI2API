# WebAI2API ChatGPT branch

This branch replaces the DeepSeek web backend with the ChatGPT/Codex Responses backend.

## Architecture

The adapter forwards OpenAI Responses requests to:

`https://chatgpt.com/backend-api/codex/responses`

The upstream endpoint is Responses-native and stream-only, so this branch deliberately does **not** translate tool calls into XML/DSML or ask ChatGPT to emit tool-call markup. Function calls are received as native `response.output_item.*` / `response.function_call_arguments.*` events and passed through to Codex.

The local HTTP API remains:

- `POST /v1/responses`
- `GET /v1/models`
- `GET /health`
- `WS /v1/responses`

## Authentication

Set a valid ChatGPT/Codex OAuth access token before starting the server:

```powershell
$env:CHATGPT_ACCESS_TOKEN = "<your access token>"
$env:CHATGPT_ACCOUNT_ID = "<optional ChatGPT account id>"
pnpm run server-chatgpt
```

`ChatGPT-Account-Id` is automatically derived from the access-token JWT when it is not supplied.

## Codex

Point Codex at:

- HTTP: `http://127.0.0.1:8787/v1`
- Responses: `http://127.0.0.1:8787/v1/responses`
- WebSocket: `ws://127.0.0.1:8787/v1/responses`

The upstream ChatGPT Codex backend requires streaming. The adapter therefore always sends `stream: true` and `store: false` upstream, even when the local client requests a non-streaming response. For non-streaming requests the adapter collects the SSE stream and returns the final Responses JSON.

## Tool calls

Tool definitions and `function_call_output` items are forwarded as native Responses objects. No DeepSeek-specific prompt injection or tool-call parser is involved.

This is the main difference from the `main` branch: Codex can use ChatGPT's native Responses tool protocol instead of relying on model-generated DeepSeek XML/DSML markup.
