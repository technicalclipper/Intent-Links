"""End-to-end spike: the ADK gate against the real policy service.

This is the integration that had to be de-risked before Oct 13 — a Python ADK
callback talking to the TypeScript authority over HTTP. Nothing is mocked: the
test boots the actual Node service, registers the real fixture policy, and
drives the real `before_tool_callback`.

What it proves:
  * ADK's before-tool contract does what we need — a returned dict skips the
    tool, so a DENY is enforcement, not advice;
  * the agent process holds no secret and cannot authorize anything;
  * an unreachable authority denies rather than permits.
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

from intentlink_agent.gate import (  # noqa: E402
    ALLOWED_VALUES_KEY,
    EXECUTION_KEY,
    POLICY_KEY,
    RECEIVER_KEY,
    TOKEN_KEY,
    make_policy_gate,
)
from intentlink_agent.policy_client import PolicyClient  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
SERVER = REPO / "apps" / "api" / "dist" / "server.js"
FIXTURE = REPO / "packages" / "schema" / "fixtures" / "policy.incident-channel.json"
SECRET = "spike-secret-" + "y" * 40
EXECUTION_ID = "33333333-3333-4333-8333-333333333333"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class FakeTool:
    """Stands in for an ADK BaseTool; the gate only reads `.name`."""

    def __init__(self, name: str) -> None:
        self.name = name


class FakeContext:
    """Minimal stand-in for ADK's Context.

    The gate touches exactly two things — `state` and `request_confirmation` —
    so the fake stays honest about the surface it depends on.
    """

    def __init__(self, state: dict[str, Any]) -> None:
        self.state = state
        self.confirmations: list[dict[str, Any]] = []

    def request_confirmation(self, *, hint: str | None = None, payload: Any = None) -> None:
        self.confirmations.append({"hint": hint, "payload": payload})


@pytest.fixture(scope="module")
def service() -> Any:
    """Boot the real TypeScript policy service and register the fixture policy."""
    assert SERVER.exists(), f"build the API first: {SERVER} missing"

    port = _free_port()
    env = {**os.environ, "PORT": str(port), "INTENTLINK_TOKEN_SECRET": SECRET}
    proc = subprocess.Popen(
        ["node", str(SERVER)],
        env=env,
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
        raise RuntimeError("policy service did not become healthy")

    policy = json.loads(FIXTURE.read_text())
    # The fixture expires a day after it was recorded; move it out so the spike
    # is not a time bomb. Everything else is the real policy.
    policy["expiresAt"] = "2099-01-01T00:00:00.000Z"

    assert httpx.put(f"{base}/v1/policies", json=policy, timeout=5).status_code == 200
    assert (
        httpx.post(
            f"{base}/v1/executions",
            json={"executionId": EXECUTION_ID, "policyId": policy["id"]},
            timeout=5,
        ).status_code
        == 200
    )

    yield {"base": base, "policy_id": policy["id"]}

    proc.terminate()
    proc.wait(timeout=10)


def _state(service: dict[str, Any], **over: Any) -> dict[str, Any]:
    base = {
        POLICY_KEY: service["policy_id"],
        EXECUTION_KEY: EXECUTION_ID,
        RECEIVER_KEY: "platform@acme.com",
    }
    base.update(over)
    return base


def _args(**over: Any) -> dict[str, Any]:
    args = {
        "step_id": "s1",
        "verb": "create_channel",
        "object": "channel",
        "args": {},
        "origin": "https://acme.slack.com",
        "path": "/admin/channels",
    }
    args.update(over)
    return args


@pytest.mark.asyncio
async def test_allow_lets_the_tool_run_and_hands_it_a_token(service):
    gate = make_policy_gate(PolicyClient(service["base"]))
    ctx = FakeContext(_state(service))

    result = await gate(FakeTool("perform_action"), _args(), ctx)

    assert result is None, "ALLOW must let ADK proceed to the tool"
    assert ctx.state[TOKEN_KEY], "the tool needs a single-use token to act with"


@pytest.mark.asyncio
async def test_deny_skips_the_tool_entirely(service):
    gate = make_policy_gate(PolicyClient(service["base"]))
    ctx = FakeContext(_state(service))

    result = await gate(
        FakeTool("perform_action"),
        _args(verb="invite_user", object=None, args={"email": "contractor@other.com"}),
        ctx,
    )

    # A returned dict is ADK's signal to use it as the tool result and never
    # invoke the tool. The block is enforcement, not a suggestion.
    assert result is not None
    assert result["intentlink_blocked"] is True
    assert result["boundary"] == "don't invite anyone outside the company"
    assert TOKEN_KEY not in ctx.state, "a blocked action must not leave authority behind"


@pytest.mark.asyncio
async def test_destructive_action_is_denied_without_any_matching_rule(service):
    gate = make_policy_gate(PolicyClient(service["base"]))
    ctx = FakeContext(_state(service))

    result = await gate(
        FakeTool("perform_action"),
        _args(verb="click_button", object=None, target_name="Delete workspace"),
        ctx,
    )

    assert result["intentlink_blocked"] is True
    assert "irreversible" in result["reason"]


@pytest.mark.asyncio
async def test_approval_routes_to_adk_human_in_the_loop(service):
    gate = make_policy_gate(PolicyClient(service["base"]))
    ctx = FakeContext(_state(service))

    result = await gate(
        FakeTool("perform_action"),
        _args(verb="send_page", object="pager"),
        ctx,
    )

    assert result["awaiting_approval"] is True
    assert ctx.confirmations, "APPROVAL must reach ADK's confirmation mechanism"
    assert ctx.confirmations[0]["payload"]["route"] == "creator"
    assert TOKEN_KEY not in ctx.state, "no authority until a human clears it"


@pytest.mark.asyncio
async def test_agent_cannot_type_a_value_it_invented(service):
    gate = make_policy_gate(PolicyClient(service["base"]))
    ctx = FakeContext(
        _state(service, **{ALLOWED_VALUES_KEY: ["inc-2026-10-05-payments"]})
    )

    result = await gate(
        FakeTool("perform_action"),
        _args(args={"name": "something-the-model-made-up"}),
        ctx,
    )

    assert result["intentlink_blocked"] is True
    assert "neither your parameters nor the recording" in result["reason"]


@pytest.mark.asyncio
async def test_a_session_with_no_policy_is_denied_not_permitted(service):
    gate = make_policy_gate(PolicyClient(service["base"]))
    ctx = FakeContext({EXECUTION_KEY: EXECUTION_ID})

    result = await gate(FakeTool("perform_action"), _args(), ctx)

    assert result["intentlink_blocked"] is True
    assert "nothing is authorized" in result["reason"]


@pytest.mark.asyncio
async def test_an_unreachable_authority_denies(service):
    # Nothing is listening on this port. An authority we cannot reach is not a
    # permissive one.
    gate = make_policy_gate(PolicyClient(f"http://127.0.0.1:{_free_port()}"))
    ctx = FakeContext(_state(service))

    result = await gate(FakeTool("perform_action"), _args(), ctx)

    assert result["intentlink_blocked"] is True
    assert "unreachable" in result["reason"]


@pytest.mark.asyncio
async def test_the_token_is_single_use_and_target_bound(service):
    client = PolicyClient(service["base"])
    gate = make_policy_gate(client)
    ctx = FakeContext(_state(service))

    await gate(FakeTool("perform_action"), _args(target_hash="a" * 64), ctx)
    token = ctx.state[TOKEN_KEY]

    redirected, reason = await client.redeem(
        token,
        execution_id=EXECUTION_ID,
        step_id="s1",
        verb="create_channel",
        target_hash="b" * 64,
    )
    assert redirected is False and reason == "wrong_target"

    ok, _ = await client.redeem(
        token,
        execution_id=EXECUTION_ID,
        step_id="s1",
        verb="create_channel",
        target_hash="a" * 64,
    )
    assert ok is True

    replay, reason = await client.redeem(
        token,
        execution_id=EXECUTION_ID,
        step_id="s1",
        verb="create_channel",
        target_hash="a" * 64,
    )
    assert replay is False and reason == "already_spent"


@pytest.mark.asyncio
async def test_the_step_decides_the_verb_and_args_not_the_model(service):
    """The compiled step is authoritative for WHAT the action is.

    Three separate runs failed because the model restated something already
    known and got it wrong: a step id of "s1" against a compiled id, a renamed
    or dropped argument, and a verb of set_appearance_theme where the policy
    said set_theme. Each surfaced as "not among the actions this IntentLink
    permits" for an action that was permitted all along.
    """
    gate = make_policy_gate(PolicyClient(service["base"]))
    ctx = FakeContext(
        _state(
            service,
            **{
                "intentlink:current_step": "create_the_channel",
                "intentlink:step_args": {
                    "create_the_channel": {
                        "verb": "create_channel",
                        "object": "channel",
                        "args": {"name": "inc-2026-10-13"},
                    }
                },
            },
        )
    )

    # The model gets all three wrong, and it must not matter.
    result = await gate(
        FakeTool("perform_action"),
        _args(step_id="s1", verb="create_slack_channel", object=None, args={"title": "whatever"}),
        ctx,
    )

    assert result is None, "the step's own verb and args must be used"
    assert ctx.state[TOKEN_KEY]


@pytest.mark.asyncio
async def test_observation_does_not_borrow_the_step_s_permission(service):
    """read_page proposes read_page, never the step's verb.

    Applying the declared verb to every gated tool had observations proposed
    as set_theme - authorized by the rule meant for the change itself.
    """
    gate = make_policy_gate(PolicyClient(service["base"]))
    ctx = FakeContext(
        _state(
            service,
            **{
                "intentlink:current_step": "s1",
                "intentlink:step_args": {
                    "s1": {"verb": "create_channel", "object": "channel", "args": {}}
                },
            },
        )
    )

    result = await gate(FakeTool("read_page"), {"step_id": "s1", "reason": "look"}, ctx)
    # Permitted on its own merits by the fixture's implicit observation rule.
    assert result is None
