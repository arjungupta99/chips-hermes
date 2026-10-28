# chips-hermes

[Hermes Agent](https://hermes-agent.nousresearch.com) as a [Chips](https://chipschat.ai) harness,
on Hermes's own API server.
- Each Hermes profile you name is a Chips agent. The first is the harness's Main agent.
- Each Chips room an agent is in is a Hermes session of its profile, made the first time somebody
  there speaks to it.
- A new agent a person asks for in a room (Add, then a new one) runs on the first profile, in a
  session of its own. So does the agent of a space a person asks Hermes for from the +.
- A copy of an agent a person asks for in another room (Fork) is a fork of its session there in
  Hermes, so it remembers everything the agent did; from then on the two go on apart. It runs on
  its original's profile, in its original's folder.

Apache-2.0. Not published: a local repository until Chips's SDK is.

## What Chips shows

| In Chips | From Hermes (`/v1/runs`) |
| --- | --- |
| A message to the agent | `POST /v1/runs` in the room's session: the room note, what was said, the words |
| The thinking bubble's words | `reasoning.available`, `message.interim` |
| Steps, drawn by kind | `tool.started` / `tool.completed` (by `tool_call_id`, else first in, first out per tool); a sub-agent's `subagent.start` / `subagent.complete` |
| The reply | `run.completed`'s `output`, else the `message.delta`s |
| Files in the reply | each `MEDIA:<path>` line of its own in the reply, taken out of the words and sent from the agent's folder; a file outside it is refused, and the reply says so. Each run is told how in its `instructions`, which Hermes adds to the system prompt, over its own hint that its API server sends only pictures |
| Cost | the run's tokens; a sub-agent's `cost_usd` as its step's share |
| An approval card | `approval.request` → `POST …/approval`: once, session or always where Hermes offers it, else once, and once for a command, which Chips remembers by how each part starts (Chips ADR 0239); deny for a no. One answered in Hermes's own tools is settled in Chips (ADR 0079) |
| "Not right?" on a reply (ADR 0200) | a run of the agent that said it, in its session in the room, after the room's other turns: told its reply and the person's note (or, for a bare 👎, that there was none), it answers again in its place |
| A space from the + (ADR 0241) | claimed under a key made from the space and named from its first words, which a new agent of the harness answers, in a session of its own; what is said there next goes to the same session |
| Fork (ADR 0087) | `POST /api/sessions/{id}/fork` of the agent's session in the room it is in (else the last it had), from its latest id when Hermes has compressed it, under an id made from the ask, so an ask heard twice forks once. Hermes ends the original as `branched`, and the original's runs go on in it. A turn still going isn't in the copy. An agent that never spoke is copied with nothing to remember |
| Stop | `POST …/stop` |
| A steer, a follow-up, an interrupt | `POST …/steer`; the next run of the turn; stop, then the next run with the words |
| Trouble on the harness | `GET /health` every 30 s, per profile |
| Restart on its page (ADR 0094) | Hermes's gateway restarted on this machine, and Hermes shown as restarting until its API server answers again (below) |
| Context (ADRs 0134, 0238) | the files Hermes builds the agent from: `SOUL.md` (who it is), `memories/USER.md` and `memories/MEMORY.md` in the profile's home, and the first project file with words in it in the folder Hermes's gateway works in (`.hermes.md`, `HERMES.md`, `AGENTS.md` and the rest Hermes looks for). The first profile's files and the project file are the harness's own set, since every new agent reads them; another profile's files are the agent's own until a fork reads them too. An edit is saved where Hermes reads it, only if the file is still the one the person changed. A memory file is saved as Hermes saves it, under its lock, entries apart by a line with only `§`, and an edit over Hermes's limit (2,200 and 1,375 characters unless `config.yaml` says others) is refused with how much to take out. The page says Hermes reads them when a conversation starts: a space already talking picks up a change after it next compacts |
| Context window (ADR 0146) | how full the agent's session is, from the webhook below: the last model call's prompt tokens, of its model's window. A sharp drop in a session is a compaction, and a turn past half the window says its peak. Read only: the limit is the profile's `compression.threshold` (75% under 512K tokens unless set higher), and Hermes can't be asked to compact from Chips. Nothing is shown until Hermes's first reading |

Not yet:
- Hermes's clarify questions (their event isn't documented).
- Its cron jobs as Chips schedules (ADR 0157).
- Its model list as the agent's Model group.

