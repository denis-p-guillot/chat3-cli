# chat3

Local CLI technical assistant using the OpenAI API (`gpt-5.4` by default), with filesystem, git, and archive tools.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY="your_api_key_here"
```

## Run

```bash
./go.sh
# or
python3 chat3.py
```

Runtime data (`history/`, `workspace/`) is created next to the script and is not tracked in git.
