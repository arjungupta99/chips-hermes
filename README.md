# chips-hermes

[Hermes Agent](https://hermes-agent.nousresearch.com) as a [Chips](https://chipschat.ai) harness,
on Hermes's own API server.
- Each Hermes profile you name is a Chips agent. The first is the harness's Main agent.
- Each Chips room an agent is in is a Hermes session of its profile, made the first time somebody
  there speaks to it.

Apache-2.0. Not published: a local repository until Chips's SDK is.

## What Chips shows

| In Chips | From Hermes (`/v1/runs`) |
| --- | --- |
| A message to the agent | `POST /v1/runs` in the room's session: the room note, what was said, the words |
| The thinking bubble's words | `reasoning.available`, `message.interim` |
| Steps, drawn by kind | `tool.started` / `tool.completed` (by `tool_call_id`, else first in, first out per tool); a sub-agent's `subagent.start` / `subagent.complete` |
| The reply | `run.completed`'s `output`, else the `message.delta`s |
| Cost | the run's tokens; a sub-agent's `cost_usd` as its step's share |
| An approval card | `approval.request` → `POST …/approval`: once, session or always where Hermes offers it, else once; deny for a no. One answered in Hermes's own tools is settled in Chips (ADR 0079) |
| Stop | `POST …/stop` |
| A steer, a follow-up, an interrupt | `POST …/steer`; the next run of the turn; stop, then the next run with the words |
| Trouble on the harness | `GET /health` every 30 s, per profile |

Not yet:
- Hermes's clarify questions (their event isn't documented).
- Its cron jobs as Chips schedules (ADR 0157).
- Its model list as the agent's Model group.
- Context files.
- A context gauge (Hermes reports no window during a run).

**Approvals and Hermes v0.20.6.** Hermes's API server counts itself as unattended (issue
[#98728](https://github.com/NousResearch/hermes-agent/issues/98728), open on 14 October 2026). So a
guarded command is denied, or with `approvals.unattended_mode: approve` run unasked, instead of
reaching `/v1/runs` as an approval. Until the fix lands, only the asks Hermes does send (MCP
consent) reach Chips as cards. Don't set `unattended_mode: approve` for an agent people talk to
through Chips: it would act on everything without asking anyone.

## Run it

1. Turn on Hermes's API server, with a key, in `~/.hermes/.env`:

   ```
   API_SERVER_ENABLED=true
   API_SERVER_KEY=<a long random key>
   ```

   Then `hermes gateway`. It listens on `127.0.0.1:8642`.

2. Name the agents in `~/.chips-hermes/config.json` (see `config.example.json`). Each agent is one
   of three:
   - the default profile;
   - a profile under `/p/<profile>`, with `gateway.multiplex_profiles` on and that profile's own key;
   - a profile's own gateway at a `url` of its own.

   Each key is read from the environment variable `keyEnv` names.

3. Join Chips once, with a link from Chips's gallery (Add an agent → Hermes), whose card gives
   this line with the link in it:

   ```
   cd ~/Work/chips-hermes && CHIPS_JOIN_LINK='<link>' API_SERVER_KEY=<the API server's key> npm start
   ```

   Or with `CHIPS_URL` and a code a person allows. Before it takes the link up, which works once,
   it checks the config is there, each key is filled in (not the card's `…`), and Hermes answers
   and takes the key (`/v1/models`, since `/health` needs none); anything missing stops it with what to do, and the link is still good. Joined, its Main agent
   says hello in its room once, which the card waits for. The key Chips gives it is kept, so later
   starts need only the Hermes keys; a new link from Chips replaces it.

## Tests

```
npm test
```

They run the bridge against Chips's conformance fake and a scripted Hermes API server
(`test/fake-hermes.ts`), on Hermes's own routes and event names. That includes Chips's golden
scenario. The SDK and the kit are in `vendor/`, packed from a Chips checkout with
`pnpm release:sdk <this repo>/vendor`.

```
npm run e2e
```

The gallery's card for this connector, run as a person runs it, against a scratch Chips from a
Chips checkout (`CHIPS_REPO`, `~/Work/Chips` unless set; skipped without one) and the same scripted Hermes.
Each thing not set up stops it with the link still good; then it joins with what the card grants,
says hello once in its room, says nothing more started again, and takes up a new link in place of
the key it kept. The scratch Chips, the link and the run come from Chips's `tools/connect-kit`.
