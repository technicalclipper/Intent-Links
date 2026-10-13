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


def _action_from(tool_args: dict[str, Any], ctx: Context, tool_name: str) -> ProposedAction:
    state = ctx.state
    # Observation tools carry no verb of their own. Falling through with an
    # empty one made every read propose verb="" - which matched no allow rule,
    # was denied by default, and left the agent unable to see the page at all.
    verb = str(tool_args.get("verb") or tool_name)
    """
    Which step this is, according to the EXTENSION rather than the model.

    The extension drives the loop, so it knows which step it is on; the model
    only remembers what it was told. Compiled step ids are descriptive
    (set_appearance_theme), and a model that answers "s1" - or the step's
    title - makes the argument lookup below miss, fall back to values it
    invented, and get the action refused for supplying something that came
    from neither the parameters nor the recording.
    """
    step_id = str(state.get(CURRENT_STEP_KEY) or tool_args.get("step_id") or "")


    """
    Policy rules match on named arguments, and the compiled step already says
    what those are. Letting the model restate them means a rule like
      allow set_theme where theme matches light
    silently stops matching the moment it omits the argument or calls it
    something else - and the action falls through to deny-by-default with a
    message about the verb not being permitted, which is not the problem.

    So the authoritative values come from the intent, exactly as resolution
    hints come from the trace. Anything the model supplies is a fallback for
    steps the compiler did not describe.
    """
    declared = (state.get(STEP_ARGS_KEY) or {}).get(step_id) or {}
    args: dict[str, Any] = {**(tool_args.get("args") or {}), **declared}

    return ProposedAction(
        execution_id=str(state.get(EXECUTION_KEY, "")),
        step_id=step_id,
        verb=verb,
        object=tool_args.get("object"),
        args=args,
        origin=tool_args.get("origin"),
        path=tool_args.get("path"),
        # Only a well-formed digest is forwarded. A model-supplied hash is a
        # guess; a malformed one made the policy service reject the whole
        # action as invalid (400), which surfaced as an unexplained block
        # rather than a policy decision. Dropping it costs the token its
        # binding for that call, which is strictly better than a false block.
        target_hash=(
            th
            if isinstance(th := tool_args.get("target_hash"), str)
            and len(th) == 64
            and all(c in "0123456789abcdef" for c in th.lower())
            else None
        ),
        target_name=tool_args.get("target_name"),
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
        decision = await policy.decide(
            str(policy_id),
            action,
            receiver=state.get(RECEIVER_KEY),
            allowed_values=state.get(ALLOWED_VALUES_KEY),
        )

        if decision.outcome == "DENY":
            return _blocked(decision)

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
