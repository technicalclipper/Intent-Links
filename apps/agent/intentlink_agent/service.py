"""HTTP service around the receiver agent.

The extension drives the loop: it reports what is on screen, this service runs
one agent turn, and the response says what to do next. Request/response rather
than a push channel, so there is no socket to keep alive and no state stranded
in a service worker that MV3 killed mid-run.

Deployed to Cloud Run. Holds no credentials for anyone's tools - the browser
already has those - and no authority of its own, which lives in the policy
service this one calls.
"""

from __future__ import annotations

import json
import os
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel, Field

from .agent import build_agent, render_context
from .gate import (
    ALLOWED_VALUES_KEY,
    EXECUTION_KEY,
    POLICY_KEY,
    RECEIVER_KEY,
)
from .policy_client import PolicyClient

APP_NAME = "intentlink"

app = FastAPI(title="IntentLink receiver agent")

_sessions = InMemorySessionService()
_policy = PolicyClient()
_runner: Runner | None = None


def runner() -> Runner:
    """Built lazily so importing this module never needs a model configured."""
    global _runner
    if _runner is None:
        _runner = Runner(
            app_name=APP_NAME,
            agent=build_agent(_policy),
            session_service=_sessions,
        )
    return _runner


# Execution bookkeeping the agent does not own. Postgres replaces this; the
# shape is what the loop needs, not the storage.
_runs: dict[str, dict[str, Any]] = {}


class StartRequest(BaseModel):
    intent: dict[str, Any]
    policy_id: str
    params: dict[str, str] = Field(default_factory=dict)
    receiver: str | None = None


class StartResponse(BaseModel):
    execution_id: str
    steps: int


class TurnRequest(BaseModel):
    execution_id: str
    observation: dict[str, Any] = Field(default_factory=dict)
    last_result: dict[str, Any] | None = None


class TurnResponse(BaseModel):
    status: str  # action | blocked | awaiting_approval | done | failed
    narration: str = ""
    instruction: dict[str, Any] | None = None
    token: str | None = None
    assertion: dict[str, Any] | None = None
    block: dict[str, Any] | None = None


def _allowed_values(intent: dict[str, Any], params: dict[str, str]) -> list[Any]:
    """Everything the agent is permitted to type.

    The receiver's parameters plus the literals the compiler proved were
    demonstrated. The policy engine enforces this server-side; passing it here
    is what gives it the list.
    """
    values: list[Any] = list(params.values())
    for step in intent.get("steps", []):
        for arg in (step.get("action", {}).get("args") or {}).values():
            if "literal" in arg:
                values.append(arg["literal"])
    return values


@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.post("/v1/run/start", response_model=StartResponse)
async def start(req: StartRequest) -> StartResponse:
    execution_id = str(uuid.uuid4())

    if not await _policy.start_execution(execution_id, req.policy_id):
        # Without a pinned policy hash there is nothing anchoring this run to
        # the boundaries the receiver consented to.
        raise HTTPException(502, "policy service would not start the execution")

    await _sessions.create_session(
        app_name=APP_NAME,
        user_id=req.receiver or "receiver",
        session_id=execution_id,
        state={
            POLICY_KEY: req.policy_id,
            EXECUTION_KEY: execution_id,
            RECEIVER_KEY: req.receiver,
            ALLOWED_VALUES_KEY: _allowed_values(req.intent, req.params),
        },
    )

    _runs[execution_id] = {
        "intent": req.intent,
        "params": req.params,
        "receiver": req.receiver or "receiver",
        "completed": [],
    }

    return StartResponse(execution_id=execution_id, steps=len(req.intent.get("steps", [])))


@app.post("/v1/run/turn", response_model=TurnResponse)
async def turn(req: TurnRequest) -> TurnResponse:
    run = _runs.get(req.execution_id)
    if not run:
        raise HTTPException(404, "unknown execution")

    if req.last_result:
        _record_result(run, req.last_result)

    session = await _sessions.get_session(
        app_name=APP_NAME, user_id=run["receiver"], session_id=req.execution_id
    )
    if session is None:
        raise HTTPException(410, "execution session expired")

    brief = render_context(run["intent"], run["params"], run["completed"], req.observation)

    # The observation goes into session state as well as the prompt, because
    # read_page serves it back to the agent from there if it asks again.
    result = runner().run_async(
        user_id=run["receiver"],
        session_id=req.execution_id,
        new_message=types.Content(role="user", parts=[types.Part(text=brief)]),
        state_delta={"intentlink:observation": req.observation},
    )

    narration: list[str] = []
    response = TurnResponse(status="done")

    async for event in result:
        for part in (event.content.parts if event.content else []) or []:
            if getattr(part, "text", None):
                narration.append(part.text)

            call = getattr(part, "function_response", None)
            if call is None:
                continue
            payload = _as_dict(call.response)

            if payload.get("intentlink_blocked"):
                response = TurnResponse(
                    status="awaiting_approval" if payload.get("awaiting_approval") else "blocked",
                    block={
                        "reason": payload.get("reason", ""),
                        "boundary": payload.get("boundary"),
                        "suggestion": payload.get("suggestion"),
                        "route": payload.get("route"),
                    },
                )
            elif payload.get("status") == "authorized":
                response = TurnResponse(
                    status="action",
                    instruction=payload.get("instruction"),
                    token=payload.get("token"),
                )
            elif payload.get("assertion"):
                response = TurnResponse(status="action", assertion=payload["assertion"])
            elif payload.get("status") == "blocked":
                response = TurnResponse(
                    status="blocked",
                    block={
                        "reason": payload.get("boundary") or "the agent stopped at a boundary",
                        "boundary": payload.get("boundary"),
                        "suggestion": payload.get("guidance"),
                        "attempted": payload.get("attempted"),
                    },
                )

    response.narration = " ".join(n.strip() for n in narration if n.strip())[:2000]
    return response


def _record_result(run: dict[str, Any], result: dict[str, Any]) -> None:
    step_id = result.get("stepId")
    if not step_id:
        return
    run["completed"] = [c for c in run["completed"] if c["stepId"] != step_id]
    run["completed"].append(
        {
            "stepId": step_id,
            "status": result.get("status", "done"),
            "boundary": result.get("boundary"),
            "detail": result.get("reason"),
        }
    )


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8081")))
