"""The agent's action space.

Every tool here is gated: ADK's before_tool_callback runs first, asks the
policy service, and either lets the call through with a single-use token or
replaces it with a block. Nothing in this file decides anything about
authority - these are hands, not judgment.

The extension performs the actual DOM work. These tools are the agent's way of
SAYING what should happen; the worker carries the instruction to the page and
reports back. That split is why the agent can run on Cloud Run while the
actions happen in someone else's browser, with no credentials crossing.
"""

from __future__ import annotations

from typing import Any

from google.adk.agents.context import Context

from .gate import TOKEN_KEY


def read_page(step_id: str, reason: str, ctx: Context) -> dict[str, Any]:
    """Read what is currently on screen.

    Args:
        step_id: The workflow step this observation is for.
        reason: Why the page needs to be read, in one short phrase.

    Returns:
        The accessibility snapshot the extension last reported.
    """
    observation = ctx.state.get("intentlink:observation")
    if not observation:
        return {
            "error": "no page observation available",
            "hint": "the extension reports the page before each turn; wait for it",
        }
    return {
        "page": observation.get("page", {}),
        "candidates": observation.get("candidates", []),
        "tree": observation.get("tree", []),
    }


def perform_action(
    step_id: str,
    verb: str,
    target_handle: int,
    target_hash: str,
    target_name: str,
    args: dict[str, str],
    ctx: Context,
    object: str | None = None,
    value: str | None = None,
) -> dict[str, Any]:
    """Perform one action on the page.

    The call reaches here only if the policy engine allowed it; a denied action
    is replaced by the gate and this function never runs.

    Args:
        step_id: The workflow step being executed.
        verb: Semantic verb, e.g. create_channel or set_setting.
        target_handle: Handle of the resolved element, from the observation.
        target_hash: Hash of the resolved descriptor; binds the token to it.
        target_name: Accessible name of the element, for the audit trail.
        args: The step's semantic arguments by name, e.g. {"email": "..."} or
            {"project": "INC"}. Policy rules match on THESE, so they must be
            the step's real argument names rather than a single opaque value.
            Omitting them makes every argument-constrained rule inert.
        object: What the verb acts on, e.g. channel_visibility.
        value: The literal text to enter, when the action types something.

    Returns:
        An instruction for the extension to carry out, carrying its authorization.
    """
    # The gate authorized the step's OWN verb; the extension redeems against
    # it, and the token is bound to it. Sending the model's spelling here
    # would fail the redeem even though the action was permitted.
    # The extension drives the loop and told us which step this is. The token
    # was bound to THAT step, so returning the model's own step_id in the
    # instruction made the redeem fail as wrong_step on an action the engine
    # had just permitted. Last place the model's version was still leaking.
    step_id = str(ctx.state.get("intentlink:current_step") or step_id)
    declared = (ctx.state.get("intentlink:step_args") or {}).get(step_id) or {}
    verb = str(declared.get("verb") or verb)
    args = {**args, **(declared.get("args") or {})}

    token = ctx.state.get(TOKEN_KEY)
    if not token:
        # Reaching here without a token means the gate did not run, which would
        # mean the agent found a path around it. Refuse rather than proceed.
        return {
            "error": "no authorization present",
            "hint": "actions are authorized by the policy service, not by the agent",
        }

    # Spend-once: clear it so a second call cannot reuse this authorization even
    # before the server rejects the replay.
    ctx.state[TOKEN_KEY] = None

    return {
        "instruction": {
            "handle": target_handle,
            "verb": verb,
            "object": object,
            "value": value,
            "args": args,
            "targetHash": target_hash,
            "targetName": target_name,
            "stepId": step_id,
        },
        "token": token,
        "status": "authorized",
    }


def assert_outcome(
    step_id: str,
    describe: str,
    ctx: Context,
    text_contains: str | None = None,
    value_equals: str | None = None,
    checked: bool | None = None,
) -> dict[str, Any]:
    """Check that a step actually achieved what it intended.

    Verification reads the page back rather than trusting that the action
    returned without error. A tool call completing is the single most common
    way browser automation lies about having worked.

    Only valid for a step you have ALREADY performed. Verifying an untouched
    step proves nothing - the value may have been there all along - and the
    extension rejects such an assertion rather than counting it as success.

    Args:
        step_id: The step whose outcome is being verified.
        describe: What is being checked, in plain language.
        text_contains: Text expected somewhere on the page.
        value_equals: Exact value a field is expected to hold.
        checked: Expected state of a toggle.

    Returns:
        An assertion request for the extension to evaluate against the live page.
    """
    expect: dict[str, Any] = {}
    if text_contains is not None:
        expect["textContains"] = text_contains
    if value_equals is not None:
        expect["valueEquals"] = value_equals
    if checked is not None:
        expect["checked"] = checked
    if not expect:
        expect["exists"] = True

    return {
        "assertion": {"describe": describe, "expect": expect, "stepId": step_id},
        "status": "pending_extension",
    }


def report_blocked(step_id: str, boundary: str, attempted: str) -> dict[str, Any]:
    """Record that a boundary stopped this step, and stop trying.

    Call this ONLY after a tool result has actually come back blocked. It is
    not a way to decline an action you suspect is forbidden - the policy
    service decides that, and an agent that refuses pre-emptively manufactures
    a boundary no rule required.

    Args:
        step_id: The step that was blocked.
        boundary: The creator's sentence from the block, quoted EXACTLY.
            Never paraphrased, summarised or invented.
        attempted: What the agent had been about to do.
    """
    return {
        "status": "blocked",
        "stepId": step_id,
        "boundary": boundary,
        "attempted": attempted,
        "guidance": "Do not attempt an alternative route to the same effect. "
        "Move to the next independent step, or finish.",
    }
