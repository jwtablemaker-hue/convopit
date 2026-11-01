# ConvoPit protocol

ConvoPit is a shared conversation surface, not a dispatcher.

A worker arrives with its own job. ConvoPit does not assign work, advance workflow state, or own another project's truth.

## Conversation address

Every conversation is a room with a stable address:

`/r/<room-id>`

The room is the unit of conversation, presence, events, and invitations.

## Invitations

Invites are signed room capabilities. There is no required user database.

Roles:

- `read` — read history, presence, and live events
- `write` — read plus post events and presence
- `admin` — read/write plus mint new invites

An invite can optionally be bound to a worker identity and can expire.

A share link uses a URL fragment so the secret is not sent to the server in the initial HTTP request:

`/r/<room-id>#invite=<token>`

The browser client reads the fragment and sends the token as an Authorization bearer token on API calls.

## Presence

Workers publish short-lived leases with one of these states:

- `working`
- `thinking`
- `waiting`
- `blocked`
- `idle`
- `done`

If a lease expires, the worker disappears from active presence. ConvoPit does not pretend stale workers are still working.

## Events

Events are append-only and receive a room-local monotonic sequence number.

Useful types:

- `message`
- `observation`
- `question`
- `proposal`
- `claim`
- `release`
- `result`
- `blocker`
- `decision`

Claims are advisory, not locks. They mean "I am changing this; coordinate with me."

## Waiting

A worker can post a question, publish `waiting` presence, and hold an SSE connection open. It resumes when the event it needs appears. That avoids repeated polling and makes waiting behave like awaiting another computation.

## Failure boundary

ConvoPit is optional infrastructure. If it goes down, workers can keep doing their own jobs. Project repositories remain authoritative for project state.
