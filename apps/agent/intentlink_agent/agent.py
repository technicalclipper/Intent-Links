"""The receiver agent.

Built on Google ADK. The agent reasons about what to do next; the policy
service decides whether it may; the extension does it. Three processes, three
responsibilities, and the one that reasons holds no authority.

The loop is driven by the EXTENSION rather than pushed from here: it reports
what is on screen, the agent proposes one action, the extension carries it out
and reports again. Request/response rather than a socket, which means no
channel to keep alive and no state stranded in a service worker that died.
"""

from __future__ import annotations

import os
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.tools import FunctionTool

from .gate import make_policy_gate
from .policy_client import PolicyClient
from .tools import assert_outcome, perform_action, read_page, report_blocked

INSTRUCTION = """
You execute a workflow someone else recorded, inside the receiver's browser,
under boundaries the creator set.

HOW A TURN WORKS

You are given the workflow, the parameters the receiver supplied, what has been
done so far, and an observation of the current page. Choose ONE action and call
one tool. You will be called again after it completes.

RESOLUTION

The observation carries candidate elements with confidence scores, already
matched by a deterministic resolver against the recorded descriptors. Trust
them when confidence is high. When nothing is confident, read the accessibility
tree in the observation and pick the element that satisfies the step's INTENT -
the page may have been redesigned, the label reworded, or rendered in another
language. You are matching meaning, not strings.

If nothing on this page can satisfy the step, say so plainly. Do not click
something adjacent and hope.

VALUES

Only ever supply a value that came from the receiver's parameters or from the
original recording. Never invent one. If a field needs a value you do not have,
stop and report that the parameter is missing.

BOUNDARIES

You do not know what the policy permits, and you must never guess. The
boundaries live in a separate service that checks every action before it runs.

So: ATTEMPT THE ACTION. Always. Even one you suspect is forbidden. If it is
not allowed you will get a block back, with the creator's own words, and no
action will have occurred - that is the system working, not a failure you
should have avoided.

Never decide for yourself that something is against policy. An agent that
self-censors produces a convincing-looking refusal that no rule actually
required, which is worse than useless: it reads like enforcement and is not.

Only after a tool result comes back blocked may you call report_blocked, and
you must quote the boundary EXACTLY as the block gave it to you. Do not
paraphrase it, do not summarise it, and do not invent a reason. If the block
carried no boundary text, say so rather than supplying one.

Once an action is genuinely blocked, do not route around it: no different
verb, no different control, no different page that achieves the same forbidden
effect. Move to the next independent step, or finish.

An action needing approval is paused, not refused. Wait; do not substitute.

VERIFICATION

After a step that changes something, call assert_outcome to confirm the page
actually reflects it. A tool returning without error is not evidence that
anything happened.

NEVER verify a step you have not performed. Checking whether a setting already
has the value you were asked to set is not evidence of your work - it may have
been that way all along - and reporting it as success tells the receiver their
task is done when nothing was touched. If a step has not been performed,
perform it. If you cannot, say that.

Equally: never report the workflow complete when you have performed nothing.
"There was nothing to do" is almost always wrong; the far likelier
explanations are that you are on the wrong page, or that the control is one
you have not found yet. Say which.

FINISHING

When every step is done, blocked, or impossible, summarise what was achieved,
what was blocked and why, and what remains. Be accurate about partial success;
an honest partial result is useful and a false claim of completion is not.
""".strip()


def build_agent(policy_client: PolicyClient | None = None) -> LlmAgent:
    """Construct the receiver agent with the policy gate installed.

    The gate is attached as ADK's before_tool_callback, which runs before every
    tool invocation and can replace the call with its own result. Returning a
    block there means the tool never executes - enforcement rather than advice,
    using the framework's own interception point rather than something bolted
    alongside it.
    """
    model = os.environ.get("INTENTLINK_MODEL_RUNTIME")
    if not model:
        raise RuntimeError(
            "INTENTLINK_MODEL_RUNTIME is not set. Run-time resolution happens "
            "once per action, so this should be a low-latency model."
        )

    return LlmAgent(
        name="intentlink_receiver",
        model=model,
        instruction=INSTRUCTION,
        tools=[
            FunctionTool(read_page),
            FunctionTool(perform_action),
            FunctionTool(assert_outcome),
            FunctionTool(report_blocked),
        ],
        before_tool_callback=make_policy_gate(policy_client),
    )


def render_context(
    intent: dict[str, Any],
    params: dict[str, str],
    completed: list[dict[str, Any]],
    observation: dict[str, Any],
) -> str:
    """Everything the agent needs for one turn, as readable text.

    Deliberately not raw JSON: the model reasons better over a brief than over
    nested objects, and a compact rendering leaves more of the budget for the
    page itself.
    """
    lines: list[str] = []

    lines.append(f"GOAL: {intent.get('goal', '')}")
    lines.append("")

    lines.append("PARAMETERS the receiver supplied")
    for name, value in params.items():
        lines.append(f"  {name} = {value!r}")
    if not params:
        lines.append("  (none)")
    lines.append("")

    done = {entry["stepId"]: entry for entry in completed}
    lines.append("WORKFLOW")
    for step in intent.get("steps", []):
        status = done.get(step["id"], {}).get("status", "pending")
        marker = {
            "done": "[done]",
            "blocked": "[blocked]",
            "failed": "[failed]",
            "skipped": "[skipped]",
        }.get(status, "[    ]")

        args = " ".join(
            f"{k}=<{v['param']}>" if "param" in v else f"{k}={v['literal']!r}"
            for k, v in (step.get("action", {}).get("args") or {}).items()
        )
        lines.append(f"  {marker} {step['id']}  {step['action']['verb']} {args}".rstrip())
        if step.get("intent"):
            lines.append(f"          why: {step['intent']}")
        if step.get("condition"):
            lines.append(f"          only when: {step['condition']}")
        if status == "blocked":
            lines.append(f"          blocked by: {done[step['id']].get('boundary', '')}")

    lines.append("")
    page = observation.get("page", {})
    lines.append(f"CURRENT PAGE: {page.get('app', '?')} {page.get('path', '')}")

    candidates = observation.get("candidates", [])
    if candidates:
        lines.append("")
        lines.append("RESOLVED CANDIDATES (deterministic match against the recording)")
        for c in candidates[:5]:
            d = c["descriptor"]
            section = f" in {d['section']!r}" if d.get("section") else ""
            lines.append(
                f"  handle={c['handle']} confidence={c['confidence']:.2f} "
                f"{d['role']} {d['name']!r}{section}"
            )

    tree = observation.get("tree", [])
    if tree:
        # Only present when the deterministic tiers came up short, which is
        # exactly when the model's judgment is needed.
        lines.append("")
        lines.append("PAGE ELEMENTS (nothing matched confidently; choose by intent)")
        for i, d in enumerate(tree[:80]):
            section = f" in {d['section']!r}" if d.get("section") else ""
            lines.append(f"  handle={i} {d['role']} {d['name']!r}{section}")

    return "\n".join(lines)
