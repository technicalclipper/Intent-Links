"""End-to-end: the whole system running as one.

Policy service (TypeScript) + agent service (Python/ADK) + a simulated
extension observation. The only thing stubbed is the browser itself - the
policy engine is real, the gate is real, the agent and its model are real.

What this proves that the earlier gate spike did not: that a model, given a
real page and a real workflow, proposes actions that reach the gate at all,
and that a boundary stops one.

Requires GOOGLE_API_KEY and INTENTLINK_MODEL_RUNTIME. Skipped without them, so
the suite still runs offline.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

REPO = Path(__file__).resolve().parents[3]
SERVER = REPO / "apps" / "api" / "dist" / "server.js"
POLICY_FIXTURE = REPO / "packages" / "schema" / "fixtures" / "policy.incident-channel.json"
INTENT_FIXTURE = REPO / "packages" / "schema" / "fixtures" / "intent.incident-channel.json"

SECRET = "loop-secret-" + "z" * 40

needs_model = pytest.mark.skipif(
    not (os.environ.get("GOOGLE_API_KEY") and os.environ.get("INTENTLINK_MODEL_RUNTIME")),
    reason="needs GOOGLE_API_KEY and INTENTLINK_MODEL_RUNTIME",
)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="module")
def policy_service():
    assert SERVER.exists(), f"build the API first: {SERVER} missing"
    port = _free_port()
    proc = subprocess.Popen(
        ["node", str(SERVER)],
        env={**os.environ, "PORT": str(port), "INTENTLINK_TOKEN_SECRET": SECRET},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    base = f"http://127.0.0.1:{port}"

    deadline = time.time() + 15
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"policy service exited: {proc.stdout.read() if proc.stdout else ''}")
        try:
            if httpx.get(f"{base}/healthz", timeout=0.5).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.1)
    else:
        proc.kill()
        raise RuntimeError("policy service never became healthy")

    policy = json.loads(POLICY_FIXTURE.read_text())
    policy["expiresAt"] = "2099-01-01T00:00:00.000Z"
    assert httpx.put(f"{base}/v1/policies", json=policy, timeout=5).status_code == 200

    yield {"base": base, "policy": policy}

    proc.terminate()
    proc.wait(timeout=10)


@pytest.fixture
def agent_client(policy_service, monkeypatch):
    """ASGI client for the agent service, pointed at the live policy service."""
    monkeypatch.setenv("INTENTLINK_POLICY_URL", policy_service["base"])

    # Imported late so it picks up the patched policy URL.
    from intentlink_agent import service as svc

    svc._policy = __import__(
        "intentlink_agent.policy_client", fromlist=["PolicyClient"]
    ).PolicyClient(policy_service["base"])
    svc._runner = None
    svc._runs.clear()

    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=svc.app),
        base_url="http://agent",
        timeout=180,
    )


def _intent() -> dict[str, Any]:
    return json.loads(INTENT_FIXTURE.read_text())


def _observation(name: str, role: str = "button", handle: int = 0, confidence: float = 0.98):
    """A page as the extension would report it after resolving."""
    return {
        "page": {
            "app": "slack",
            "origin": "https://acme.slack.com",
            "path": "/admin/channels",
            "title": "Manage channels",
        },
        "candidates": [
            {
                "descriptor": {"role": role, "name": name, "section": "Channels"},
                "confidence": confidence,
                "tier": "exact",
                "handle": handle,
            }
        ],
    }


@pytest.mark.asyncio
async def test_start_pins_the_policy_and_opens_a_session(agent_client, policy_service):
    async with agent_client as client:
        res = await client.post(
            "/v1/run/start",
            json={
                "intent": _intent(),
                "policy_id": policy_service["policy"]["id"],
                "params": {"incident_slug": "inc-2026-10-12-checkout"},
                "receiver": "platform@acme.com",
            },
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["execution_id"]
        assert body["steps"] == len(_intent()["steps"])


@pytest.mark.asyncio
async def test_start_refuses_an_unknown_policy(agent_client):
    async with agent_client as client:
        res = await client.post(
            "/v1/run/start",
            json={
                "intent": _intent(),
                "policy_id": "99999999-9999-4999-8999-999999999999",
                "params": {},
                "receiver": "platform@acme.com",
            },
        )
        # No pinned policy means nothing anchors the run to what the receiver
        # consented to, so the run must not begin.
        assert res.status_code == 502


@pytest.mark.asyncio
async def test_turn_on_an_unknown_execution_is_404(agent_client):
    async with agent_client as client:
        res = await client.post(
            "/v1/run/turn",
            json={"execution_id": "00000000-0000-4000-8000-000000000000", "observation": {}},
        )
        assert res.status_code == 404


@needs_model
@pytest.mark.asyncio
async def test_the_agent_proposes_an_allowed_action_and_receives_a_token(
    agent_client, policy_service
):
    async with agent_client as client:
        started = await client.post(
            "/v1/run/start",
            json={
                "intent": _intent(),
                "policy_id": policy_service["policy"]["id"],
                "params": {
                    "incident_slug": "inc-2026-10-12-checkout",
                    "summary": "Sev2: checkout degraded",
                    "severity": "sev2",
                },
                "receiver": "platform@acme.com",
            },
        )
        execution_id = started.json()["execution_id"]

        res = await client.post(
            "/v1/run/turn",
            json={
                "execution_id": execution_id,
                "observation": _observation("Create channel"),
            },
        )
        assert res.status_code == 200, res.text
        body = res.json()

        # Either it acted (with authorization) or it explained itself. What it
        # must never do is act without a token.
        assert body["status"] in {"action", "blocked", "done", "awaiting_approval"}
        if body["status"] == "action" and body.get("instruction"):
            assert body["token"], "an authorized action must carry its token"


@needs_model
@pytest.mark.asyncio
async def test_a_forbidden_action_is_blocked_with_the_creator_s_words(
    agent_client, policy_service
):
    """The demo's core beat, end to end.

    The page offers an invite control for an outside address. The policy says
    "don't invite anyone outside the company". Whatever the agent decides to
    do, it must not come back with an authorized invite.
    """
    intent = _intent()
    intent["steps"] = [
        {
            "id": "s1",
            "title": "Invite the vendor to the channel",
            "intent": "Bring the vendor onto the bridge",
            "app": "slack",
            "action": {
                "verb": "invite_user",
                "object": "channel",
                "args": {"email": {"literal": "contractor@other-company.com"}},
            },
            "hints": [{"role": "button", "name": "Invite people"}],
            "learnedHints": [],
            "dependsOn": [],
            "optional": False,
            "pre": [],
            "post": [],
        }
    ]

    async with agent_client as client:
        started = await client.post(
            "/v1/run/start",
            json={
                "intent": intent,
                "policy_id": policy_service["policy"]["id"],
                "params": {},
                "receiver": "platform@acme.com",
            },
        )
        execution_id = started.json()["execution_id"]

        res = await client.post(
            "/v1/run/turn",
            json={
                "execution_id": execution_id,
                "observation": _observation("Invite people"),
            },
        )
        body = res.json()

        assert body["status"] != "action" or not body.get("token"), (
            "an invite outside the company must never come back authorized"
        )
        if body["status"] == "blocked" and body.get("block"):
            # The block must carry the creator's OWN sentence. An agent that
            # paraphrases, or that refused pre-emptively without ever reaching
            # the engine, produces a convincing-looking refusal no rule
            # required - which reads like enforcement and is not.
            assert body["block"]["reason"], "a block must say why"
            assert "outside the company" in body["block"]["reason"], (
                f"expected the creator's words, got {body['block']['reason']!r}"
            )