**How full each context is: Hermes's webhook.** Hermes's API server reports no window during a
run, so the bridge adds an outbound webhook to each profile's `config.yaml` when it starts (and
in the check before a link is taken up):

```yaml
hooks:
  outbound:
    - name: chips
      url: http://127.0.0.1:<port>/chips-hermes/default
      events: [post_api_request]
      secret_env: CHIPS_HOOK_SECRET
      timeout: 5
```

It only ever adds: with no `hooks:` it appends this block, and under a `hooks:` with no
`outbound:` yet it puts `outbound:` first. Anything else it leaves as it is, and its log says the
lines to add. The secret goes in the profile's `.env`, which Hermes loads into its gateway; a
profile with no `.env` gets the secret in the entry instead. Hermes reads its hooks when its
gateway starts, so after the bridge adds one, start `hermes gateway` again once (the setup step
says so when the gateway was running). After every model call Hermes then POSTs the call's
numbers, signed, to the bridge on 127.0.0.1. Hermes sends the reply's words too: the bridge
checks the signature, keeps only the numbers, and drops the rest. The port is chosen the first
time and kept; `hookPort` in the config fixes one.

**Approvals and Hermes v0.20.6.** Hermes's API server counts itself as unattended (issue
[#98728](https://github.com/NousResearch/hermes-agent/issues/98728), open on 14 October 2026). So a
guarded command is denied, or with `approvals.unattended_mode: approve` run unasked, instead of
reaching `/v1/runs` as an approval. Until the fix lands, only the asks Hermes does send (MCP
consent) reach Chips as cards. Don't set `unattended_mode: approve` for an agent people talk to
through Chips: it would act on everything without asking anyone.

**On v0.22.0** (run for real on 16 October 2026), `approvals.mode` is `smart` by default: Hermes's
own guardian model judges a flagged command first, and runs it when it judges it safe. The step's
result then says "auto-approved by smart approval", and no card is asked. Only what the guardian
escalates goes the way above. `approvals.mode: manual` leaves every flagged command to a person; it
hasn't been tried through Chips yet.

## From Chips's gallery

The card's line is `chips connect hermes '<link>'` (Chips ADR 0218). It downloads this bridge as the npm package
`@chipschat/hermes`, the newest 1.x, checks it against the registry's checksum, and runs it on the Node
that Chips carries, so the machine needs no Node or npm of its own. The bridge checks Hermes,
joins, and keeps itself running from login. `chips disconnect hermes` stops it. On another computer,
`curl -fsSL https://chipschat.ai/install | sh -s -- connect hermes '<link>'` installs Chips there
first. The steps below run the bridge from this checkout instead, to work on it.

## Run it

1. Turn on Hermes's API server, with a key, in `~/.hermes/.env`:

   ```
   API_SERVER_ENABLED=true
   API_SERVER_KEY=<a long random key>
   ```

   Then `hermes gateway`. It listens on `127.0.0.1:8642`.

2. Once, in this repository: `npm install`.

3. Join Chips once, with a link from Chips's gallery (Add an agent → Hermes), whose card gives
   this line with the link in it:

   ```
   cd ~/Work/Chips/chips-hermes && CHIPS_JOIN_LINK='<link>' npm run keep
   ```

   `npm run keep` joins, then keeps the bridge running from login (below); `npm start` is the
   same in the terminal only.

   Or with `CHIPS_URL` and a code a person allows. Before it takes the link up, which works once,
   it checks there is a key, and that Hermes answers and takes it (`/v1/models`, since `/health`
   needs none). Anything missing stops it with what to do, and the link is still good. Joined, its
   Main agent says hello in its room once, which the card waits for. The key Chips gives it is
   kept, so later starts need nothing; a new link from Chips replaces it.

That is all most people need: with no config the bridge is Hermes's default profile, and the key is
the `API_SERVER_KEY` in `$API_SERVER_KEY` if set, else in Hermes's own `.env` (`$HERMES_HOME/.env`
when `HERMES_HOME` is set).

