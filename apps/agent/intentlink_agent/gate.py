"""The policy gate, implemented as an ADK before-tool callback.

This is the whole security thesis expressed in twenty lines of framework hook.

ADK's contract: `before_tool_callback(tool, args, ctx)` runs before every tool
invocation. Returning a dict makes ADK use that dict as the tool's result and
SKIP THE TOOL ENTIRELY. Returning None lets the tool run.

So:

    DENY      -> return a dict. The tool never executes. The model is told why,
                 in the creator's own words, and can try a compliant route.
    APPROVAL  -> ctx.request_confirmation(...), ADK's own human-in-the-loop
                 mechanism. No human, no action.
    ALLOW     -> stash the single-use token in session state and return None.
                 The tool runs, and redeems that token to act.

The model cannot route around this. It is not asked to cooperate, and nothing
it emits can reach an effect without passing through here first.
"""

from __future__ import annotations

from typing import Any

from google.adk.agents.context import Context
from google.adk.tools.base_tool import BaseTool

from .policy_client import PolicyClient, ProposedAction

# Session-state keys. Namespaced so they cannot collide with anything the model
# puts in state.
TOKEN_KEY = "intentlink:token"
EXECUTION_KEY = "intentlink:execution_id"
POLICY_KEY = "intentlink:policy_id"
RECEIVER_KEY = "intentlink:receiver"
ALLOWED_VALUES_KEY = "intentlink:allowed_values"
STEP_ARGS_KEY = "intentlink:step_args"
CURRENT_STEP_KEY = "intentlink:current_step"

# Tools that observe rather than act. They still pass through the gate so the
# policy's scope and data-exclusion rules apply to reads as well as writes.
GATED_TOOLS = {"perform_action", "read_page"}

# Only this one carries out the step. Observation tools are gated too - scope
# and data rules apply to looking - but they propose their own verb, because
# reading the page is not the step's action and must not borrow its
# permission. Applying the step's verb to read_page had it proposed as
# set_theme, so an observation was being authorized by the rule meant for the
# change itself.
ACTING_TOOLS = {"perform_action"}


def _action_from(tool_args: dict[str, Any], ctx: Context, tool_name: str) -> ProposedAction:
    state = ctx.state
    # Observation tools carry no verb of their own. Falling through with an
    # empty one made every read propose verb="" - which matched no allow rule,
    # was denied by default, and left the agent unable to see the page at all.
    """
    Which step this is, according to the EXTENSION rather than the model.

    The extension drives the loop, so it knows which step it is on; the model
    only remembers what it was told.
    """
    step_id = str(state.get(CURRENT_STEP_KEY) or tool_args.get("step_id") or "")
    declared = (state.get(STEP_ARGS_KEY) or {}).get(step_id) or {}

    """
    Verb, object and arguments come from the COMPILED STEP.

    Policy rules match on all three, and the model restating them is a
    transcription step that can only lose information. It has produced
    set_appearance_theme where the policy said set_theme, dropped an argument
    a constraint depended on, and named a step that does not exist - each one
    surfacing as "not among the actions this IntentLink permits" for an action
    that was permitted all along.

    The model's remaining job is the part only it can do: judging WHICH
    element on the page satisfies the step, and whether to proceed. What the
    action IS was settled at compile time.
    """
    acting = tool_name in ACTING_TOOLS

    # Order matters: the compiled step is authoritative, the model is the
    # fallback for an action the compiler never described, and the tool name
    # is the last resort for tools that carry no verb at all. Collapsing
    # straight to the tool name made every action propose "perform_action".
    verb = str(
        (declared.get("verb") if acting else None)
        or (tool_args.get("verb") if acting else None)
        or tool_name
    )
    obj = (declared.get("object") if acting else None) or (
        tool_args.get("object") if acting else None
    )
    args: dict[str, Any] = (
        {**(tool_args.get("args") or {}), **(declared.get("args") or {})}
        if acting
        else {}
    )

    return ProposedAction(
        execution_id=str(state.get(EXECUTION_KEY, "")),
        step_id=step_id,
        verb=verb,
        object=obj,
        args=args,
        origin=tool_args.get("origin"),
        path=tool_args.get("path"),
        target_hash=_target_hash(tool_args, state),
        target_name=tool_args.get("target_name"),
    )


