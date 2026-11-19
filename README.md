# llama-chat-standalone

The llama.cpp chat UI as a separate webapp. It serves the UI and proxies the
API to any OpenAI-compatible inference server.

The UI is a copy of `ui/` from [llama.cpp](https://github.com/ggml-org/llama.cpp).
It calls its API on the same origin with relative paths, so this server is the
only place that needs to know where the model server lives. No UI source is
changed.

## Quick start

```sh
cp .env.example .env      # edit UPSTREAM, MODEL_ID, PORT
make build                # install UI dependencies and build the UI
make start                # serve on http://localhost:8080
make status
make stop
```

`make help` lists every target.

## Configuration

All settings are environment variables. `make` reads them from the shell or
from `.env` if you export it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port the webapp listens on |
| `HOST` | `0.0.0.0` | Bind address |
| `UPSTREAM` | `http://127.0.0.1:8888` | OpenAI-compatible server |
| `MODEL_ID` | `local-model` | Model id sent in requests |
| `N_CTX` | `8192` | Context window reported to the UI |
| `CHAT_TEMPLATE` | empty | Jinja chat template shown in the UI |
| `MODALITIES` | empty | `vision`, `audio`, `video`, comma separated |
| `API_KEY` | empty | Bearer token added when the client sends none |

## What the server does

- Serves the built UI from `ui/apps/chat/dist`.
- Proxies `/v1`, `/models`, `/slots`, `/tools` to `UPSTREAM`.
- Normalizes `/v1/chat/completions` before forwarding: adds `model` when the UI
  omits it (engines such as gufo require it) and drops non-positive `max_tokens`
  (llama.cpp uses `-1` for "no limit", gufo rejects it). The SSE response still
  streams straight through.
- Answers `/props` and `/v1/models` itself when the upstream does not. llama.cpp
  serves `/props`; most other engines do not, and the UI needs it to enable the
  chat form.
- Answers `/cors-proxy?url=...` itself, forwarding only the headers the UI
  prefixed with `x-llama-server-proxy-header-`. Remote MCP servers such as
  `https://api.githubcopilot.com/mcp` allow CORS only from `localhost`, so a
  page served on a LAN address cannot reach them directly. Turn on "use proxy"
  for the MCP server in the UI to route it through here.
- Sets `Cross-Origin-Embedder-Policy` and `Cross-Origin-Opener-Policy` on
  `index.html`, which the UI's sandbox worker needs.

## Docker

```sh
make deploy               # build image, (re)start container, prune old image
make docker-down          # stop container and remove its image
make docker-logs
```

`docker-compose.yml` maps `host.docker.internal` to the host, so `UPSTREAM` can
point at a server on the host.

## Updating the UI

```sh
make sync-ui LLAMA_CPP_DIR=/path/to/llama.cpp
make build
```

`scripts/sync-ui.sh` replaces `ui/` with a fresh copy and drops build output.

## Test

```sh
make test
```

`test.mjs` starts a fake upstream that knows nothing about llama.cpp and checks
the `/props` and `/v1/models` fallbacks, the static path guard, and the
cross-origin headers.

## License

MIT. The UI in `ui/` is from llama.cpp, Copyright (c) 2023-2026 The ggml authors.