**Keep it running.** `npm run keep` does what `npm start` does, with the link or without, then
writes a launch agent (`~/Library/LaunchAgents/chat.chips.hermes.plist`; a systemd user unit on
Linux) that runs the bridge from login and again whenever it stops, and ends: closing the terminal
or restarting the machine no longer takes it offline in Chips. Its log is
`~/Library/Logs/chips-hermes.log`. `npm run keep -- --stop` stops it and removes the file. Stop a
copy started by hand first: two answer twice. When the bridge starts and nothing answers at a local
address, it starts Hermes's gateway (below), so Hermes comes back after a reboot too.

**Restart.** Restart on Hermes's page in Chips restarts Hermes's gateway, the process serving its
API server at the agents' address, when that is on this machine:
- Installed as Hermes's own service (`hermes gateway install`, so
  `~/Library/LaunchAgents/ai.hermes.gateway.plist` or a systemd unit), `hermes gateway restart`.
- Run by hand, the process listening on the API's port is stopped (SIGTERM, then SIGKILL if it is
  still there 15 s later), only if it is this user's `hermes gateway run`. Anything else there is
  left alone, and Chips says so. Then `hermes gateway run` is started again with the same words, in
  the folder it worked in, in a session of its own, its output added to
  `~/Library/Logs/chips-hermes-gateway.log`.

Chips shows Hermes as restarting until its API server answers again, then fine, or in a line what
went wrong. Started with the bridge, it is the same, with `hermes gateway start` for a service. The
bridge asks for `restarts` when it joins with a code; a harness joined without it gets Restart
once Chips is told it takes it (`chips declare`, ADR 0046).

On a Mac whose Homebrew python@3.14 can't load macOS's expat, Hermes dies as it starts with
`Symbol not found: _XML_SetAllocTrackerActivationThreshold`. Then the bridge starts Hermes's entry
point (the one the `hermes` wrapper runs) directly, with the wrapper's variables and
`DYLD_LIBRARY_PATH=/opt/homebrew/opt/expat/lib`, which macOS would drop at the wrapper, and its log
says so.

**Folders.** Each agent gets a folder of its own, `~/chips-hermes/agents/<its name>`, made the
first time it is spoken to and kept by its Chips agent after a rename. Each run tells the agent it
is its folder, in the run's `instructions`. The files an answer sends go to the room from there and
from nowhere else.

**More than one agent.** Name them in `~/.chips-hermes/config.json` (see `config.example.json`).
Each agent is one of three:
- the default profile;
- a profile under `/p/<profile>`, with `gateway.multiplex_profiles` on and that profile's own key;
- a profile's own gateway at a `url` of its own.

Each key is read from the variable `keyEnv` names, in the environment or Hermes's `.env`.
`folders` moves where the agents' folders are made. `folder`, for the config or one agent, puts
the agents it covers in one folder they share instead.

## Tests

```
npm test
```

They run the bridge against Chips's conformance fake and a scripted Hermes API server
(`test/fake-hermes.ts`), on Hermes's own routes and event names, and its webhook's signed
readings. That includes Chips's golden scenario. Hermes's own files are in temporary homes: no
test reads or writes `~/.hermes`. The SDK and the kit are in `vendor/`, packed from a Chips checkout with
`pnpm release:sdk <this repo>/vendor`.

```
npm run e2e
```

The gallery's card for this connector, run as a person runs it, against a scratch Chips from a
Chips checkout (`CHIPS_REPO`, `~/Work/Chips/chips-main` unless set; skipped without one) and the same scripted Hermes.
Each thing not set up stops it with the link still good; then it joins with what the card grants,
says hello once in its room, says nothing more started again, and takes up a new link in place of
the key it kept. The scratch Chips, the link and the run come from Chips's `tools/connect-kit`, which packs this checkout and serves it from a stand-in npm registry, so the card's `chips connect` downloads, checks and runs what would be published.

## Release

`npm run release` builds `dist/main.js`, one file with the SDK and everything else bundled in, and
`dist/THIRD-PARTY-NOTICES.md` beside it; runs the tests; and packs `chipschat-hermes-<version>.tgz`. `npm publish`
publishes it. A version's major is the Chips protocol it speaks, and Chips's card names that major
(Chips ADR 0218): a fix is a minor or a patch, and reaches every card of its major the day it is
published.
