# Secret-Saboteurs

A browser based social deduction game for 4–8 players. The Node server validates every move and keeps roles, objectives, investigation reads, and mission actions private.

## Run locally

Requires Node.js 20 or newer. No package install is needed.

```sh
node server/http.mjs
```

Open `http://localhost:3000` on the computer running the server. For another device on the same network, use that computer's LAN address with port `3000`. Rooms are private and require their six character code or invite link.

## Verify the game rules

```sh
node --test
```

The tests cover role secrecy, role counts, team sizes, proposal deadlock, sabotage thresholds, invalid Agent actions, missed mission actions, investigation privacy, and live updates to separate clients.

## Container deployment

The included `Dockerfile` runs the game as a single Node service. Build and run it with a container host that supports long lived HTTP responses. Set `PORT` to the port expected by the host. Room state is held in memory, so redeployments or server restarts end active rooms; keep a single app instance for the friends-only MVP.

There is no database, account system, public matchmaking, or external dependency.
