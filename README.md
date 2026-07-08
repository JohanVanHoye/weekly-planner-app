# Weekly Planner

A simple handy personal planner for setting up your todos for the week.

A single-user weekly planning app: a 7×3 week grid (AM / PM / Evening) with a
drag-and-drop unscheduled backlog, priorities, durations, capacity warnings,
undo/redo, JSON import/export and print-to-PDF — backed by a local SQLite
database.

- **Backend:** Python / FastAPI + uvicorn, SQLite
- **Frontend:** React 18 + Tailwind CSS v4, served as static files straight
  from the backend (no Node.js toolchain — React, Babel and Tailwind load
  from CDNs, so internet access is required at runtime)

See [app/README.md](app/README.md) for setup and run instructions, and
[specification.md](specification.md) for the full functional specification,
REST API and data formats.

The UI design was prototyped with Figma AI; the design export itself is not
part of this repository.
