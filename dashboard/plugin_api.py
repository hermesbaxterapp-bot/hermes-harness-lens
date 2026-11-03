"""Harness Lens — read-only API, mounted at /api/plugins/harness-lens/.

Counts coding-agent harness invocations (Claude Code, Codex, Antigravity CLI,
OpenCode, Copilot CLI, Gemini CLI, nested `hermes chat -q`) that a Hermes
session launched as *external processes* through its `terminal` / `execute_code`
tools. Hermes itself records those only as terminal commands, so no session,
token or cost row exists for the worker; this plugin recovers the invocation
count per session by pattern-matching the recorded tool-call arguments.

Reads: the profile's `state.db` (sqlite, read-only URI). Writes: nothing.
Routes: GET /health, GET /harnesses, GET /sessions, GET /sessions/{id}/invocations.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query

try:  # Hermes resolves the serving profile's home; fall back to env / default
    from hermes_constants import get_hermes_home  # type: ignore
except Exception:  # pragma: no cover
    get_hermes_home = None  # type: ignore

router = APIRouter()

PLUGIN_VERSION = "0.1.0"

# ── Harness registry ─────────────────────────────────────────────────────────
# Only non-interactive "run one prompt" forms count: `which claude`,
# `claude --version`, `codex login` etc. are deliberately not matched.
_FLAGS = r"(?:--?[\w-]+(?:[ =](?:\"[^\"]*\"|'[^']*'|[^\s\"']+))?\s+)*?"
_LEAD = r"(?<![\w./\\-])"
_END = r"(?=\s|$|[;&|)])"

HARNESSES: List[Dict[str, Any]] = [
    {
        "id": "claude-code",
        "label": "Claude Code",
        "binary": "claude",
        "pattern": re.compile(_LEAD + r"claude(?:\.cmd|\.exe)?\s+" + _FLAGS + r"(?:-p|--print)" + _END),
    },
    {
        "id": "codex",
        "label": "Codex",
        "binary": "codex",
        "pattern": re.compile(_LEAD + r"codex(?:\.cmd|\.exe)?\s+" + _FLAGS + r"exec" + _END),
    },
    {
        "id": "antigravity",
        "label": "Antigravity (agy)",
        "binary": "agy",
        "pattern": re.compile(_LEAD + r"agy(?:\.exe)?\s+" + _FLAGS + r"(?:-p|--print|--prompt)" + _END),
    },
    {
        "id": "opencode",
        "label": "OpenCode",
        "binary": "opencode",
        "pattern": re.compile(_LEAD + r"opencode(?:\.cmd|\.exe)?\s+" + _FLAGS + r"run" + _END),
    },
    {
        "id": "copilot",
        "label": "Copilot CLI",
        "binary": "copilot",
        "pattern": re.compile(_LEAD + r"copilot(?:\.cmd|\.exe)?\s+" + _FLAGS + r"(?:-p|--prompt)" + _END),
    },
    {
        "id": "gemini",
        "label": "Gemini CLI",
        "binary": "gemini",
        "pattern": re.compile(_LEAD + r"gemini(?:\.cmd|\.exe)?\s+" + _FLAGS + r"(?:-p|--prompt)" + _END),
    },
    {
        "id": "hermes-cli",
        "label": "Hermes (nested)",
        "binary": "hermes",
        "pattern": re.compile(_LEAD + r"hermes(?:\.cmd|\.exe)?\s+" + _FLAGS + r"chat\s+" + _FLAGS + r"(?:-q|--query)" + _END),
    },
]
_HARNESS_BY_ID = {h["id"]: h for h in HARNESSES}
# cheap SQL prefilter: a tool_calls blob must mention one of the binaries at all
_SQL_PREFILTER = " OR ".join("tool_calls LIKE ?" for _ in HARNESSES)
_SQL_PREFILTER_ARGS = [f"%{h['binary']}%" for h in HARNESSES]

_SECRET = re.compile(r"(?i)\b([A-Z0-9_]*(?:api[_-]?key|token|secret|password|passwd)[A-Z0-9_]*)\s*([=:])\s*(['\"]?)[^\s'\"]+")
_CD_PREFIX = re.compile(r"^\s*(?:cd|pushd)\s+(\"[^\"]+\"|'[^']+'|\S+)\s*(?:&&|;)")
_CMD_SNIPPET_CHARS = 600


# ── Home / DB ───────────────────────────────────────────────────────────────

def _hermes_home() -> Path:
    if get_hermes_home is not None:
        try:
            return Path(get_hermes_home())
        except Exception:
            pass
    configured = os.environ.get("HERMES_HOME")
    if configured:
        return Path(configured)
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "hermes"


def _hermes_root() -> Path:
    home = _hermes_home()
    if home.parent.name == "profiles" and (home.parent.parent / "state.db").exists():
        return home.parent.parent
    return home


def _discovered_profiles() -> List[str]:
    root = _hermes_root()
    names: List[str] = []
    if (root / "state.db").exists():
        names.append("default")
    profiles = root / "profiles"
    try:
        if profiles.exists():
            for entry in sorted(p for p in profiles.iterdir() if p.is_dir()):
                if (entry / "state.db").exists():
                    names.append(entry.name)
    except OSError:
        pass
    return names


def _serving_profile() -> str:
    home = _hermes_home()
    root = _hermes_root()
    return "default" if home == root else home.name


def _profile_db(name: str) -> Path:
    root = _hermes_root()
    return (root / "state.db") if name == "default" else (root / "profiles" / name / "state.db")


def _scope(profiles_param: str) -> List[Tuple[str, Path]]:
    text = profiles_param.strip() if isinstance(profiles_param, str) else ""
    available = _discovered_profiles()
    if not text:
        names = [_serving_profile()]
    elif text.lower() == "all":
        names = available
    else:
        wanted = {p.strip() for p in text.split(",") if p.strip()}
        names = [n for n in available if n in wanted] or [_serving_profile()]
    return [(n, _profile_db(n)) for n in names if _profile_db(n).exists()]


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


# ── Scan (cached per db) ────────────────────────────────────────────────────

_cache_lock = threading.Lock()
_cache: Dict[str, Dict[str, Any]] = {}
_CACHE_TTL = 20.0


def _redact(text: str) -> str:
    return _SECRET.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}***", text)


def _cwd_of(command: str, args: Dict[str, Any]) -> str:
    wd = args.get("workdir") or args.get("cwd")
    if wd:
        return str(wd)
    m = _CD_PREFIX.match(command)
    if m:
        return m.group(1).strip("\"'")
    return ""


def _match_harnesses(text: str) -> List[Dict[str, Any]]:
    found: List[Dict[str, Any]] = []
    for h in HARNESSES:
        for m in h["pattern"].finditer(text):
            found.append({"harness": h["id"], "pos": m.start()})
    found.sort(key=lambda x: x["pos"])
    return found


def _scan_db(profile: str, path: Path) -> Dict[str, Any]:
    """Every harness invocation in one state.db, with its tool result joined."""
    key = path.as_posix()
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit["at"] < _CACHE_TTL:
            return hit["data"]
    with _connect(path) as conn:
        try:
            cursor = conn.execute(
                "SELECT id, session_id, timestamp, tool_calls FROM messages "
                f"WHERE tool_calls IS NOT NULL AND ({_SQL_PREFILTER}) ORDER BY timestamp",
                _SQL_PREFILTER_ARGS,
            )
            rows = cursor.fetchall()
        except sqlite3.Error as exc:
            raise HTTPException(status_code=500, detail=f"state.db query failed: {exc}") from None

        invocations: List[Dict[str, Any]] = []
        call_ids: List[str] = []
        for row in rows:
            try:
                calls = json.loads(row["tool_calls"])
            except Exception:
                continue
            if not isinstance(calls, list):
                continue
            for call in calls:
                fn = (call or {}).get("function") or {}
                name = fn.get("name")
                if name not in ("terminal", "execute_code"):
                    continue
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    args = {}
                if not isinstance(args, dict):
                    args = {}
                text = str(args.get("command") or args.get("code") or "")
                if not text:
                    continue
                matches = _match_harnesses(text)
                if not matches:
                    continue
                call_id = str(call.get("id") or "")
                cwd = _cwd_of(text, args)
                for m in matches:
                    start = max(0, m["pos"] - 40)
                    snippet = text[start:start + _CMD_SNIPPET_CHARS]
                    invocations.append({
                        "profile": profile,
                        "session_id": row["session_id"],
                        "message_id": row["id"],
                        "tool_call_id": call_id,
                        "tool": name,
                        "harness": m["harness"],
                        "timestamp": row["timestamp"],
                        "cwd": cwd,
                        "command": _redact(snippet),
                        "background": bool(args.get("background")),
                        "status": "unknown",
                        "exit_code": None,
                        "duration_seconds": None,
                    })
                if call_id:
                    call_ids.append(call_id)

        # Join each tool call to its result row for exit code / wall time.
        results: Dict[str, sqlite3.Row] = {}
        for i in range(0, len(call_ids), 400):
            chunk = call_ids[i:i + 400]
            marks = ",".join("?" for _ in chunk)
            try:
                for r in conn.execute(
                    f"SELECT tool_call_id, timestamp, content FROM messages WHERE role='tool' AND tool_call_id IN ({marks})",
                    chunk,
                ):
                    results[str(r["tool_call_id"])] = r
            except sqlite3.Error:
                break
        for inv in invocations:
            r = results.get(inv["tool_call_id"])
            if r is None:
                continue
            try:
                inv["duration_seconds"] = round(max(0.0, float(r["timestamp"]) - float(inv["timestamp"])), 1)
            except Exception:
                pass
            content = r["content"] or ""
            status, code = _result_status(content)
            inv["status"] = status
            inv["exit_code"] = code

        session_ids = sorted({inv["session_id"] for inv in invocations})
        sessions: Dict[str, Dict[str, Any]] = {}
        for i in range(0, len(session_ids), 400):
            chunk = session_ids[i:i + 400]
            marks = ",".join("?" for _ in chunk)
            for r in conn.execute(
                "SELECT id, title, source, model, started_at, ended_at, last_activity_at, cwd, git_repo_root, "
                "git_branch, estimated_cost_usd, actual_cost_usd, cost_status, input_tokens, output_tokens, "
                "cache_read_tokens, message_count, tool_call_count, end_reason "
                f"FROM sessions WHERE id IN ({marks})",
                chunk,
            ):
                sessions[str(r["id"])] = dict(r)

    data = {"invocations": invocations, "sessions": sessions, "scanned_at": now}
    with _cache_lock:
        _cache[key] = {"at": now, "data": data}
    return data


def _result_status(content: str) -> Tuple[str, Optional[int]]:
    """Status of a terminal / execute_code result: JSON exit_code when present, else text signature."""
    text = content.strip()
    code: Optional[int] = None
    if text.startswith("{"):
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                raw = obj.get("exit_code")
                if raw is None and isinstance(obj.get("result"), dict):
                    raw = obj["result"].get("exit_code")
                if isinstance(raw, int):
                    code = raw
                if obj.get("error") and code is None:
                    return "error", None
        except Exception:
            pass
    if code is not None:
        return ("ok" if code == 0 else "error"), code
    m = re.search(r"exit[_ ]code[\"']?\s*[:=]\s*(-?\d+)", text)
    if m:
        code = int(m.group(1))
        return ("ok" if code == 0 else "error"), code
    if re.search(r"(?i)\b(traceback|command not found|timed out|permission denied)\b", text[:4000]):
        return "error", None
    return "ok", None


# ── Shaping ─────────────────────────────────────────────────────────────────

def _project_of(sess: Dict[str, Any]) -> str:
    root = sess.get("git_repo_root") or sess.get("cwd") or ""
    root = str(root).replace("\\", "/").rstrip("/")
    return root.rsplit("/", 1)[-1] if root else ""


def _in_period(sess: Dict[str, Any], since: Optional[float]) -> bool:
    if since is None:
        return True
    last = sess.get("last_activity_at") or sess.get("ended_at") or sess.get("started_at") or 0
    try:
        return float(last) >= since
    except Exception:
        return True


def _sessions_payload(profiles_param: str, days: int) -> Dict[str, Any]:
    since = (time.time() - days * 86400) if days and days > 0 else None
    out: List[Dict[str, Any]] = []
    totals = {"invocations": 0, "failed": 0, "sessions": 0, "by_harness": {h["id"]: 0 for h in HARNESSES}}
    scope = _scope(profiles_param)
    for profile, path in scope:
        data = _scan_db(profile, path)
        per: Dict[str, Dict[str, Any]] = {}
        for inv in data["invocations"]:
            sid = inv["session_id"]
            sess = data["sessions"].get(sid, {"id": sid})
            if not _in_period(sess, since):
                continue
            row = per.get(sid)
            if row is None:
                row = {
                    "id": sid,
                    "profile": profile,
                    "title": sess.get("title") or "",
                    "source": sess.get("source") or "",
                    "model": sess.get("model") or "",
                    "project": _project_of(sess),
                    "cwd": sess.get("cwd") or "",
                    "branch": sess.get("git_branch") or "",
                    "started_at": sess.get("started_at"),
                    "last_activity_at": sess.get("last_activity_at"),
                    "ended_at": sess.get("ended_at"),
                    "end_reason": sess.get("end_reason"),
                    "cost_usd": sess.get("actual_cost_usd") if sess.get("actual_cost_usd") is not None else sess.get("estimated_cost_usd"),
                    "cost_status": sess.get("cost_status"),
                    "tokens": (sess.get("input_tokens") or 0) + (sess.get("output_tokens") or 0) + (sess.get("cache_read_tokens") or 0),
                    "messages": sess.get("message_count") or 0,
                    "tool_calls": sess.get("tool_call_count") or 0,
                    "invocations": 0,
                    "failed": 0,
                    "unknown": 0,
                    "by_harness": {},
                    "first_invocation_at": inv["timestamp"],
                    "last_invocation_at": inv["timestamp"],
                    "wall_seconds": 0.0,
                }
                per[sid] = row
            row["invocations"] += 1
            row["by_harness"][inv["harness"]] = row["by_harness"].get(inv["harness"], 0) + 1
            if inv["status"] == "error":
                row["failed"] += 1
            elif inv["status"] == "unknown":
                row["unknown"] += 1
            if inv["duration_seconds"]:
                row["wall_seconds"] += inv["duration_seconds"]
            row["first_invocation_at"] = min(row["first_invocation_at"], inv["timestamp"])
            row["last_invocation_at"] = max(row["last_invocation_at"], inv["timestamp"])
        for row in per.values():
            row["harnesses"] = sorted(row["by_harness"], key=lambda k: -row["by_harness"][k])
            row["wall_seconds"] = round(row["wall_seconds"], 1)
            totals["invocations"] += row["invocations"]
            totals["failed"] += row["failed"]
            for k, v in row["by_harness"].items():
                totals["by_harness"][k] = totals["by_harness"].get(k, 0) + v
            out.append(row)
    out.sort(key=lambda r: (r.get("last_invocation_at") or 0), reverse=True)
    totals["sessions"] = len(out)
    return {
        "version": PLUGIN_VERSION,
        "generated_at": time.time(),
        "days": days,
        "profiles": [p for p, _ in scope],
        "available_profiles": _discovered_profiles(),
        "harnesses": [{"id": h["id"], "label": h["label"], "binary": h["binary"]} for h in HARNESSES],
        "totals": totals,
        "sessions": out,
        "method": (
            "Counted from recorded terminal/execute_code tool-call arguments matching a harness's "
            "non-interactive form (claude -p, codex exec, agy -p, opencode run, copilot -p, gemini -p, "
            "hermes chat -q). A command text that merely mentions such a form (e.g. writing docs) counts "
            "too; interactive launches and invocations from scripts Hermes did not run itself do not."
        ),
    }


# ── Routes ──────────────────────────────────────────────────────────────────

@router.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "version": PLUGIN_VERSION,
        "serving_profile": _serving_profile(),
        "profiles": _discovered_profiles(),
        "mutation_endpoints": 0,
    }


@router.get("/harnesses")
def harnesses() -> Dict[str, Any]:
    return {"harnesses": [{"id": h["id"], "label": h["label"], "binary": h["binary"], "pattern": h["pattern"].pattern} for h in HARNESSES]}


@router.get("/sessions")
def sessions(
    days: int = Query(30, ge=0, le=3650, description="Sessions active in the last N days; 0 = all time"),
    profiles: str = Query("", description="'' = serving profile, 'all', or a comma list"),
) -> Dict[str, Any]:
    return _sessions_payload(profiles, days)


@router.get("/sessions/{session_id}/invocations")
def session_invocations(
    session_id: str,
    profiles: str = Query("", description="'' = serving profile, 'all', or a comma list"),
) -> Dict[str, Any]:
    for profile, path in _scope(profiles):
        data = _scan_db(profile, path)
        rows = [inv for inv in data["invocations"] if inv["session_id"] == session_id]
        if rows:
            sess = data["sessions"].get(session_id, {})
            return {
                "session_id": session_id,
                "profile": profile,
                "title": sess.get("title") or "",
                "invocations": rows,
            }
    raise HTTPException(status_code=404, detail="No harness invocations recorded for that session in scope")
