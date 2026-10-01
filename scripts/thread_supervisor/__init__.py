"""The Thread Supervisor worker: Thread Conversation lifecycle behind the Router.

Each concern lives in its own module so later work lands beside, not inside,
the others: `paths` (private state and the Router key), `store` (the SQLite
store), `registry` (the registry, read fresh each time), `link` (the Node
Router link), `binding` (thread_create), `boot` (start and boot handoff), `dispatch` (the event table),
`worker` (the `run` loop), `status` and `service` (`enable`, `disable`, `preflight`).
"""
