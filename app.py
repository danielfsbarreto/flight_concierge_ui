import json
import logging
import os
from queue import Empty, Queue
from threading import Lock

import requests as http_requests
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request

load_dotenv()

app = Flask(__name__)
app.logger.setLevel(logging.INFO)

CREWAI_ENTERPRISE_URL = os.environ["CREWAI_ENTERPRISE_URL"]
CREWAI_ENTERPRISE_TOKEN = os.environ["CREWAI_ENTERPRISE_TOKEN"]

sessions: dict[str, dict] = {}
sessions_lock = Lock()

sse_clients: dict[str, list[Queue]] = {}
sse_clients_lock = Lock()

# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────


def _get_or_create_session(flow_id: str) -> dict:
    with sessions_lock:
        if flow_id not in sessions:
            sessions[flow_id] = {
                "messages": [],
                "status": "processing",
                "keep_processing": True,
                "end_of_conversation": False,
                "pending_feedback": None,
            }
        return sessions[flow_id]


def _notify_sse_clients(flow_id: str):
    with sse_clients_lock:
        for q in sse_clients.get(flow_id, []):
            q.put(True)


# ──────────────────────────────────────────────
# Pages
# ──────────────────────────────────────────────


@app.route("/")
def index():
    return render_template("index.html")


# ──────────────────────────────────────────────
# API routes (called by the browser)
# ──────────────────────────────────────────────


@app.route("/api/warmup", methods=["POST"])
def api_warmup():
    """Ping CrewAI Enterprise /inputs to warm up the deployment."""
    try:
        resp = http_requests.get(
            f"{CREWAI_ENTERPRISE_URL}/inputs",
            headers={"Authorization": f"Bearer {CREWAI_ENTERPRISE_TOKEN}"},
            timeout=45,
        )
        resp.raise_for_status()
        return jsonify(resp.json())
    except http_requests.RequestException as exc:
        app.logger.warning("Warmup request failed: %s", exc)
        return jsonify({"error": "warmup failed"}), 502


@app.route("/api/start", methods=["POST"])
def api_start():
    """Start a new conversation by calling CrewAI Enterprise /kickoff."""
    body = request.get_json(force=True)
    user_content = body.get("message", "")

    if not user_content.strip():
        return jsonify({"error": "message is required"}), 400

    kickoff_payload = {
        "inputs": {
            "message": {"role": "user", "content": user_content},
        }
    }

    try:
        resp = http_requests.post(
            f"{CREWAI_ENTERPRISE_URL}/kickoff",
            json=kickoff_payload,
            headers={
                "Authorization": f"Bearer {CREWAI_ENTERPRISE_TOKEN}",
                "Content-Type": "application/json",
            },
            timeout=30,
        )
        resp.raise_for_status()
    except http_requests.RequestException as exc:
        app.logger.error("Kickoff request failed: %s", exc)
        return jsonify({"error": "Failed to start conversation"}), 502

    data = resp.json()
    kickoff_id = data.get("kickoff_id", data.get("id", ""))

    if kickoff_id:
        session = _get_or_create_session(kickoff_id)
        with sessions_lock:
            session["messages"].append({"role": "user", "content": user_content})

    return jsonify({"kickoff_id": kickoff_id, "raw": data})


@app.route("/api/stream/<flow_id>")
def api_stream(flow_id: str):
    """SSE stream that pushes session state whenever it changes."""

    def _snapshot() -> str:
        session = sessions.get(flow_id)
        if session is None:
            return json.dumps(
                {
                    "messages": [],
                    "status": "unknown",
                    "keep_processing": False,
                    "end_of_conversation": False,
                    "pending_feedback": None,
                }
            )
        with sessions_lock:
            return json.dumps(
                {
                    "messages": list(session["messages"]),
                    "status": session["status"],
                    "keep_processing": session["keep_processing"],
                    "end_of_conversation": session["end_of_conversation"],
                    "pending_feedback": session["pending_feedback"],
                }
            )

    def generate():
        q: Queue = Queue()
        with sse_clients_lock:
            sse_clients.setdefault(flow_id, []).append(q)
        try:
            yield f"data: {_snapshot()}\n\n"
            while True:
                try:
                    q.get(timeout=30)
                except Empty:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {_snapshot()}\n\n"
        finally:
            with sse_clients_lock:
                clients = sse_clients.get(flow_id, [])
                if q in clients:
                    clients.remove(q)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/feedback/<flow_id>", methods=["POST"])
