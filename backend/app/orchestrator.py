from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

from .agent_runtime import DEFAULT_VLM_MODEL
from .config import env
from .schemas import (
    AgentError,
    AgentToolCall,
    AgentTurn,
    ClarificationAnswerMessage,
    LevelEditProposal,
    PermissionRequest,
)


TOOL_NAMES = {
    "get_room_state",
    "list_candidates",
    "get_candidate",
    "list_semantic_objects",
    "answer_clarification",
    "propose_level_patch",
    "validate_level_patch",
    "request_permission",
    "apply_approved_patch",
    "cancel_job",
}


def _json_schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required or [], "additionalProperties": False}


def tool_definitions() -> list[dict[str, Any]]:
    patch_schema = {"type": "object", "additionalProperties": True}
    version_refs = {
        "captureVersion": {"type": "integer"},
        "candidateVersion": {"type": "integer"},
        "stageReferenceVersion": {"type": "integer"},
    }
    return [
        {"type": "function", "name": "get_room_state", "description": "Read current room state and version references.", "parameters": _json_schema({})},
        {"type": "function", "name": "list_candidates", "description": "List current semantic candidates.", "parameters": _json_schema({"captureVersion": {"type": "integer"}}, ["captureVersion"])},
        {"type": "function", "name": "get_candidate", "description": "Read one semantic candidate by id.", "parameters": _json_schema({"candidateId": {"type": "string"}, "captureVersion": {"type": "integer"}, "candidateVersion": {"type": "integer"}}, ["candidateId", "captureVersion"])},
        {"type": "function", "name": "list_semantic_objects", "description": "List accepted semantic objects.", "parameters": _json_schema({})},
        {
            "type": "function",
            "name": "answer_clarification",
            "description": "Answer an existing bounded candidate clarification using the same path as tap answers.",
            "parameters": _json_schema(
                {
                    "questionId": {"type": "string"},
                    "candidateId": {"type": "string"},
                    "choiceId": {"type": "string"},
                    "captureVersion": {"type": "integer"},
                    "sourceIds": {"type": "array", "items": {"type": "string"}},
                    "geometryHash": {"type": "string"},
                },
                ["questionId", "candidateId", "choiceId", "captureVersion", "sourceIds", "geometryHash"],
            ),
        },
        {
            "type": "function",
            "name": "propose_level_patch",
            "description": "Create a concrete scene plan and typed magicboard_world_patch proposal for user approval.",
            "parameters": _json_schema(
                {
                    "patch": patch_schema,
                    "scenePlan": {"type": "object", "additionalProperties": True},
                    "validationReport": {"type": "object", "additionalProperties": True},
                    "requiredPermissions": {"type": "array", "items": {"type": "string"}},
                    "requiredVersionRefs": {"type": "object", "properties": version_refs, "additionalProperties": False},
                },
                ["patch", "scenePlan", "validationReport"],
            ),
        },
        {"type": "function", "name": "validate_level_patch", "description": "Validate a patch envelope and current version refs.", "parameters": _json_schema({"patch": patch_schema, "requiredVersionRefs": {"type": "object", "properties": version_refs, "additionalProperties": False}}, ["patch"])},
        {
            "type": "function",
            "name": "request_permission",
            "description": "Request explicit user permission before risky actions.",
            "parameters": _json_schema(
                {
                    "action": {"type": "string", "enum": ["apply_patch", "replace_generated", "remove_generated", "delete_manual_content"]},
                    "arguments": {"type": "object", "additionalProperties": True},
                    "riskSummary": {"type": "string"},
                    "requiredVersionRefs": {"type": "object", "properties": version_refs, "additionalProperties": False},
                },
                ["action", "riskSummary"],
            ),
        },
        {"type": "function", "name": "apply_approved_patch", "description": "Mark an approved proposal ready for browser-side application.", "parameters": _json_schema({"proposalId": {"type": "string"}, "stageReferenceVersion": {"type": "integer"}}, ["proposalId"])},
        {"type": "function", "name": "cancel_job", "description": "Cancel a stable agent job by id.", "parameters": _json_schema({"jobId": {"type": "string"}}, ["jobId"])},
    ]


