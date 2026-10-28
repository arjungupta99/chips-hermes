/**
 * An agent's model (Chips ADRs 0141, 0241): the copy made from what Hermes's own picker lists for a
 * profile (`GET /api/model/options`), as Hermes 0.22.0 answers it.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { choiceId, copyOf, DEFAULT_LABEL, MODEL_CHOICES_MAX, type ModelOptions, runModelOf } from "../src/models.ts";

/** A profile set up for Anthropic, with OpenAI's key in its environment too, as Hermes lists one. */
const OPTIONS: ModelOptions = {
  model: "claude-sonnet-4-5",
  provider: "anthropic",
  providers: [
    { slug: "openai-api", name: "OpenAI API", is_current: false, authenticated: true, models: ["gpt-5.5", "gpt-5.4-mini"] },
    { slug: "anthropic", name: "Anthropic", is_current: true, authenticated: true, models: ["claude-sonnet-4-5", "claude-opus-5-5"] },
    { slug: "openrouter", name: "OpenRouter", is_current: false, authenticated: false, models: ["anthropic/claude-opus-5-5"] },
    { slug: "nous", name: "Nous Portal", is_current: false, authenticated: true, models: [] },
  ],
};

describe("an agent's model", () => {
  it("offers the models of the providers the profile is signed in to, its own provider's first, and Hermes's default", () => {
    assert.deepEqual(copyOf(OPTIONS, undefined), {
      model: "anthropic/claude-sonnet-4-5",
      own: false,
      default: { label: DEFAULT_LABEL, model: "anthropic/claude-sonnet-4-5" },
      choices: [
        { id: "anthropic/claude-sonnet-4-5", label: "claude-sonnet-4-5 · Anthropic", efforts: [] },
        { id: "anthropic/claude-opus-5-5", label: "claude-opus-5-5 · Anthropic", efforts: [] },
        { id: "openai-api/gpt-5.5", label: "gpt-5.5 · OpenAI API", efforts: [] },
        { id: "openai-api/gpt-5.4-mini", label: "gpt-5.4-mini · OpenAI API", efforts: [] },
      ],
      editable: true,
    });
  });

  it("runs on a model picked, or one its config names alone, as its own", () => {
    assert.deepEqual(
      [copyOf(OPTIONS, "openai-api/gpt-5.5")?.model, copyOf(OPTIONS, "openai-api/gpt-5.5")?.own],
      ["openai-api/gpt-5.5", true],
    );
    assert.equal(copyOf(OPTIONS, "claude-opus-5-5")?.model, "anthropic/claude-opus-5-5", "a config's model, found under its provider");
    // One Hermes no longer offers is named anyway, so the copy says what is true.
    const gone = copyOf(OPTIONS, "openrouter/anthropic/claude-opus-5-5");
    assert.equal(gone?.model, "openrouter/anthropic/claude-opus-5-5");
    assert.equal(gone?.choices[0]?.id, "openrouter/anthropic/claude-opus-5-5");
  });

  it("asks a run for a provider and its model, a model's own / kept", () => {
    assert.deepEqual(runModelOf(choiceId("openai-api", "gpt-5.5")), { provider: "openai-api", model: "gpt-5.5" });
    assert.deepEqual(runModelOf("openrouter/anthropic/claude-opus-5-5"), { provider: "openrouter", model: "anthropic/claude-opus-5-5" });
    assert.deepEqual(runModelOf("heron-2"), { model: "heron-2" });
  });

  it("offers forty at most, the one it runs on and the default among them", () => {
    const many: ModelOptions = {
      model: "m-0",
      provider: "big",
      providers: [{ slug: "big", name: "Big", authenticated: true, models: Array.from({ length: 60 }, (_, at) => `m-${at}`) }],
    };
    const copy = copyOf(many, "big/m-59");
    assert.equal(copy?.choices.length, MODEL_CHOICES_MAX);
    assert.ok(copy?.choices.some((choice) => choice.id === "big/m-59"));
    assert.ok(copy?.choices.some((choice) => choice.id === "big/m-0"));
  });

  it("makes no copy when Hermes names no model at all", () => {
    assert.equal(copyOf({ providers: [] }, undefined), undefined);
  });
});
