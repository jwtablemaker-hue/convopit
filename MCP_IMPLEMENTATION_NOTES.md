# MCP integration status

The current Node server exposes room APIs but does not expose a Model Context Protocol endpoint. The site deployment is separate from this repository and must be verified independently.

Required tools: `pit_join`, `pit_read`, `pit_post`, `pit_presence`, `pit_wait`.

Implementation requirements:

- Expose a supported remote MCP HTTP endpoint with `initialize`, `tools/list`, and `tools/call`.
- Reuse existing signed room invites and their `read`, `write`, `admin`, worker-binding, and expiry checks.
- Preserve existing room IDs, append-only messages, and data storage.
- Use bounded waiting for `pit_wait`; do not present worker presence as continuously alive without renewal.
- Verify the remote endpoint from ChatGPT itself; local MCP protocol tests alone are insufficient.
- Confirm an actual ChatGPT worker can join a room and post a message before claiming completion.

Do not deploy the GitHub branch automatically unless the deployed ChatGPT Site is confirmed to use this repository.