def _stable_id(prefix: str, *parts: object) -> str:
    import hashlib

    raw = "|".join(str(part) for part in parts) + "|" + datetime.now(UTC).isoformat()
    return prefix + "-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def _item_get(item: Any, name: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        return item.get(name, default)
    return getattr(item, name, default)


def _output_text(response: Any) -> str:
    text = getattr(response, "output_text", None)
    if isinstance(text, str):
        return text
    chunks: list[str] = []
    for item in _item_get(response, "output", []) or []:
        for content in _item_get(item, "content", []) or []:
            value = _item_get(content, "text")
            if isinstance(value, str):
                chunks.append(value)
    return "".join(chunks)


def _function_calls(response: Any) -> list[Any]:
    return [item for item in (_item_get(response, "output", []) or []) if _item_get(item, "type") == "function_call"]


class AgentOrchestrator:
    def __init__(self, registry: Any) -> None:
        self.registry = registry

    async def run_turn(self, room_id: str, session_id: str | None, transcript: str) -> AgentTurn:
        now = datetime.now(UTC)
        turn = AgentTurn(
            turnId=_stable_id("turn", room_id, session_id or "", transcript),
            sessionId=session_id,
            roomId=room_id,
            userTranscript=transcript,
            status="thinking",
            createdAt=now,
            updatedAt=now,
        )
        self.registry.upsert_agent_turn(room_id, turn)
        if not env("OPENAI_API_KEY"):
            return self._fail_turn(turn, "missing_key", "OPENAI_API_KEY is not configured.", True)

        try:
            turn = await asyncio.to_thread(self._run_openai_loop, room_id, session_id, transcript, turn)
        except Exception as error:
            turn = self._fail_turn(turn, "openai_failed", str(error), True)
        self.registry.upsert_agent_turn(room_id, turn)
        return turn

    def _fail_turn(self, turn: AgentTurn, code: str, message: str, retryable: bool) -> AgentTurn:
        return turn.model_copy(
            update={
                "status": "error",
                "error": AgentError(code=code, message=message, retryable=retryable),  # type: ignore[arg-type]
                "updated_at": datetime.now(UTC),
            }
        )

    def _run_openai_loop(self, room_id: str, session_id: str | None, transcript: str, turn: AgentTurn) -> AgentTurn:
        from openai import OpenAI

        client = OpenAI(api_key=env("OPENAI_API_KEY"))
        model = env("MAGICBOARD_VLM_MODEL") or DEFAULT_VLM_MODEL
        instructions = (
            "You are MagicBoard's deterministic level-editing agent. Use only the provided tools. "
            "Never invent arbitrary game data, generate code, apply changes silently, or bypass permissions. "
            "Create a scene plan and typed magicboard_world_patch proposal before playable mutations. "
            "If a request is unsupported, explain the unsupported operation briefly."
        )
        response = client.responses.create(
            model=model,
            instructions=instructions,
            input=[{"role": "user", "content": [{"type": "input_text", "text": transcript}]}],
            tools=tool_definitions(),
            tool_choice="auto",
            max_output_tokens=800,
        )
        tool_outputs: list[dict[str, str]] = []
        tool_calls = list(turn.tool_calls)
        for call in _function_calls(response):
            name = str(_item_get(call, "name") or "")
            call_id = str(_item_get(call, "call_id") or _item_get(call, "id") or _stable_id("tool", name))
            args_text = _item_get(call, "arguments") or "{}"
            try:
                args = json.loads(args_text) if isinstance(args_text, str) else dict(args_text)
            except Exception:
                args = {}
            record = AgentToolCall(toolCallId=call_id, name=name, arguments=args, status="running")
            tool_calls.append(record)
            result = self._run_tool(room_id, session_id, turn.turn_id, name, args)
            ok = not isinstance(result.get("error"), dict)
            tool_calls[-1] = record.model_copy(
                update={
                    "status": "succeeded" if ok else "failed",
                    "result": result if ok else None,
                    "error": AgentError.model_validate(result["error"]) if not ok else None,
                }
            )
            tool_outputs.append({"type": "function_call_output", "call_id": call_id, "output": json.dumps(result)})

        assistant = _output_text(response)
        if tool_outputs:
            followup = client.responses.create(
                model=model,
                previous_response_id=response.id,
                input=tool_outputs,
                max_output_tokens=500,
            )
            assistant = _output_text(followup) or assistant

        return turn.model_copy(
            update={
                "assistant_response": assistant,
                "tool_calls": tool_calls,
                "status": "complete",
                "updated_at": datetime.now(UTC),
            }
        )

    def _run_tool(self, room_id: str, session_id: str | None, turn_id: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name not in TOOL_NAMES:
            return {"error": AgentError(code="unsupported_operation", message=f"Unsupported tool: {name}", retryable=False).model_dump(mode="json")}
        room = self.registry.get_room(room_id)
        if name == "get_room_state":
            return self._room_state(room)
        if name == "list_candidates":
            stale = self._check_capture(room, args.get("captureVersion"))
            if stale:
                return stale
            return {"candidates": [candidate.model_dump(mode="json", by_alias=True) for candidate in (room.semantic_draft.candidates if room.semantic_draft else [])]}
        if name == "get_candidate":
            stale = self._check_capture(room, args.get("captureVersion"))
            if stale:
                return stale
            candidate = self._candidate(room, str(args.get("candidateId") or ""))
            if not candidate:
                return {"error": AgentError(code="unknown_candidate", message="Candidate was not found.", retryable=False).model_dump(mode="json")}
            expected = args.get("candidateVersion")
            if isinstance(expected, int) and candidate.candidate_version != expected:
                return {"error": AgentError(code="stale_candidate", message="Candidate version changed.", retryable=True).model_dump(mode="json")}
            return {"candidate": candidate.model_dump(mode="json", by_alias=True)}
        if name == "list_semantic_objects":
            return {"semanticObjects": room.semantic_objects}
        if name == "answer_clarification":
            return self._answer_clarification(room_id, args)
        if name == "validate_level_patch":
            return self._validate_patch(room, args.get("patch"), args.get("requiredVersionRefs") or {})
        if name == "propose_level_patch":
            validation = self._validate_patch(room, args.get("patch"), args.get("requiredVersionRefs") or {})
            if not validation.get("ok"):
                return validation
            proposal = LevelEditProposal(
                proposalId=_stable_id("proposal", room_id, turn_id),
                roomId=room_id,
                worldId=room.world_id,
                sessionId=session_id,
                turnId=turn_id,
                patch=args.get("patch") or {},
                scenePlan=args.get("scenePlan") or {},
                validationReport=args.get("validationReport") or validation,
                approvalState="pending_approval",
                requiredPermissions=list(args.get("requiredPermissions") or ["apply_patch"]),
                requiredVersionRefs=args.get("requiredVersionRefs") or {},
                createdAt=datetime.now(UTC),
                updatedAt=datetime.now(UTC),
            )
            self.registry.store_proposal(room_id, proposal)
            return {"proposal": proposal.model_dump(mode="json", by_alias=True)}
        if name == "request_permission":
            request = PermissionRequest(
                permissionRequestId=_stable_id("perm", room_id, name),
                roomId=room_id,
                sessionId=session_id,
                action=args.get("action") or "apply_patch",
                arguments=args.get("arguments") or {},
                riskSummary=str(args.get("riskSummary") or "Permission is required."),
                requiredVersionRefs=args.get("requiredVersionRefs") or {},
                status="pending",
                createdAt=datetime.now(UTC),
                updatedAt=datetime.now(UTC),
            )
            self.registry.store_permission_request(room_id, request)
            return {"permissionRequest": request.model_dump(mode="json", by_alias=True)}
        if name == "apply_approved_patch":
            proposal = self.registry.get_proposal(room_id, str(args.get("proposalId") or ""))
            if not proposal:
                return {"error": AgentError(code="tool_validation_failed", message="Proposal was not found.", retryable=False).model_dump(mode="json")}
            if proposal.approval_state != "approved":
                return {"error": AgentError(code="permission_required", message="Apply Plan must be approved first.", retryable=False).model_dump(mode="json")}
            expected = args.get("stageReferenceVersion")
            if isinstance(expected, int) and expected != room.stage_reference_version:
                return {"error": AgentError(code="stale_stage_reference", message="Stage reference changed.", retryable=True).model_dump(mode="json")}
            return {"proposal": proposal.model_dump(mode="json", by_alias=True), "applyInBrowser": True}
        if name == "cancel_job":
            return {"cancelled": False, "jobId": args.get("jobId"), "message": "No cancellable external jobs are active."}
        return {"error": AgentError(code="unsupported_operation", message=f"Unsupported tool: {name}", retryable=False).model_dump(mode="json")}

    def _room_state(self, room: Any) -> dict[str, Any]:
        return {
            "roomId": room.room_id,
            "worldId": room.world_id,
            "captureVersion": room.version,
            "semanticDraftVersion": room.semantic_draft.version if room.semantic_draft else 0,
            "stageReferenceVersion": room.stage_reference_version,
            "candidateCount": len(room.semantic_draft.candidates if room.semantic_draft else []),
            "proposalCount": len(room.proposals),
            "permissionRequestCount": len(room.permission_requests),
        }

    def _check_capture(self, room: Any, expected: Any) -> dict[str, Any] | None:
        if isinstance(expected, int) and expected != room.version:
            return {"error": AgentError(code="stale_capture", message="Capture version changed.", retryable=True).model_dump(mode="json")}
        return None

    def _candidate(self, room: Any, candidate_id: str) -> Any:
        for candidate in room.semantic_draft.candidates if room.semantic_draft else []:
            if candidate.candidate_id == candidate_id:
                return candidate
        return None

    def _answer_clarification(self, room_id: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            message = ClarificationAnswerMessage.model_validate(
                {
                    "type": "clarification_answer",
                    **args,
                    "worldId": self.registry.get_room(room_id).world_id,
                    "clientId": "semantic-agent",
                }
            )
            update = self.registry.store_answer(room_id, message)
            return {"semanticDraft": update.semantic_draft.model_dump(mode="json", by_alias=True)}
        except ValueError as error:
            return {"error": AgentError(code="tool_validation_failed", message=str(error), retryable=True).model_dump(mode="json")}

    def _validate_patch(self, room: Any, patch: Any, refs: dict[str, Any]) -> dict[str, Any]:
        errors: list[str] = []
        if refs.get("captureVersion") is not None and refs.get("captureVersion") != room.version:
            return {"error": AgentError(code="stale_capture", message="Capture version changed.", retryable=True).model_dump(mode="json")}
        if refs.get("stageReferenceVersion") is not None and refs.get("stageReferenceVersion") != room.stage_reference_version:
            return {"error": AgentError(code="stale_stage_reference", message="Stage reference changed.", retryable=True).model_dump(mode="json")}
        if not isinstance(patch, dict):
            errors.append("patch must be an object")
        else:
            if patch.get("type") != "magicboard_world_patch":
                errors.append("patch.type must be magicboard_world_patch")
            if patch.get("version") != 1:
                errors.append("patch.version must be 1")
            operations = patch.get("operations")
            if not isinstance(operations, list):
                errors.append("patch.operations must be an array")
            else:
                allowed = {"add_platform", "update_platform", "add_portal_pair", "remove_generated", "set_spawns", "set_character_skin", "set_roster", "set_world_metadata", "replace_platforms"}
                for index, operation in enumerate(operations):
                    op_type = operation.get("type") if isinstance(operation, dict) else None
                    if op_type not in allowed:
                        errors.append(f"operation {index} unsupported type")
        return {"ok": not errors, "errors": errors, "validation": "server_contract"}