def api_feedback(flow_id: str):
    """User submits feedback; Flask forwards it to the callback_url."""
    session = sessions.get(flow_id)
    if not session or not session.get("pending_feedback"):
        return jsonify({"error": "No pending feedback for this session"}), 404

    body = request.get_json(force=True)
    feedback_text = body.get("feedback", "")

    callback_url = session["pending_feedback"]["callback_url"]

    try:
        resp = http_requests.post(
            callback_url,
            json={"feedback": feedback_text, "source": "flight_concierge_ui"},
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        resp.raise_for_status()
    except http_requests.RequestException as exc:
        app.logger.error("Feedback callback failed: %s", exc)
        return jsonify({"error": "Failed to submit feedback"}), 502

    with sessions_lock:
        session["messages"].append({"role": "user", "content": feedback_text})
        session["pending_feedback"] = None
        session["status"] = "processing"
        session["keep_processing"] = True

    return jsonify({"ok": True})


# ──────────────────────────────────────────────
# Webhook routes (called by CrewAI Enterprise)
# ──────────────────────────────────────────────


@app.route("/webhook/messages", methods=["POST"])
def webhook_messages():
    """Receive individual message events from the DispatcherEventBusService."""
    payload = request.get_json(force=True)
    app.logger.info("Message webhook: payload=%.200s", json.dumps(payload, default=str))

    result = payload.get("result") or {}
    message_data = result.get("message") if isinstance(result, dict) else None

    flow_id = (
        payload.get("source_fingerprint")
        or (payload.get("fingerprint_metadata") or {}).get("id", "")
        or payload.get("flow_id", "")
    )

    if not flow_id or not message_data:
        return jsonify({"ok": True, "skipped": True})

    if isinstance(message_data, str):
        role = "assistant"
        content = message_data
    else:
        role = message_data.get("role", "assistant")
        content = message_data.get("content", "")

    if role == "user":
        return jsonify({"ok": True})

    keep_processing = result.get("keep_processing", True)
    end_of_conversation = result.get("end_of_conversation", False)

    session = _get_or_create_session(flow_id)
    with sessions_lock:
        if session["status"] == "waiting_for_feedback":
            app.logger.info(
                "Message webhook: flow=%s skipped (waiting_for_feedback)", flow_id
            )
            return jsonify({"ok": True, "skipped": True})

        session["messages"].append({"role": role, "content": content})
        session["keep_processing"] = keep_processing
        if end_of_conversation:
            session["end_of_conversation"] = True

    _notify_sse_clients(flow_id)
    return jsonify({"ok": True})


@app.route("/webhook/feedback", methods=["POST"])
def webhook_feedback():
    """Receive human feedback requests from CrewAI Enterprise automation."""
    payload = request.get_json(force=True)
    app.logger.info(
        "Feedback webhook: payload=%.200s", json.dumps(payload, default=str)
    )

    flow_id = payload.get("flow_id", "")
    if not flow_id:
        return jsonify({"error": "Missing flow_id"}), 400

    state_messages = payload.get("state", {}).get("messages", [])
    callback_url = payload.get("callback_url", "")
    emit_options = payload.get("emit", [])
    output = payload.get("output", "")
    message = payload.get("message", "")

    session = _get_or_create_session(flow_id)
    with sessions_lock:
        if state_messages:
            session["messages"] = state_messages

        session["status"] = "waiting_for_feedback"
        session["keep_processing"] = False
        session["pending_feedback"] = {
            "emit": emit_options,
            "callback_url": callback_url,
            "message": message,
            "output": output,
        }

    _notify_sse_clients(flow_id)
    return jsonify({"ok": True})


# ──────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────

if __name__ == "__main__":
    app.run(debug=True, port=5001)
