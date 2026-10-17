/**
 * The gallery's Hermes card, run as a person runs it, against a scratch Chips and the fake Hermes
 * (Chips ADRs 0122, 0171; its findings' ON-8): what isn't set up stops it before the link is
 * spent; then it joins with what the card grants and says hello once; started again it says
 * nothing more; and a new link is taken up in place of the key it kept.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { STILL_GOOD } from "../../src/setup.ts";
import { type FakeHermes, startFakeHermes } from "../fake-hermes.ts";
import { type CardLink, here, type ScratchChips, scratchChips, skip } from "./kit.ts";

const HELLO = /^Hi, I'm Hermes, here through Hermes\. Ask me anything\.$/;

describe("Hermes's card, from a link to its hello", { skip, timeout: 180_000 }, () => {
  let chips: ScratchChips;
  let hermes: FakeHermes;
  let home: string;
  let card: CardLink;
  /** The card's command as a person runs it: a card that still asks for the key gets it filled in. */
  const filled = (command: string) => command.replace("API_SERVER_KEY=…", `API_SERVER_KEY=${hermes.key}`);
  const kept = () =>
    Object.values(JSON.parse(readFileSync(join(home, ".config/chips/harness-keys.json"), "utf8")) as Record<string, string>).map(
      (record) => JSON.parse(record) as { harnessId: string; hello: string },
    );
  const hellos = async (spaceId: string) => (await chips.said(spaceId)).filter((each) => HELLO.test(each.text));
  /** The command run to its end: what not being set up stops it with. */
  const stopped = async (command: string, says: RegExp) => {
    const run = chips.run(command, { folder: here, home });
    assert.equal(await run.exited, 1, run.output());
    assert.match(run.output(), says);
    assert.ok(run.output().includes(STILL_GOOD), run.output());
    assert.equal((await chips.request(card.requestId)).state, "allowed", "the link is still good");
  };

  before(async () => {
    [chips, hermes] = await Promise.all([scratchChips(), startFakeHermes()]);
    home = mkdtempSync(join(tmpdir(), "chips-hermes-home-"));
    card = await chips.card("hermes");
  });

  after(async () => {
    await Promise.all([chips?.stop(), hermes?.close()]);
    rmSync(home, { recursive: true, force: true });
  });

  it("stops on each thing not set up, and leaves the link good", async () => {
    // No config is Hermes's default profile; its key is the API server's, from Hermes's own .env.
    await stopped(card.command, /Hermes's key isn't in \$API_SERVER_KEY or .*\.hermes\/\.env\. Turn on Hermes's API server/);
    // Pointed at the fake Hermes, which the default profile's port isn't.
    mkdirSync(join(home, ".chips-hermes"));
    writeFileSync(
      join(home, ".chips-hermes", "config.json"),
      JSON.stringify({ url: hermes.url, agents: [{ name: "Hermes", profile: "default", keyEnv: "API_SERVER_KEY" }] }),
    );
    mkdirSync(join(home, ".hermes"));
    writeFileSync(join(home, ".hermes", ".env"), `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${hermes.key}\n`);
    hermes.up = false;
    await stopped(filled(card.command), /Hermes isn't answering for Hermes at http:\/\/127\.0\.0\.1:\d+/);
    hermes.up = true;
    writeFileSync(join(home, ".hermes", ".env"), "API_SERVER_ENABLED=true\nAPI_SERVER_KEY=not-the-servers-key\n");
    await stopped(filled(card.command), /Hermes at http:\/\/127\.0\.0\.1:\d+ refused Hermes's key, from .*\.hermes\/\.env: it has to be the API_SERVER_KEY/);
    writeFileSync(join(home, ".hermes", ".env"), `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${hermes.key}\n`);
  });

  it("joins with what the card grants, and says hello once in its room", async () => {
    const run = chips.run(filled(card.command), { folder: here, home });
    try {
      const request = await chips.until("the link taken up", async () => {
        const read = await chips.request(card.requestId);
        return read.state === "redeemed" && read;
      });
      assert.ok(request.harness_id !== undefined && request.space_id !== undefined);
      assert.deepEqual([...(await chips.capabilities(request.harness_id))].sort(), [...card.capabilities].sort());
      await chips.until("its hello", async () => (await hellos(request.space_id!)).length > 0);
      await run.saw(/answering for Hermes through Hermes/);
      assert.equal((await hellos(request.space_id)).length, 1);
      // Marked said once it is: the key it kept is the one the link handed it.
      await chips.until("its hello marked said", async () => kept()[0]?.hello === "said");
      assert.deepEqual(
        kept().map((each) => each.harnessId),
        [request.harness_id],
      );
      // One agent, called what its config says, as its Main: no "Hermes 2" beside it (Chips ON-10).
      assert.deepEqual(await chips.agents(request.harness_id), [{ name: "Hermes", lead: true }]);
    } finally {
      await run.stop();
    }
  });

  it("started again with the same command, says nothing more", async () => {
    const { space_id } = await chips.request(card.requestId);
    const run = chips.run(filled(card.command), { folder: here, home });
    try {
      await run.saw(/answering for Hermes through Hermes/);
      // Its hello, were it to say one, comes straight after.
      await new Promise((done) => setTimeout(done, 1500));
      assert.equal((await hellos(space_id!)).length, 1, run.output());
    } finally {
      await run.stop();
    }
  });

  it("takes up a new link in place of the key it kept, and says hello in the new room", async () => {
    const first = await chips.request(card.requestId);
    const again = await chips.card("hermes");
    const run = chips.run(filled(again.command), { folder: here, home });
    try {
      const request = await chips.until("the new link taken up", async () => {
        const read = await chips.request(again.requestId);
        return read.state === "redeemed" && read;
      });
      assert.notEqual(request.harness_id, first.harness_id);
      await chips.until("its hello in the new room", async () => (await hellos(request.space_id!)).length === 1);
      assert.deepEqual(
        kept().map((each) => each.harnessId),
        [request.harness_id],
      );
      // One agent, as its Main. The first harness's agent still holds "Hermes" (ADR 0091).
      assert.deepEqual(await chips.agents(String(request.harness_id)), [{ name: "Hermes 2", lead: true }]);
    } finally {
      await run.stop();
    }
  });
});
