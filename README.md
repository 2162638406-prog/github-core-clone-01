# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/2162638406-prog/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/2162638406-prog/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in TypeScript on Node 22, standard
library only, no dependencies, no model calls. It speaks the git smart-HTTP
wire (upload-pack protocol v2 and v0, receive-pack v0 with pkt-line framing,
side-band-64k and pack v2 read/write including deltas), the REST v3 API, the
GraphQL v4 API (including introspection, batching and opaque global ids) and
the MCP JSON-RPC 2.0 surface (2026-07-28 discovery and the legacy initialize
handshake), all over one in-memory store so every surface reads back exactly
what the others wrote. State is fully deterministic: no wall clock, no
unseeded randomness — timestamps come from `MAKEFUN_TRIAL_NOW` and ordering
from insertion counters.

## Run it

```sh
node main.ts
```

`main.ts` binds an ephemeral port, registers it with the environment at
`$MAKEFUN_ENV_URL`, and stays up until the environment reports the trial is
done. `GET /healthz` answers `{"ok": true}` with no auth.

## Layout

- `main.ts` — entry/env lifecycle (bind, register, poll `/done`, exit 0).
- `app.ts` — HTTP server, routing, auth, JSON envelope.
- `store.ts` — in-memory data model: repos, git objects, refs, issues,
  pull requests, labels, comments; tree/commit building, diffs and merge
  conflict detection.
- `git.ts` — pkt-line codec, pack read/write, upload-pack v2/v0,
  receive-pack v0, fast-forward checks, shallow/deepen fetch planning.
- `rest.ts` — REST v3: repos, branches, commits, git refs, contents,
  labels, issues, pulls and squash merges.
- `graphql.ts` — GraphQL v4: hand-written document parser and executor,
  introspection, batched operations.
- `mcp.ts` — MCP tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`, `list_repos`,
  `get_issue`) over the shared store.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