def _target_hash(tool_args: dict[str, Any], state: Any) -> str | None:
    """The hash of the element the extension actually resolved.

    Looked up by HANDLE from the observation the extension just reported,
    rather than taken from the model. A model-relayed hash produced a token
    bound to one value and redeemed against another - "wrong_target" on an
    action the engine had permitted.

    The model's job is choosing WHICH candidate; the extension computed the
    hashes and is the only thing that knows them. Its handle is the answer,
    and the hash follows from it.
    """
    handle = tool_args.get("target_handle")
    observation = state.get("intentlink:observation") or {}
    for candidate in observation.get("candidates", []):
        if candidate.get("handle") == handle:
            digest = candidate.get("targetHash")
            if _is_digest(digest):
                return str(digest)
            return None

    # No matching candidate: fall back to the model's, but only if it is at
    # least well formed. A malformed one made the policy service reject the
    # whole action as invalid, which surfaced as an unexplained block.
    fallback = tool_args.get("target_hash")
    return str(fallback) if _is_digest(fallback) else None


def _is_digest(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(c in "0123456789abcdef" for c in value.lower())
    )


def _blocked(decision: Any) -> dict[str, Any]:
    """The payload the model receives instead of a tool result.

    Deliberately actionable: it names the rule in the creator's own words and,
    when the engine offers one, a compliant alternative. A block should teach
    the agent what it may do, not merely that it failed.
    """
    body: dict[str, Any] = {
        "intentlink_blocked": True,
        "reason": decision.reason,
    }
    if decision.source_text:
        body["boundary"] = decision.source_text
    if decision.rule_id:
        body["rule_id"] = decision.rule_id
    if decision.suggestion:
        body["suggestion"] = decision.suggestion
    return body


def make_policy_gate(client: PolicyClient | None = None):
    """Build the before-tool callback. Injectable client keeps it testable."""
    policy = client or PolicyClient()

    async def before_tool(
        tool: BaseTool,
        args: dict[str, Any],
        ctx: Context,
    ) -> dict[str, Any] | None:
        if tool.name not in GATED_TOOLS:
            return None

        state = ctx.state
        policy_id = state.get(POLICY_KEY)
        if not policy_id:
            # No policy pinned to this session means no authority exists at
            # all. Fail closed rather than treating absence as permission.
            return {
                "intentlink_blocked": True,
                "reason": "No IntentLink is bound to this session, so nothing is authorized.",
            }

        action = _action_from(args, ctx, tool.name)

# A known step with no declaration means the running agent and the published
        # workflow disagree about what exists. Falling back to the model's version
        # hides that behind a refusal naming a verb the policy never mentioned.
        known_steps = state.get(STEP_ARGS_KEY) or {}
        undeclared = (
            tool.name in ACTING_TOOLS
            and bool(known_steps)
            and action.step_id not in known_steps
        )
        decision = await policy.decide(
            str(policy_id),
            action,
            receiver=state.get(RECEIVER_KEY),
            allowed_values=state.get(ALLOWED_VALUES_KEY),
        )

        if decision.outcome == "DENY":
            blocked = _blocked(decision)
            if undeclared:
                blocked["reason"] = (
                    f'{blocked["reason"]} (step "{step_id}" is not part of this '
                    f"IntentLink - the running agent and the published workflow disagree; "
                    f"restart the agent service and publish a fresh link)"
                )
            return blocked

        if decision.outcome == "APPROVAL":
            ctx.request_confirmation(
                hint=decision.reason,
                payload={
                    "verb": action.verb,
                    "object": action.object,
                    "target": action.target_name,
                    "boundary": decision.source_text,
                    "route": decision.approval_route,
                },
            )
            return {
                "intentlink_blocked": True,
                "awaiting_approval": True,
                "reason": decision.reason,
                "route": decision.approval_route,
            }

        # ALLOW. Hand the tool its single-use authorization and step aside.
        state[TOKEN_KEY] = decision.token
        return None

    return before_tool
