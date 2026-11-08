# One CCDM Stack and One Bot per Machine

A second machine (the Windows PC) runs its own complete CCDM stack: its own Router, sessions, Thread Supervisor, reminder service and usage collection, with **its own Discord bot**, in its own private category of the same Discord server. Nothing is shared between the machines' stacks: no shared Router, no shared token, no shared state. The Windows stack runs natively on Windows (no WSL, no tmux). This is topology "D, delivered as B first": every machine is a full peer (D), and the first delivery is simply two independent stacks side by side (B). A link between the machines is not part of this decision; if the owner later wants to talk to both from one place, a shared root channel listened to by both roots comes first, and a peer link only if that is not enough.

Each machine keeps working while the other sleeps. Threads, reminders, the usage poster, guests and the emergency fallback stay machine-local, so reaching parity needs no topology work; the port itself is the cost. The Mac token never leaves the Mac. The Windows bot is scoped to its own category through channel overrides; Discord still lets it do what `@everyone` may do server-wide and read the server audit log, and server-wide Manage Roles is never granted to it, because that would let it hand out the Mac's guest roles. In project channels each bot sees only its own category, so mentioning the other machine's bot there does nothing.

## Considered Options

- **Windows sessions as remote clients of the Mac Router:** rejected. Every Windows session dies whenever the Mac sleeps; reply files and exports pass local paths that do not exist on the other machine; and it is roughly three to five times the work of an independent stack.
- **One bot token on two Routers:** rejected. It puts the full-power token on both machines, and a crash loop on either machine can use up the shared daily gateway identify budget, which resets the token for both.
- **WSL2 as the target:** rejected. It needs an administrator install and a reboot, separate Linux logins for Claude and Codex, hand-written service units in place of the launchd installers, and idle-shutdown settings; Windows projects are reached through slow `/mnt/c` file access and Windows tools only through interop; and the stack has never been proven there, because CI runs Linux only with faked tmux. It stays acceptable as a short-term stop-gap, not as the target.

## Consequences

- The Discord server has two CCDM bots in its member list and two private categories, one per machine; each machine has its own root channel.
- Windows project names carry a suffix (for example `-win`) so no channel name matches a Mac project.
- The Windows stack needs native replacements for the Mac-only pieces: named pipes for the Router socket, a session host for tmux, and Task Scheduler for launchd.
- Each machine is set up, upgraded and restarted on its own; a fault on one never takes the other offline.
