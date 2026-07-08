# Weekly Planner

A simple handy personal planner for setting up your todos for the week.

A single-user weekly planning app: a 7×3 week grid (AM / PM / Evening) with a
drag-and-drop unscheduled backlog, priorities, durations, capacity warnings,
undo/redo, JSON import/export and print-to-PDF — backed by a local SQLite
database.

- **Backend:** Python / FastAPI + uvicorn, SQLite (`app/planner.db`, created
  automatically)
- **Frontend:** React 18 + Tailwind CSS v4, served as static files straight
  from the backend (no Node.js toolchain — React, Babel and Tailwind load
  from CDNs, so internet access is required at runtime)


## Setup

```powershell
cd app
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

## Run

```powershell
.venv\Scripts\python server.py
```

Then open http://localhost:3366.

## Features

- 7×3 week grid (AM / PM / Evening) with drag & drop scheduling, Ctrl+drag to
  duplicate; drop a task anywhere outside the grid to return it to unscheduled
- Unscheduled sidebar with priority sort, add-task form and resizable width
- Double-click a card to edit title / priority / duration
- Type-to-find in the header: matches highlight, everything else dims
- Overdue detection and done-aware over-capacity warnings
  (AM 3h, PM 5h, Evening 4h — completed tasks don't count)
- Undo / redo for every action (Ctrl+Z / Ctrl+Shift+Z)
- Next-week drop strip while dragging
- PDF via the print dialog (landscape layout, UI chrome hidden)
- JSON import/export backup; all state persisted in SQLite through the REST
  API (`/api/todos`, `/api/placements`, `/api/import`, `/api/export`)

## Backup format

```json
{
  "todos": [
    { "id": "t-1", "title": "Team standup", "priority": "med", "duration": 1, "done": false }
  ],
  "slots": {
    "2026-7-6-AM": ["t-1"],
    "unscheduled": []
  }
}
```

Slot keys are `{year}-{month}-{day}-{AM|PM|Evening}` (month/day not
zero-padded); `unscheduled` is a regular slot. Priorities are
`urgent | med | lo | none`, durations 1–4 hours, and each todo id appears in
exactly one slot, in display order.
