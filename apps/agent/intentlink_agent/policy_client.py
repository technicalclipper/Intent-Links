"""HTTP client for the policy service.

The agent process holds no signing secret and makes no authorization decision
of its own. It asks, and it is told. Every function here is a question, never
an assertion.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

import httpx


@dataclass(frozen=True)
class Decision:
    outcome: str  # ALLOW | APPROVAL | DENY
    reason: str
    rule_id: str | None = None
    source_text: str | None = None
    suggestion: str | None = None
    approval_route: str | None = None
    token: str | None = None

    @property
    def allowed(self) -> bool:
        return self.outcome == "ALLOW"

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Decision":
        return cls(
            outcome=data["outcome"],
            reason=data.get("reason", ""),
            rule_id=data.get("ruleId"),
            source_text=data.get("sourceText"),
            suggestion=data.get("suggestion"),
            approval_route=data.get("approvalRoute"),
            token=data.get("token"),
        )


@dataclass
class ProposedAction:
    execution_id: str
    step_id: str
    verb: str
    object: str | None = None
    args: dict[str, Any] = field(default_factory=dict)
    origin: str | None = None
    path: str | None = None
    target_hash: str | None = None
    target_name: str | None = None

    def to_json(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "executionId": self.execution_id,
            "stepId": self.step_id,
            "verb": self.verb,
            "args": self.args,
        }
        for key, value in (
            ("object", self.object),
            ("origin", self.origin),
            ("path", self.path),
            ("targetHash", self.target_hash),
            ("targetName", self.target_name),
        ):
            if value is not None:
                body[key] = value
        return body


class PolicyClient:
    """Thin, synchronous-friendly client. Fails closed on every error path."""

    def __init__(self, base_url: str | None = None, timeout: float = 5.0) -> None:
        self._base = (base_url or os.environ.get("INTENTLINK_POLICY_URL", "http://127.0.0.1:8080")).rstrip("/")
        self._timeout = timeout

    async def decide(
        self,
        policy_id: str,
        action: ProposedAction,
        *,
        receiver: str | None = None,
        allowed_values: list[Any] | None = None,
        preview: bool = False,
    ) -> Decision:
        body: dict[str, Any] = {"policyId": policy_id, "action": action.to_json()}
        if receiver is not None:
            body["receiver"] = receiver
        if allowed_values is not None:
            body["allowedValues"] = allowed_values
        if preview:
            body["preview"] = True

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                res = await client.post(f"{self._base}/v1/decide", json=body)
        except httpx.HTTPError as exc:
            # An unreachable authority is not a permissive one. If we cannot
            # ask, the answer is no.
            return Decision(outcome="DENY", reason=f"policy service unreachable: {exc}")

        if res.status_code != 200:
            return Decision(
                outcome="DENY",
                reason=f"policy service refused the request ({res.status_code})",
            )
        return Decision.from_json(res.json())

    async def redeem(
        self,
        token: str,
        *,
        execution_id: str,
        step_id: str,
        verb: str,
        target_hash: str | None = None,
    ) -> tuple[bool, str]:
        """Spend a token. Returns (ok, reason)."""
        body: dict[str, Any] = {
            "token": token,
            "executionId": execution_id,
            "stepId": step_id,
            "verb": verb,
        }
        if target_hash is not None:
            body["targetHash"] = target_hash

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                res = await client.post(f"{self._base}/v1/redeem", json=body)
        except httpx.HTTPError as exc:
            return False, f"policy service unreachable: {exc}"

        if res.status_code == 200:
            return True, "ok"
        try:
            return False, res.json().get("reason", "refused")
        except Exception:
            return False, "refused"

    async def start_execution(self, execution_id: str, policy_id: str) -> bool:
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                res = await client.post(
                    f"{self._base}/v1/executions",
                    json={"executionId": execution_id, "policyId": policy_id},
                )
            return res.status_code == 200
        except httpx.HTTPError:
            return False
