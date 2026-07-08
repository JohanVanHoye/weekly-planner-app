# Week Planner

Single-user weekly planning app on `http://localhost:3366`.

- **Backend:** Python / FastAPI + uvicorn, SQLite database (`planner.db`, created automatically)
- **Frontend:** React 18 served as static files (no Node toolchain — React, Babel and Tailwind v4 are loaded from CDNs, so internet access is required at runtime)
- **Design:** based on the Figma AI export in `../figma-export`

## Setup

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

## Run

```powershell
.venv\Scripts\python server.py
```

Then open http://localhost:3366.

## Features

- 7×3 week grid (AM / PM / Evening) with drag & drop scheduling, Ctrl+drag to duplicate
- Unscheduled sidebar with priority sort and add-task form
- Double-click a card to edit title / priority / duration
- Overdue and over-capacity detection (AM 3h, PM 5h, Evening 4h)
- Next-week drop strip while dragging
- JSON import/export (format documented in `../specification.md`)
- PDF via the print dialog (landscape layout, chrome hidden)
- All state persisted in SQLite through the REST API (`/api/todos`, `/api/placements`, `/api/import`, `/api/export`)
