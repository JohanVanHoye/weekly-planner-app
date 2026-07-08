# Week Planner — Implementation Specification

## Overview

A single-user weekly planning app served from `http://localhost:3366`.

The frontend is a React SPA; the backend is a Node.js HTTP server with a SQLite database. All state lives in the database; the frontend has no `localStorage` dependency.

---

## Stack

- **Server:** Node.js (ESM), better-sqlite3
- **Router:** Any minimal HTTP router (e.g. express, hono, or raw node:http)
- **Frontend:** React 18, Vite dev server proxied through the backend in production
- **Styling:** Tailwind CSS v4
- **Icons:** lucide-react
- **Port:** 3366

---

## Database Schema (SQLite)

```sql
CREATE TABLE IF NOT EXISTS todos (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  priority  TEXT NOT NULL CHECK(priority IN ('urgent','med','lo','none')),
  duration  INTEGER NOT NULL CHECK(duration IN (1,2,3,4)),
  done      INTEGER NOT NULL DEFAULT 0
);

-- Each row is one todo assigned to one slot, with its display order.
-- Unscheduled todos have slot_key = 'unscheduled'.
CREATE TABLE IF NOT EXISTS placements (
  todo_id   TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  slot_key  TEXT NOT NULL,
  position  INTEGER NOT NULL,
  PRIMARY KEY (todo_id)
);
```

### Slot Key Format

Scheduled task slot key format:

```text
{YYYY}-{M}-{D}-{Period}
```

Where:

- `M` and `D` are not zero-padded
- `Period` is exactly `AM`, `PM`, or `Evening`

Example:

```text
2026-7-1-AM
```

---

## REST API

All endpoints accept and return `application/json`.

Base path:

```text
http://localhost:3366/api
```

### Todos

#### GET /todos

Returns all todos with their current placement.

#### POST /todos

Request:

```json
{
  "id": "string",
  "title": "string",
  "priority": "med",
  "duration": 1
}
```

Creates a todo and inserts a placement row with:

```text
slot_key = "unscheduled"
```

at the end of the unscheduled list.

#### PATCH /todos/:id

Request:

```json
{
  "title": "optional",
  "priority": "optional",
  "duration": "optional",
  "done": true
}
```

Updates todo fields.

#### DELETE /todos/:id

Deletes todo and placement row via cascade.

### Example GET /todos Response

```json
[
  {
    "id": "t-1751234567890",
    "title": "Team standup",
    "priority": "med",
    "duration": 1,
    "done": false,
    "slot_key": "unscheduled",
    "position": 0
  }
]
```

---

### Placements

#### PATCH /placements/:todo_id

Request:

```json
{
  "slot_key": "2026-7-1-AM",
  "position": 0
}
```

Moves a todo to a new slot at a given position.

Must also update positions of all affected todos to maintain gapless 0-based ordering.

#### POST /placements/reorder

Request:

```json
{
  "slot_key": "unscheduled",
  "ordered_ids": ["id1", "id2", "id3"]
}
```

Replaces the complete ordered list for a slot.

Used after drag-reorder within a slot.

---

## Import / Export

### GET /export

Returns complete JSON backup.

### POST /import

Accepts backup JSON and replaces all data atomically within a transaction.

---

## JSON Backup Format

```json
{
  "todos": [
    {
      "id": "string",
      "title": "string",
      "priority": "urgent",
      "duration": 1,
      "done": false
    }
  ],
  "slots": {
    "{YYYY}-{M}-{D}-{AM|PM|Evening}": ["todo_id"],
    "unscheduled": ["todo_id"]
  }
}
```

### Rules

- Every ID referenced in `slots` must exist in `todos`
- A todo ID appears in exactly one slot
- Order in each slot array defines display order
- Omit empty slots

---

## Domain Logic (Shared Frontend + Backend)

### Week Navigation

- Week offset 0 = ISO week containing today
- Monday is day 0
- `getWeekDates(offset)` returns seven dates from Monday through Sunday

### ISO Week Number

Use ISO-8601:

- Weeks begin on Monday
- Week 1 contains the first Thursday of the year

### Slot Key Construction

```js
slotKey(date, period) =
  `${year}-${month}-${day}-${period}`;
```

Month and day are not zero-padded.

---

## Overdue Detection (Frontend Only)

A slot is overdue when:

1. Slot date is before today's midnight
2. Slot date is today and period is `AM` and current hour ≥ 12
3. Slot date is today and period is `PM` and current hour ≥ 18

Only applies when:

```js
done === false
```

---

## Over-Capacity Detection (Frontend Only)

### Capacity Limits

| Period | Capacity |
|----------|----------|
| AM | 3h |
| PM | 5h |
| Evening | 4h |

Accumulate task durations top-to-bottom.

The first task causing capacity overflow, and every task after it, receives the over-capacity warning.

---

## Frontend State

Derived entirely from the API at load time.

No localStorage.

```ts
todos: Todo[]
slots: Record<string, string[]>
```

Where:

```text
unscheduled
```

is also a valid slot.

### Mutations

Optimistically update local state before calling APIs for:

- Move
- Edit
- Add
- Delete
- Toggle done

---

# UI Layout

## Overall Structure

```text
┌─────────────┬──────────────────────────────────────────────┐
│  Sidebar    │ Header                                       │
│  240px      │ week nav, date range, W##, buttons           │
├─────────────┼──────────────────────────────────────────────┤
│             │ Week grid (7 × 3)                            │
│             │                                               │
│             │ Next-week strip (52px, drag only)            │
└─────────────┴──────────────────────────────────────────────┘
```

---

## Sidebar (240px Fixed)

Elements:

- Label: "WEEK PLANNER"
- Mono font
- Uppercase
- Small

### Unscheduled Section

Heading:

```text
Unscheduled
```

plus item count.

### Sort Button

Sort order:

```text
urgent > med > lo > none
```

### Content

- Scrollable task list
- Drop target
- Add-task form at bottom
- Form hidden in print

---

## Header

Left to right:

- Previous week button
- Today button
- Next week button
- Date range label

Example:

```text
Jun 29 – Jul 5, 2026
```

- ISO week badge

```text
W27
```

- Import button
- Export button
- PDF button

Hidden in print:

- Navigation buttons
- Import
- Export
- PDF

### Today Highlight

Today's column header uses:

```css
--primary: #D63B2B;
```

---

## Week Grid

Grid definition:

```css
44px [period label]
+ repeat(7, 1fr)

columns

48px [day header]
+ repeat(3, minmax(140px, auto))

rows
```

### Period Labels

Rotated vertical:

- AM
- PM
- Evening

---

# Todo Cards

Two variants:

- Sidebar (full)
- Grid (compact)

---

## Shared Behavior

### Border Color

- Done → `#16A34A`
- Overdue → `#DC2626`
- Otherwise priority color

### Background Tint

- Done → `#f0fdf4`
- Overdue → `#fff8f8`
- Otherwise transparent

### Hover Actions

Show:

- Checkbox (toggle done)
- Trash button

Stacked vertically on right edge.

Hidden in print.

### Editing

