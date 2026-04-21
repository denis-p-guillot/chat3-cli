# API runner (`run_api.sh`)

This project includes a helper script to start the local API with auto-reload:

```bash
./run_api.sh
```

The script starts `uvicorn` for `server:app` on `127.0.0.1` and, by default, port `8787`.

## What the script does

`run_api.sh` performs these steps before starting the server:

1. Moves to the project directory (so relative paths work consistently).
2. Reads the port from `PORT` (default: `8787`).
3. Frees the chosen port if another process is already listening:
   - graceful `kill`
   - fallback `kill -9` if still active
4. Launches:
   - `.venv/bin/uvicorn server:app --host 127.0.0.1 --port "$PORT" --reload`

## Prerequisites

- A local virtual environment at `.venv`
- `uvicorn` installed in that virtual environment
- `server.py` exposing `app` (for `server:app`)
- `lsof` available (optional, but recommended for automatic port cleanup)

## Usage

Run with default port:

```bash
./run_api.sh
```

Run with a custom port:

```bash
PORT=9000 ./run_api.sh
```

Then open:

- <http://127.0.0.1:8787> (or your custom `PORT`)
- Typical docs endpoint: <http://127.0.0.1:8787/docs>

## SECRET_KEY behavior

- You can provide `SECRET_KEY` through your shell environment or a `.env` file next to `server.py`.
- If `SECRET_KEY` is not provided, the server generates `data/.local_secret_key` on first run.
- `data/.local_secret_key` is expected to be git-ignored.

## Troubleshooting

- **Address already in use**: retry with another port, for example `PORT=9000 ./run_api.sh`.
- **`.venv/bin/uvicorn: No such file or directory`**: create/activate `.venv` and install dependencies.
- **`lsof not found` warning**: install `lsof`, or manually stop the old process using the target port.
# chat3

Local CLI technical assistant using the OpenAI API (`gpt-5.4` by default), with filesystem, git, and archive tools.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY="your_api_key_here"
```

## Run (CLI)

```bash
./go.sh
# or
python3 chat3.py
```

## Web UI (React)

Development (two terminals):

1. API server (listens on `127.0.0.1:8787`):

   ```bash
   ./run_api.sh
   ```

   Re-run the same command anytime to **restart** the API: it frees port `8787` first, then starts uvicorn (avoids “address already in use”). Override the port with `PORT=9000 ./run_api.sh` if needed.

2. Vite dev server (proxies `/api` to the API):

   ```bash
   cd web && npm install && npm run dev
   ```

Then open the URL Vite prints (usually `http://127.0.0.1:5173`). The UI streams tool calls and assistant replies over SSE. Attached files are **saved under** `workspace/uploads/` (up to 500 MB per file). The API **parses and summarizes them locally**; the model receives those summaries and uses tools to read or change files—it does not get raw full-file dumps in the chat.

Production-style (single process serving API + built static files):

```bash
cd web && npm run build
cd ..
./run_api.sh
```

With `web/dist` present, `uvicorn` serves the React app at `/` and the API under `/api`.

Runtime data (`history/`, `workspace/`) is created next to the script and is not tracked in git.
