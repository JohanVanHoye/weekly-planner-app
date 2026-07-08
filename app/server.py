"""Week Planner — FastAPI backend with SQLite storage.

Run:  .venv\\Scripts\\python.exe server.py   (serves http://localhost:3366)
"""
import sqlite3
import threading
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "planner.db"

PRIORITIES = {"urgent", "med", "lo", "none"}
DURATIONS = {1, 2, 3, 4}

_lock = threading.Lock()
_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA foreign_keys = ON")
_conn.executescript(
    """
    CREATE TABLE IF NOT EXISTS todos (
      id        TEXT PRIMARY KEY,
      title     TEXT NOT NULL,
      priority  TEXT NOT NULL CHECK(priority IN ('urgent','med','lo','none')),
      duration  INTEGER NOT NULL CHECK(duration IN (1,2,3,4)),
      done      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS placements (
      todo_id   TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      slot_key  TEXT NOT NULL,
      position  INTEGER NOT NULL,
      PRIMARY KEY (todo_id)
    );
    """
)
_conn.commit()

app = FastAPI(title="Week Planner")


# ---------- models ----------

class TodoCreate(BaseModel):
    id: str
    title: str
    priority: str = "med"
    duration: int = 1


class TodoPatch(BaseModel):
    title: Optional[str] = None
    priority: Optional[str] = None
    duration: Optional[int] = None
    done: Optional[bool] = None


class PlacementPatch(BaseModel):
    slot_key: str
    position: int


class ReorderBody(BaseModel):
    slot_key: str
    ordered_ids: list[str]


# ---------- helpers ----------

def _compact(slot_key: str) -> None:
    """Rewrite positions in a slot to gapless 0-based order."""
    rows = _conn.execute(
        "SELECT todo_id FROM placements WHERE slot_key = ? ORDER BY position",
        (slot_key,),
    ).fetchall()
    for i, row in enumerate(rows):
        _conn.execute(
            "UPDATE placements SET position = ? WHERE todo_id = ?", (i, row["todo_id"])
        )


def _validate_todo_fields(priority: Optional[str], duration: Optional[int]) -> None:
    if priority is not None and priority not in PRIORITIES:
        raise HTTPException(400, f"invalid priority: {priority}")
    if duration is not None and duration not in DURATIONS:
        raise HTTPException(400, f"invalid duration: {duration}")


# ---------- todos ----------

@app.get("/api/todos")
def list_todos():
    with _lock:
        rows = _conn.execute(
            """
            SELECT t.id, t.title, t.priority, t.duration, t.done,
                   p.slot_key, p.position
            FROM todos t LEFT JOIN placements p ON p.todo_id = t.id
            ORDER BY p.slot_key, p.position
            """
        ).fetchall()
    return [
        {
            "id": r["id"], "title": r["title"], "priority": r["priority"],
            "duration": r["duration"], "done": bool(r["done"]),
            "slot_key": r["slot_key"], "position": r["position"],
        }
        for r in rows
    ]


@app.post("/api/todos", status_code=201)
def create_todo(body: TodoCreate):
    _validate_todo_fields(body.priority, body.duration)
    with _lock:
        exists = _conn.execute("SELECT 1 FROM todos WHERE id = ?", (body.id,)).fetchone()
        if exists:
            raise HTTPException(409, "id already exists")
        end = _conn.execute(
            "SELECT COUNT(*) AS n FROM placements WHERE slot_key = 'unscheduled'"
        ).fetchone()["n"]
        _conn.execute(
            "INSERT INTO todos (id, title, priority, duration, done) VALUES (?,?,?,?,0)",
            (body.id, body.title, body.priority, body.duration),
        )
        _conn.execute(
            "INSERT INTO placements (todo_id, slot_key, position) VALUES (?, 'unscheduled', ?)",
            (body.id, end),
        )
        _conn.commit()
    return {"ok": True}


@app.patch("/api/todos/{todo_id}")
def patch_todo(todo_id: str, body: TodoPatch):
    _validate_todo_fields(body.priority, body.duration)
    fields, values = [], []
    if body.title is not None:
        fields.append("title = ?"); values.append(body.title)
    if body.priority is not None:
        fields.append("priority = ?"); values.append(body.priority)
    if body.duration is not None:
        fields.append("duration = ?"); values.append(body.duration)
    if body.done is not None:
        fields.append("done = ?"); values.append(1 if body.done else 0)
    if not fields:
        return {"ok": True}
    with _lock:
        cur = _conn.execute(
            f"UPDATE todos SET {', '.join(fields)} WHERE id = ?", (*values, todo_id)
        )
        _conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "todo not found")
    return {"ok": True}


@app.delete("/api/todos/{todo_id}")
def delete_todo(todo_id: str):
    with _lock:
        row = _conn.execute(
            "SELECT slot_key FROM placements WHERE todo_id = ?", (todo_id,)
        ).fetchone()
        cur = _conn.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
        if row:
            _compact(row["slot_key"])
        _conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "todo not found")
    return {"ok": True}


