# IntentLink receiver agent (Google ADK)

The agent that consumes an IntentLink and executes it. Built on **Google ADK**
with **Gemini**, deployed to Cloud Run.

## The gate

`intentlink_agent/gate.py` is the whole security model, expressed in ADK's own
`before_tool_callback` hook:

| Decision | What the gate does | Effect |
|---|---|---|
| `DENY` | returns a dict | ADK uses it as the tool result and **never invokes the tool** |
| `APPROVAL` | `ctx.request_confirmation(...)` | ADK's native human-in-the-loop; no human, no action |
| `ALLOW` | stashes a single-use token in session state, returns `None` | the tool runs and redeems the token to act |

The agent process holds no signing secret and makes no authorization decision.
Authority lives in the TypeScript policy service, in another process, reached
over HTTP. An unreachable authority denies — we fail closed.

## Develop

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm run build --workspace @intentlink/api   # the gate tests boot the real service
.venv/bin/python -m pytest -q
```

Requires Python 3.10+. Verified on 3.14.5 with google-adk 2.11.0.
