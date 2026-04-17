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