# ---------- placements ----------

@app.patch("/api/placements/{todo_id}")
def move_placement(todo_id: str, body: PlacementPatch):
    with _lock:
        row = _conn.execute(
            "SELECT slot_key FROM placements WHERE todo_id = ?", (todo_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "placement not found")
        old_slot = row["slot_key"]
        _conn.execute("DELETE FROM placements WHERE todo_id = ?", (todo_id,))
        _compact(old_slot)
        # clamp position to end of target slot, shift the rest down
        count = _conn.execute(
            "SELECT COUNT(*) AS n FROM placements WHERE slot_key = ?", (body.slot_key,)
        ).fetchone()["n"]
        pos = max(0, min(body.position, count))
        _conn.execute(
            "UPDATE placements SET position = position + 1 WHERE slot_key = ? AND position >= ?",
            (body.slot_key, pos),
        )
        _conn.execute(
            "INSERT INTO placements (todo_id, slot_key, position) VALUES (?,?,?)",
            (todo_id, body.slot_key, pos),
        )
        _conn.commit()
    return {"ok": True}


@app.post("/api/placements/reorder")
def reorder(body: ReorderBody):
    with _lock:
        current = {
            r["todo_id"]
            for r in _conn.execute(
                "SELECT todo_id FROM placements WHERE slot_key = ?", (body.slot_key,)
            ).fetchall()
        }
        if current != set(body.ordered_ids):
            raise HTTPException(400, "ordered_ids must match the slot's current members")
        for i, tid in enumerate(body.ordered_ids):
            _conn.execute(
                "UPDATE placements SET position = ? WHERE todo_id = ?", (i, tid)
            )
        _conn.commit()
    return {"ok": True}


# ---------- import / export ----------

@app.get("/api/export")
def export_data():
    with _lock:
        todos = [
            {
                "id": r["id"], "title": r["title"], "priority": r["priority"],
                "duration": r["duration"], "done": bool(r["done"]),
            }
            for r in _conn.execute("SELECT * FROM todos").fetchall()
        ]
        slots: dict[str, list[str]] = {}
        for r in _conn.execute(
            "SELECT todo_id, slot_key FROM placements ORDER BY slot_key, position"
        ).fetchall():
            slots.setdefault(r["slot_key"], []).append(r["todo_id"])
    return {"todos": todos, "slots": slots}


@app.post("/api/import")
def import_data(data: dict):
    todos = data.get("todos")
    if not isinstance(todos, list):
        raise HTTPException(400, "missing 'todos' array")
    slots = dict(data.get("slots") or {})
    # tolerate a top-level "unscheduled" list (older export variant)
    if "unscheduled" in data and "unscheduled" not in slots:
        slots["unscheduled"] = data["unscheduled"]

    todo_ids = set()
    for t in todos:
        if not isinstance(t, dict) or not t.get("id") or not t.get("title"):
            raise HTTPException(400, "each todo needs id and title")
        if t.get("priority", "none") not in PRIORITIES:
            raise HTTPException(400, f"invalid priority in todo {t['id']}")
        if t.get("duration", 1) not in DURATIONS:
            raise HTTPException(400, f"invalid duration in todo {t['id']}")
        todo_ids.add(t["id"])

    seen = set()
    for key, ids in slots.items():
        for tid in ids:
            if tid not in todo_ids:
                raise HTTPException(400, f"slot '{key}' references unknown todo '{tid}'")
            if tid in seen:
                raise HTTPException(400, f"todo '{tid}' appears in more than one slot")
            seen.add(tid)

    with _lock:
        try:
            _conn.execute("BEGIN")
            _conn.execute("DELETE FROM placements")
            _conn.execute("DELETE FROM todos")
            for t in todos:
                _conn.execute(
                    "INSERT INTO todos (id, title, priority, duration, done) VALUES (?,?,?,?,?)",
                    (
                        t["id"], t["title"], t.get("priority", "none"),
                        t.get("duration", 1), 1 if t.get("done") else 0,
                    ),
                )
            for key, ids in slots.items():
                for i, tid in enumerate(ids):
                    _conn.execute(
                        "INSERT INTO placements (todo_id, slot_key, position) VALUES (?,?,?)",
                        (tid, key, i),
                    )
            # todos not referenced by any slot land at the end of unscheduled
            end = _conn.execute(
                "SELECT COUNT(*) AS n FROM placements WHERE slot_key = 'unscheduled'"
            ).fetchone()["n"]
            for tid in sorted(todo_ids - seen):
                _conn.execute(
                    "INSERT INTO placements (todo_id, slot_key, position) VALUES (?, 'unscheduled', ?)",
                    (tid, end),
                )
                end += 1
            _conn.commit()
        except Exception:
            _conn.rollback()
            raise
    return {"ok": True}


# ---------- static frontend ----------

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=3366)
