import React, { useState, useCallback, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Plus, ChevronLeft, ChevronRight, Trash2, GripVertical, ArrowDownUp,
  Printer, CheckSquare2, Square, Download, Upload, Search, X, Undo2, Redo2,
} from "lucide-react";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PERIODS = ["AM", "PM", "Evening"];

const PRIORITY_COLORS = {
  urgent: "#D63B2B",
  med: "#D97706",
  lo: "#2563EB",
  none: "#A8A49E",
};

const PRIORITY_LABELS = {
  urgent: "Urgent",
  med: "Med",
  lo: "Lo",
  none: "None",
};

const PRIORITY_ORDER = ["urgent", "med", "lo", "none"];

const PERIOD_CAPACITY = { AM: 3, PM: 5, Evening: 4 };

// ---------- API ----------

const api = {
  async load() {
    const res = await fetch("/api/export");
    if (!res.ok) throw new Error("failed to load");
    return res.json();
  },
  createTodo(todo) {
    return fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(todo),
    });
  },
  patchTodo(id, patch) {
    return fetch(`/api/todos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  },
  deleteTodo(id) {
    return fetch(`/api/todos/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  movePlacement(id, slot_key, position) {
    return fetch(`/api/placements/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot_key, position }),
    });
  },
  reorder(slot_key, ordered_ids) {
    return fetch("/api/placements/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot_key, ordered_ids }),
    });
  },
  import(data) {
    return fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  },
};

// zone format: "YYYY-M-D-Period"
function isZoneOverdue(zone) {
  const parts = zone.split("-");
  if (parts.length < 4) return false;
  const [year, month, day, period] = parts;
  const slotDate = new Date(+year, +month - 1, +day);
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (slotDate < todayMidnight) return true;
  if (slotDate.getTime() === todayMidnight.getTime()) {
    const h = now.getHours();
    if (period === "AM" && h >= 12) return true;
    if (period === "PM" && h >= 18) return true;
  }
  return false;
}

function dateKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function slotKey(date, period) {
  return `${dateKey(date)}-${period}`;
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function getWeekDates(weekOffset) {
  const base = new Date();
  const dow = base.getDay();
  const monday = new Date(base);
  monday.setDate(base.getDate() - (dow === 0 ? 6 : dow - 1) + weekOffset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

export default function App() {
  const [todos, setTodos] = useState([]);
  const [slots, setSlots] = useState({});
  const [unscheduled, setUnscheduled] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [dragging, setDragging] = useState(null);
  const [overZone, setOverZone] = useState(null);
  const [dropInsertIndex, setDropInsertIndex] = useState(null);
  const [isDuplicating, setIsDuplicating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [newTitle, setNewTitle] = useState("");
  const [newPriority, setNewPriority] = useState("med");
  const [newDuration, setNewDuration] = useState(1);
  const [showAdd, setShowAdd] = useState(false);
  const [query, setQuery] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const w = parseInt(localStorage.getItem("wp_sidebar_width") || "", 10);
    return Number.isFinite(w) ? Math.min(Math.max(w, 200), 640) : 240;
  });

  const startSidebarResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev) => {
      const w = Math.min(Math.max(startWidth + ev.clientX - startX, 200), 640);
      setSidebarWidth(w);
      localStorage.setItem("wp_sidebar_width", String(w));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const applyServerData = (data) => {
    const { unscheduled: uns = [], ...rest } = data.slots || {};
    setTodos(data.todos || []);
    setSlots(rest);
    setUnscheduled(uns);
  };

  useEffect(() => {
    api.load().then((data) => {
      applyServerData(data);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const weekDates = getWeekDates(weekOffset);
  const nextWeekDates = getWeekDates(weekOffset + 1);
  const today = new Date();
  const weekNumber = getISOWeek(weekDates[0]);

  // ---------- undo / redo ----------
  // Each history entry holds two ops: { undo, redo }. Ops are plain data,
  // executed by applyOp with the same optimistic-update-then-API pattern
  // as the direct mutations.
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const [, setHistVersion] = useState(0);

  // Move a todo to a slot at a position in local state only.
  const applyLocalMove = (id, slot, pos) => {
    setUnscheduled((u) => {
      const f = u.filter((x) => x !== id);
      if (slot === "unscheduled") f.splice(Math.min(pos, f.length), 0, id);
      return f;
    });
    setSlots((s) => {
      const next = {};
      for (const k in s) next[k] = s[k].filter((x) => x !== id);
      if (slot !== "unscheduled") {
        const arr = [...(next[slot] || [])];
        arr.splice(Math.min(pos, arr.length), 0, id);
        next[slot] = arr;
      }
      return next;
    });
  };

  const applyOp = async (op) => {
    switch (op.type) {
      case "patch":
        setTodos((ts) => ts.map((t) => (t.id === op.id ? { ...t, ...op.fields } : t)));
        api.patchTodo(op.id, op.fields);
        break;
      case "create": {
        const { todo, slot_key, position } = op;
        setTodos((ts) => [...ts.filter((t) => t.id !== todo.id), { ...todo }]);
        applyLocalMove(todo.id, slot_key, position);
        await api.createTodo({ id: todo.id, title: todo.title, priority: todo.priority, duration: todo.duration });
        if (todo.done) await api.patchTodo(todo.id, { done: true });
        api.movePlacement(todo.id, slot_key, position);
        break;
      }
      case "delete":
        setTodos((ts) => ts.filter((t) => t.id !== op.id));
        setUnscheduled((u) => u.filter((id) => id !== op.id));
        setSlots((s) => {
          const next = {};
          for (const k in s) next[k] = s[k].filter((id) => id !== op.id);
          return next;
        });
        api.deleteTodo(op.id);
        break;
      case "move":
        applyLocalMove(op.id, op.slot_key, op.position);
        api.movePlacement(op.id, op.slot_key, op.position);
        break;
      case "reorder":
        if (op.slot_key === "unscheduled") setUnscheduled([...op.ordered_ids]);
        else setSlots((s) => ({ ...s, [op.slot_key]: [...op.ordered_ids] }));
        api.reorder(op.slot_key, op.ordered_ids);
        break;
      case "import":
        await api.import(op.data);
        applyServerData(await api.load());
        break;
    }
  };

  const pushUndo = (entry) => {
    undoRef.current.push(entry);
    if (undoRef.current.length > 50) undoRef.current.shift();
    redoRef.current = [];
    setHistVersion((v) => v + 1);
  };

  const doUndo = () => {
    const entry = undoRef.current.pop();
    if (!entry) return;
    redoRef.current.push(entry);
    applyOp(entry.undo);
    setHistVersion((v) => v + 1);
  };

  const doRedo = () => {
    const entry = redoRef.current.pop();
    if (!entry) return;
    undoRef.current.push(entry);
    applyOp(entry.redo);
    setHistVersion((v) => v + 1);
  };

  const doUndoRef = useRef();
  const doRedoRef = useRef();
  doUndoRef.current = doUndo;
  doRedoRef.current = doRedo;

  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        doUndoRef.current();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        doRedoRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const updateTodo = (id, patch) => {
    const prev = todos.find((t) => t.id === id);
    if (prev) {
      const before = {};
      for (const k of Object.keys(patch)) before[k] = k === "done" ? !!prev[k] : prev[k];
      pushUndo({ undo: { type: "patch", id, fields: before }, redo: { type: "patch", id, fields: patch } });
    }
    setTodos((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    api.patchTodo(id, patch);
  };

  const toggleDone = (id) => {
    const todo = todos.find((t) => t.id === id);
    if (!todo) return;
    pushUndo({
      undo: { type: "patch", id, fields: { done: !!todo.done } },
      redo: { type: "patch", id, fields: { done: !todo.done } },
    });
    setTodos((ts) => ts.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
    api.patchTodo(id, { done: !todo.done });
  };

  const removeTodoFromSource = useCallback((todoId, from) => {
    if (from === "unscheduled") {
      setUnscheduled((u) => u.filter((id) => id !== todoId));
    } else {
      setSlots((s) => ({ ...s, [from]: (s[from] || []).filter((id) => id !== todoId) }));
    }
  }, []);

  const handleDragStart = (todoId, from) => {
    setDragging({ todoId, from });
  };

  const handleDragEnd = () => {
    setDragging(null);
    setOverZone(null);
    setDropInsertIndex(null);
    setIsDuplicating(false);
  };

  // For grid cells and the sidebar background (fallback)
  const handleZoneDragOver = (e, zone) => {
    e.preventDefault();
    e.stopPropagation();
    const copy = e.ctrlKey && zone !== "unscheduled";
    e.dataTransfer.dropEffect = copy ? "copy" : "move";
    setIsDuplicating(copy);
    setOverZone(zone);
    if (zone !== "unscheduled") setDropInsertIndex(null);
  };

  // For individual sidebar cards — sets insertion index
  const handleSidebarCardDragOver = (e, cardIndex) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDuplicating(false);
    setOverZone("unscheduled");
    const rect = e.currentTarget.getBoundingClientRect();
    const isTopHalf = e.clientY < rect.top + rect.height / 2;
    setDropInsertIndex(isTopHalf ? cardIndex : cardIndex + 1);
  };

  const handleStripDragOver = (e, date) => {
    e.preventDefault();
    const copy = e.ctrlKey;
    e.dataTransfer.dropEffect = copy ? "copy" : "move";
    setIsDuplicating(copy);
    setOverZone(`strip-${dateKey(date)}`);
    setDropInsertIndex(null);
  };

  const handleStripDrop = (e, date) => {
    e.preventDefault();
    if (!dragging) return;
    // place into first period that has no tasks; fall back to AM
    const targetPeriod = PERIODS.find((p) => !(slots[slotKey(date, p)] || []).length) ?? PERIODS[0];
    handleDrop(e, slotKey(date, targetPeriod));
  };

  const handleDragLeave = (e) => {
    // only clear if leaving to outside the zone entirely
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setOverZone(null);
      setDropInsertIndex(null);
    }
  };

  const handleDrop = (e, zone) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragging) return;
    const { todoId, from } = dragging;

    const copy = isDuplicating && zone !== "unscheduled";
    const fromIndex =
      from === "unscheduled" ? unscheduled.indexOf(todoId) : (slots[from] || []).indexOf(todoId);

    if (!copy) removeTodoFromSource(todoId, from);

    const targetId = copy ? `t-${Date.now()}` : todoId;
    if (copy) {
      const src = todoMap[todoId];
      if (src) {
        const position = (slots[zone] || []).length;
        pushUndo({
          undo: { type: "delete", id: targetId },
          redo: {
            type: "create",
            todo: { id: targetId, title: src.title, priority: src.priority, duration: src.duration },
            slot_key: zone,
            position,
          },
        });
        setTodos((ts) => [...ts, { ...src, id: targetId, done: false }]);
        api.createTodo({ id: targetId, title: src.title, priority: src.priority, duration: src.duration })
          .then(() => {
            api.movePlacement(targetId, zone, position);
          });
      }
    }

    if (zone === "unscheduled") {
      const filtered = unscheduled.filter((id) => id !== todoId);
      const insertAt =
        dropInsertIndex !== null
          ? Math.min(dropInsertIndex, filtered.length)
          : filtered.length;
      const next = [...filtered];
      next.splice(insertAt, 0, targetId);
      setUnscheduled(next);
      if (!copy) {
        if (!(from === zone && fromIndex === insertAt)) {
          pushUndo({
            undo: { type: "move", id: todoId, slot_key: from, position: fromIndex },
            redo: { type: "move", id: todoId, slot_key: zone, position: insertAt },
          });
        }
        api.movePlacement(targetId, "unscheduled", insertAt);
      }
    } else {
      const position = (slots[zone] || []).filter((id) => id !== todoId).length;
      setSlots((s) => ({ ...s, [zone]: [...(s[zone] || []).filter((id) => id !== todoId), targetId] }));
      if (!copy) {
        if (!(from === zone && fromIndex === position)) {
          pushUndo({
            undo: { type: "move", id: todoId, slot_key: from, position: fromIndex },
            redo: { type: "move", id: todoId, slot_key: zone, position },
          });
        }
        api.movePlacement(targetId, zone, position);
      }
    }

    setDragging(null);
    setOverZone(null);
    setDropInsertIndex(null);
  };

  const addTodo = () => {
    if (!newTitle.trim()) return;
    const id = `t-${Date.now()}`;
    const todo = { id, title: newTitle.trim(), priority: newPriority, duration: newDuration };
    pushUndo({
      undo: { type: "delete", id },
      redo: { type: "create", todo: { ...todo }, slot_key: "unscheduled", position: unscheduled.length },
    });
    setTodos((t) => [...t, todo]);
    setUnscheduled((u) => [...u, id]);
    api.createTodo(todo);
    setNewTitle("");
    setNewPriority("med");
    setNewDuration(1);
    setShowAdd(false);
  };

  const deleteTodo = (todoId) => {
    const todo = todoMap[todoId];
    if (todo) {
      let slot = "unscheduled";
      let pos = unscheduled.indexOf(todoId);
      if (pos === -1) {
        for (const [k, ids] of Object.entries(slots)) {
          const i = ids.indexOf(todoId);
          if (i !== -1) { slot = k; pos = i; break; }
        }
      }
      pushUndo({
        undo: { type: "create", todo: { ...todo }, slot_key: slot, position: Math.max(pos, 0) },
        redo: { type: "delete", id: todoId },
      });
    }
    setTodos((t) => t.filter((x) => x.id !== todoId));
    setUnscheduled((u) => u.filter((id) => id !== todoId));
    setSlots((s) => {
      const next = { ...s };
      for (const k in next) next[k] = next[k].filter((id) => id !== todoId);
      return next;
    });
    api.deleteTodo(todoId);
  };

  const exportData = async () => {
    const data = await api.load();
    const payload = JSON.stringify(data, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `week-planner-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importData = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target?.result);
          const snapshot = await api.load();
          const res = await api.import(data);
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(`Import failed: ${err.detail || res.statusText}`);
            return;
          }
          const imported = await api.load();
          pushUndo({
            undo: { type: "import", data: snapshot },
            redo: { type: "import", data: imported },
          });
          applyServerData(imported);
        } catch {
          alert("Invalid backup file.");
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const sortByPriority = () => {
    const withPriority = unscheduled.map((id) => ({
      id,
      p: PRIORITY_ORDER.indexOf(todoMap[id]?.priority ?? "none"),
    }));
    withPriority.sort((a, b) => a.p - b.p);
    const ordered = withPriority.map((x) => x.id);
    if (ordered.join(" ") === unscheduled.join(" ")) return;
    pushUndo({
      undo: { type: "reorder", slot_key: "unscheduled", ordered_ids: [...unscheduled] },
      redo: { type: "reorder", slot_key: "unscheduled", ordered_ids: ordered },
    });
    setUnscheduled(ordered);
    api.reorder("unscheduled", ordered);
  };

  const todoMap = Object.fromEntries(todos.map((t) => [t.id, t]));

  // ---------- type-to-find ----------
  const q = query.trim().toLowerCase();
  const isMatch = (todo) => q !== "" && todo.title.toLowerCase().includes(q);
  const searchActive = q !== "";
  let matchCount = 0;
  let matchesElsewhere = 0;
  if (searchActive) {
    const visibleZones = new Set(
      weekDates.flatMap((d) => PERIODS.map((p) => slotKey(d, p)))
    );
    const matchIds = new Set(todos.filter(isMatch).map((t) => t.id));
    matchCount = matchIds.size;
    for (const [zone, ids] of Object.entries(slots)) {
      if (visibleZones.has(zone)) continue;
      for (const id of ids) if (matchIds.has(id)) matchesElsewhere++;
    }
  }

  const formatRange = () => {
    const start = weekDates[0].toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const end = weekDates[6].toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${start} – ${end}`;
  };

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground text-sm" style={{ fontFamily: "var(--font-mono)" }}>
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden" style={{ fontFamily: "var(--font-sans)" }}>
      {/* Sidebar */}
      <aside
        className={`flex-shrink-0 border-r border-border flex flex-col transition-colors duration-150 ${
          overZone === "unscheduled" ? "bg-primary/5" : "bg-card"
        }`}
        style={{ width: sidebarWidth }}
        onDragOver={(e) => handleZoneDragOver(e, "unscheduled")}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, "unscheduled")}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-border flex-shrink-0">
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2" style={{ fontFamily: "var(--font-mono)" }}>
            Week Planner
          </p>
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-semibold leading-tight" style={{ fontFamily: "var(--font-display)" }}>
              Unscheduled
            </h1>
            <button
              onClick={sortByPriority}
              title="Sort by priority"
              className="no-print w-7 h-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowDownUp size={13} />
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5" style={{ fontFamily: "var(--font-mono)" }}>
            {unscheduled.length} task{unscheduled.length !== 1 ? "s" : ""}
          </p>
        </div>

        {/* Unscheduled list */}
        <div className="flex-1 overflow-y-auto px-3 py-3 print-unclip">
          {unscheduled.map((id, index) => {
            const todo = todoMap[id];
            if (!todo) return null;
            const showLine = overZone === "unscheduled" && dropInsertIndex === index;
            return (
              <div key={id}>
                {showLine && <InsertLine />}
                <div className="mb-1.5">
                  <TodoCard
                    todo={todo}
                    searchDim={searchActive && !isMatch(todo)}
                    searchHit={searchActive && isMatch(todo)}
                    isDragging={dragging?.todoId === id}
                    isEditing={editingId === id}
                    onDragStart={() => handleDragStart(id, "unscheduled")}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => handleSidebarCardDragOver(e, index)}
                    onDelete={() => deleteTodo(id)}
                    onDoubleClick={() => setEditingId(id)}
                    onEditCommit={(patch) => { updateTodo(id, patch); setEditingId(null); }}
                    onEditCancel={() => setEditingId(null)}
                    onToggleDone={() => toggleDone(id)}
                  />
                </div>
              </div>
            );
          })}
          {overZone === "unscheduled" && dropInsertIndex === unscheduled.length && <InsertLine />}
          {unscheduled.length === 0 && (
            <p className="text-xs text-muted-foreground text-center pt-10 italic">All tasks scheduled ✓</p>
          )}
        </div>

        {/* Add task */}
        <div className="no-print px-3 py-3 border-t border-border flex-shrink-0">
          {showAdd ? (
            <div className="space-y-2">
              <input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTodo();
                  if (e.key === "Escape") setShowAdd(false);
                }}
                placeholder="Task name..."
                className="w-full text-sm px-3 py-2 rounded-md border border-border bg-input-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
              />
              <div className="flex gap-1">
                {PRIORITY_ORDER.map((p) => (
                  <button
                    key={p}
                    onClick={() => setNewPriority(p)}
                    className="flex-1 text-[10px] py-0.5 rounded border transition-all font-semibold"
                    style={
                      newPriority === p
                        ? { backgroundColor: PRIORITY_COLORS[p], color: "#fff", borderColor: "transparent" }
                        : { borderColor: "rgba(22,22,18,0.15)", color: "#6E6C62" }
                    }
                  >
                    {PRIORITY_LABELS[p]}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                {[1, 2, 3, 4].map((d) => (
                  <button
                    key={d}
                    onClick={() => setNewDuration(d)}
                    className="flex-1 text-[10px] py-0.5 rounded border transition-all font-medium"
                    style={
                      newDuration === d
                        ? { backgroundColor: "#161612", color: "#fff", borderColor: "transparent" }
                        : { borderColor: "rgba(22,22,18,0.15)", color: "#6E6C62", fontFamily: "var(--font-mono)" }
                    }
                  >
                    {d}h
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5">
                <button onClick={addTodo} className="flex-1 text-xs bg-primary text-primary-foreground rounded-md py-1.5 font-semibold hover:opacity-90 transition-opacity">
                  Add
                </button>
                <button onClick={() => setShowAdd(false)} className="text-xs px-3 rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAdd(true)}
              className="w-full flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors py-1 group"
            >
              <Plus size={14} className="group-hover:text-primary transition-colors" />
              Add task
            </button>
          )}
        </div>
      </aside>

      {/* Sidebar / week-view splitter */}
      <div
        className="no-print flex-shrink-0 w-1.5 -ml-1 cursor-col-resize group relative z-10"
        onMouseDown={startSidebarResize}
        onDoubleClick={() => {
          setSidebarWidth(240);
          localStorage.setItem("wp_sidebar_width", "240");
        }}
        title="Drag to resize · Double-click to reset"
      >
        <div className="absolute inset-y-0 left-0.5 w-px bg-transparent group-hover:bg-primary group-active:bg-primary transition-colors" />
      </div>

      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        <header className="flex items-center gap-4 px-5 py-3.5 border-b border-border bg-card flex-shrink-0">
          <div className="no-print flex items-center gap-1">
            <button onClick={() => setWeekOffset((o) => o - 1)} className="w-7 h-7 flex items-center justify-center rounded hover:bg-muted transition-colors">
              <ChevronLeft size={15} />
            </button>
            <button
              onClick={() => setWeekOffset(0)}
              className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              Today
            </button>
            <button onClick={() => setWeekOffset((o) => o + 1)} className="w-7 h-7 flex items-center justify-center rounded hover:bg-muted transition-colors">
              <ChevronRight size={15} />
            </button>
          </div>
          <span className="text-sm text-muted-foreground flex-1 flex items-center gap-2" style={{ fontFamily: "var(--font-mono)" }}>
            {formatRange()}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wider">W{weekNumber}</span>
          </span>
          <div className="no-print flex items-center gap-2">
            <div
              className={`flex items-center gap-1.5 border rounded px-2 py-1.5 bg-input-background/60 transition-all ${
                searchActive ? "border-ring/50 ring-1 ring-ring/30" : "border-border"
              }`}
            >
              <Search size={13} className="text-muted-foreground flex-shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
                placeholder="Find task..."
                className="w-36 bg-transparent text-xs focus:outline-none placeholder:text-muted-foreground"
              />
              {searchActive && (
                <button onClick={() => setQuery("")} title="Clear (Esc)" className="text-muted-foreground hover:text-foreground transition-colors">
                  <X size={12} />
                </button>
              )}
            </div>
            {searchActive && (
              <span
                className={`text-[10px] whitespace-nowrap ${matchCount === 0 ? "text-primary" : "text-muted-foreground"}`}
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {matchCount === 0
                  ? "no matches"
                  : `${matchCount} match${matchCount !== 1 ? "es" : ""}${matchesElsewhere > 0 ? ` · ${matchesElsewhere} other week${matchesElsewhere !== 1 ? "s" : ""}` : ""}`}
              </span>
            )}
          </div>
          <button
            onClick={doUndo}
            disabled={undoRef.current.length === 0}
            title="Undo (Ctrl+Z)"
            className="no-print flex items-center justify-center text-muted-foreground hover:text-foreground border border-border rounded px-2 py-1.5 hover:bg-muted transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            <Undo2 size={13} />
          </button>
          <button
            onClick={doRedo}
            disabled={redoRef.current.length === 0}
            title="Redo (Ctrl+Shift+Z / Ctrl+Y)"
            className="no-print flex items-center justify-center text-muted-foreground hover:text-foreground border border-border rounded px-2 py-1.5 hover:bg-muted transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            <Redo2 size={13} />
          </button>
          <button
            onClick={importData}
            className="no-print flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2.5 py-1.5 hover:bg-muted transition-colors"
            title="Import backup JSON"
          >
            <Upload size={13} />
            Import
          </button>
          <button
            onClick={exportData}
            className="no-print flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2.5 py-1.5 hover:bg-muted transition-colors"
            title="Export backup JSON"
          >
            <Download size={13} />
            Export
          </button>
          <button
            onClick={() => {
              const prev = document.title;
              document.title = `Plan Week ${weekNumber}.pdf`;
              window.addEventListener("afterprint", () => { document.title = prev; }, { once: true });
              window.print();
            }}
            className="no-print flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2.5 py-1.5 hover:bg-muted transition-colors"
            title="Save or print as PDF"
          >
            <Printer size={13} />
            PDF
          </button>
        </header>

        <div className="flex-1 flex overflow-hidden min-h-0 print-unclip">
        <div
          className={`flex-1 overflow-auto print-unclip transition-colors duration-150 ${
            dragging && overZone === "unscheduled" ? "bg-primary/5" : ""
          }`}
          onDragOver={(e) => handleZoneDragOver(e, "unscheduled")}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, "unscheduled")}
        >
          <div
            className="grid print-grid"
            style={{
              gridTemplateColumns: "44px repeat(7, minmax(0, 1fr))",
              gridTemplateRows: "48px repeat(3, minmax(140px, auto))",
              minWidth: 680,
            }}
          >
            <div className="border-b border-r border-border bg-card" />

            {weekDates.map((date, i) => {
              const isToday = date.toDateString() === today.toDateString();
              return (
                <div key={i} className={`border-b border-r border-border flex flex-col items-center justify-center gap-0.5 ${isToday ? "bg-primary" : "bg-card"}`}>
                  <span className={`text-[10px] uppercase tracking-[0.14em] ${isToday ? "text-primary-foreground/70" : "text-muted-foreground"}`} style={{ fontFamily: "var(--font-mono)" }}>
                    {DAYS[i]}
                  </span>
                  <span className={`text-base font-semibold leading-none ${isToday ? "text-primary-foreground" : "text-foreground"}`} style={{ fontFamily: "var(--font-display)" }}>
                    {date.getDate()}
                  </span>
                </div>
              );
            })}

            {PERIODS.map((period) => (
              <React.Fragment key={period}>
                <div key={`label-${period}`} className="border-b border-r border-border bg-card flex items-center justify-center">
                  <span
                    className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
                    style={{ fontFamily: "var(--font-mono)", writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                  >
                    {period}
                  </span>
                </div>

                {DAYS.map((day, di) => {
                  const zone = slotKey(weekDates[di], period);
                  const cellIds = slots[zone] || [];
                  const isOver = overZone === zone;
                  const capacity = PERIOD_CAPACITY[period] ?? Infinity;
                  let runningHours = 0;
                  return (
                    <div
                      key={zone}
                      className={`border-b border-r border-border p-1.5 transition-colors duration-100 ${isOver ? "bg-primary/8 ring-1 ring-inset ring-primary/20" : "hover:bg-muted/40"}`}
                      onDragOver={(e) => handleZoneDragOver(e, zone)}
                      onDragLeave={handleDragLeave}
                      onDrop={(e) => handleDrop(e, zone)}
                    >
                      <div className="space-y-1">
                        {cellIds.map((id) => {
                          const todo = todoMap[id];
                          if (!todo) return null;
                          if (!todo.done) runningHours += todo.duration;
                          const isOverCapacity = !todo.done && runningHours > capacity;
                          return (
                            <TodoCard
                              key={id}
                              todo={todo}
                              compact
                              searchDim={searchActive && !isMatch(todo)}
                              searchHit={searchActive && isMatch(todo)}
                              isDragging={dragging?.todoId === id}
                              showCopyBadge={isDuplicating && dragging?.todoId === id}
                              isEditing={editingId === id}
                              isOverdue={!todo.done && isZoneOverdue(zone)}
                              isOverCapacity={isOverCapacity}
                              onDragStart={() => handleDragStart(id, zone)}
                              onDragEnd={handleDragEnd}
                              onDelete={() => deleteTodo(id)}
                              onDoubleClick={() => setEditingId(id)}
                              onEditCommit={(patch) => { updateTodo(id, patch); setEditingId(null); }}
                              onEditCancel={() => setEditingId(null)}
                              onToggleDone={() => toggleDone(id)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>

          {/* Next-week drop strip — visible only while dragging */}
          <div className="no-print contents">
          <NextWeekStrip
            dates={nextWeekDates}
            slots={slots}
            overZone={overZone}
            visible={!!dragging}
            isDuplicating={isDuplicating}
            onDragOver={handleStripDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleStripDrop}
          />
          </div>
        </div>
      </main>
    </div>
  );
}

function NextWeekStrip({ dates, slots, overZone, visible, isDuplicating, onDragOver, onDragLeave, onDrop }) {
  const dayAbbrevs = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div
      className="flex-shrink-0 border-l border-border flex flex-col bg-card overflow-hidden transition-all duration-200"
      style={{ width: visible ? 52 : 0, opacity: visible ? 1 : 0 }}
    >
      {/* Strip header */}
      <div
        className="flex items-center justify-center border-b border-border bg-muted/60 flex-shrink-0"
        style={{ height: 48, fontFamily: "var(--font-mono)" }}
      >
        <span className="text-[9px] uppercase tracking-widest text-muted-foreground" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
          Nxt wk
        </span>
      </div>

      {/* Day cells */}
      {dates.map((date, i) => {
        const zoneKey = `strip-${dateKey(date)}`;
        const isOver = overZone === zoneKey;
        // show which period it will land in
        const targetPeriod = PERIODS.find((p) => !(slots[slotKey(date, p)] || []).length) ?? PERIODS[0];
        return (
          <div
            key={i}
            className={`flex-1 border-b border-border flex flex-col items-center justify-center gap-0.5 transition-colors duration-100 cursor-crosshair ${
              isOver
                ? isDuplicating
                  ? "bg-primary/15 ring-1 ring-inset ring-primary/30"
                  : "bg-primary/10 ring-1 ring-inset ring-primary/20"
                : "hover:bg-muted/50"
            }`}
            onDragOver={(e) => onDragOver(e, date)}
            onDragLeave={onDragLeave}
            onDrop={(e) => onDrop(e, date)}
          >
            <span
              className="text-[9px] uppercase tracking-wider text-muted-foreground leading-none"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {dayAbbrevs[i]}
            </span>
            <span className="text-xs font-semibold leading-none text-foreground" style={{ fontFamily: "var(--font-display)" }}>
              {date.getDate()}
            </span>
            {isOver && (
              <span
                className="text-[8px] text-primary font-medium mt-0.5 leading-none"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {targetPeriod}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function InsertLine() {
  return (
    <div className="flex items-center gap-1 my-1 px-0.5">
      <div className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
      <div className="flex-1 h-px bg-primary" />
    </div>
  );
}

function TodoCard({
  todo,
  compact,
  searchDim,
  searchHit,
  isDragging,
  showCopyBadge,
  isEditing,
  isOverdue,
  isOverCapacity,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDelete,
  onDoubleClick,
  onEditCommit,
  onEditCancel,
  onToggleDone,
}) {
  const statusColor = todo.done ? "#16A34A" : isOverdue ? "#DC2626" : null;
  const color = statusColor ?? PRIORITY_COLORS[todo.priority];
  const [draft, setDraft] = useState(todo.title);
  const [draftPriority, setDraftPriority] = useState(todo.priority);
  const [draftDuration, setDraftDuration] = useState(todo.duration);

  const commit = () => {
    if (draft.trim()) onEditCommit({ title: draft.trim(), priority: draftPriority, duration: draftDuration });
    else onEditCancel();
  };

  // Card height in grid reflects duration: 44px per hour
  const gridMinHeight = todo.duration * 44;

  if (isEditing) {
    return (
      <div
        className={`rounded bg-card border border-ring/40 shadow-sm ${compact ? "px-1.5 py-1.5" : "px-2.5 py-2.5"}`}
        style={{ borderLeftWidth: 2.5, borderLeftColor: color }}
        onDragStart={(e) => e.preventDefault()}
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") onEditCancel();
          }}
          onBlur={commit}
          className="w-full bg-transparent text-sm font-medium focus:outline-none leading-snug mb-2"
        />
        {/* Priority row */}
        <div className="flex gap-1 mb-1.5">
          {PRIORITY_ORDER.map((p) => (
            <button
              key={p}
              onMouseDown={(e) => { e.preventDefault(); setDraftPriority(p); }}
              className="flex-1 text-[10px] py-0.5 rounded border transition-all font-semibold"
              style={
                draftPriority === p
                  ? { backgroundColor: PRIORITY_COLORS[p], color: "#fff", borderColor: "transparent" }
                  : { borderColor: "rgba(22,22,18,0.15)", color: "#6E6C62" }
              }
            >
              {PRIORITY_LABELS[p]}
            </button>
          ))}
        </div>
        {/* Duration row */}
        <div className="flex gap-1">
          {[1, 2, 3, 4].map((d) => (
            <button
              key={d}
              onMouseDown={(e) => { e.preventDefault(); setDraftDuration(d); }}
              className="flex-1 text-[10px] py-0.5 rounded border transition-all font-medium"
              style={
                draftDuration === d
                  ? { backgroundColor: "#161612", color: "#fff", borderColor: "transparent", fontFamily: "var(--font-mono)" }
                  : { borderColor: "rgba(22,22,18,0.15)", color: "#6E6C62", fontFamily: "var(--font-mono)" }
              }
            >
              {d}h
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick(); }}
      className={`group relative flex gap-1.5 rounded border cursor-grab active:cursor-grabbing select-none transition-all duration-100 ${
        isDragging ? "opacity-30 scale-95" : "hover:shadow-sm"
      } ${compact ? "px-1.5 py-1.5" : "px-2.5 py-2.5"} ${searchDim ? "opacity-20" : ""}`}
      title="Double-click to edit · Ctrl+drag to duplicate"
      style={{
        borderLeftWidth: 2.5,
        borderLeftColor: color,
        backgroundColor: todo.done ? "#f0fdf4" : isOverdue ? "#fff8f8" : "#FFFFFF",
        borderColor: todo.done ? "#bbf7d0" : isOverdue ? "#fecaca" : undefined,
        ...(searchHit ? { boxShadow: "0 0 0 1.5px #D63B2B" } : {}),
        ...(compact ? { minHeight: `${gridMinHeight}px` } : {}),
      }}
    >
      {showCopyBadge && (
        <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center z-10 shadow">
          +
        </span>
      )}
      <GripVertical
        size={11}
        className="no-print text-muted-foreground/40 flex-shrink-0 mt-0.5 group-hover:text-muted-foreground/70 transition-colors"
      />
      <div className="flex-1 min-w-0 flex flex-col justify-between gap-1">
        <p className={`font-medium leading-snug ${compact ? "text-[11px]" : "text-sm"} ${todo.done ? "line-through opacity-50" : ""}`}>
          {todo.title}
        </p>
        <div className="flex items-center gap-1.5">
          {isOverCapacity && (
            <span className="text-[10px] leading-none" title="Exceeds time block capacity">⚠️</span>
          )}
          {!todo.done && !isOverdue && (
            <span
              className={`inline-block font-semibold leading-none px-1 py-0.5 rounded-sm ${compact ? "text-[9px]" : "text-[10px]"}`}
              style={{ backgroundColor: `${color}18`, color }}
            >
              {PRIORITY_LABELS[todo.priority]}
            </span>
          )}
          {todo.done && (
            <span className={`font-semibold leading-none px-1 py-0.5 rounded-sm ${compact ? "text-[9px]" : "text-[10px]"}`} style={{ backgroundColor: "#dcfce7", color: "#16A34A" }}>
              Done
            </span>
          )}
          {isOverdue && !todo.done && (
            <span className={`font-semibold leading-none px-1 py-0.5 rounded-sm ${compact ? "text-[9px]" : "text-[10px]"}`} style={{ backgroundColor: "#fee2e2", color: "#DC2626" }}>
              Overdue
            </span>
          )}
          <span
            className={`text-muted-foreground ${compact ? "text-[9px]" : "text-[10px]"}`}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {todo.duration}h
          </span>
        </div>
      </div>
      <div className="no-print opacity-0 group-hover:opacity-100 transition-all flex-shrink-0 flex flex-col items-center gap-1.5">
        <button
          onClick={(e) => { e.stopPropagation(); onToggleDone(); }}
          className="transition-colors"
          style={{ color: todo.done ? "#16A34A" : "#A8A49E" }}
          title={todo.done ? "Mark undone" : "Mark done"}
        >
          {todo.done
            ? <CheckSquare2 size={compact ? 10 : 11} />
            : <Square size={compact ? 10 : 11} />
          }
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="text-muted-foreground hover:text-destructive transition-colors"
        >
          <Trash2 size={compact ? 10 : 11} />
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
