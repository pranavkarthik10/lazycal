# TODO

## Now

- Improve event rendering in the calendar view so overlapping events, long titles, and dense days stay readable.
- Make events directly clickable in day/week/month views, not just from the sidebar.
- Add an event details interaction from the grid with title, time, calendar, location, and description.
- Support creating new events from the TUI.
- Add a simple "new event" flow with date, time, title, and calendar selection.

## Important Follow-Ups

- Upgrade Google Calendar permissions from read-only to allow event creation/editing.
- Add keyboard selection for events so click is not the only interaction path.
- Handle all-day events separately from timed events in the grid.
- Improve month view density so busy days do not collapse into unreadable rows.
- Add a clearer empty/loading/error state when events are being fetched.

## Nice Ideas

- Quick add: natural language input like "Lunch tomorrow 1pm".
- Edit and delete existing events.
- Event search / jump to date.
- Better color mapping per calendar and a small legend.
- Optional event preview pane or modal for faster inspection.
- Recurring event indicators and conflict highlighting.

## Notes

- Current sidebar click support exists, but grid event interaction is still missing.
- Current Google scope is `calendar.readonly`, so event creation needs auth changes first.
