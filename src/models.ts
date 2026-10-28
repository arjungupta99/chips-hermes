/**
 * An agent's model in Chips (Chips ADRs 0140, 0141, 0241): what each Hermes agent runs on, shown on
 * its page and chosen there, from the models Hermes has for its profile.
 *
 * Hermes 0.22.0 lists them as its own model picker does (`GET /api/model/options`, the dashboard's
 * and TUI's inventory, read 28 October 2026): the profile's model and provider, `config.yaml`'s
 * `model.default` and `model.provider`, and each provider with its models. Asked with
 * `include_unconfigured=false`, it names only the providers the profile has keys or a sign-in for;
 * of those, only the ones Hermes says are signed in are offered here. Hermes says no levels of
 * effort for a model, so none is offered.
 *
 * A pick is the model each of the agent's runs asks for (`POST /v1/runs` takes `provider` and
 * `model`), kept by the bridge: it changes nothing in Hermes's config, and so applies to that agent
 * alone, on a profile of its own or one it shares. Hermes's default, the Same as switch, is the
 * profile's own model, set in Hermes (`hermes -p <profile> model`).
 */

import type { AgentModelCopy } from "@chipschat/harness";

/** What Chips takes at most (`MODEL_CHOICES_MAX`), and a label's length. */
export const MODEL_CHOICES_MAX = 40;
const LABEL_MAX = 80;

/** What the Same as switch says. */
export const DEFAULT_LABEL = "Hermes's default";

/** One provider of Hermes's, as `/api/model/options` lists it. */
export interface HermesProvider {
  readonly slug: string;
  readonly name?: string | undefined;
  readonly models?: readonly string[] | undefined;
  readonly is_current?: boolean | undefined;
  readonly authenticated?: boolean | undefined;
}

/** What `/api/model/options` answers: the profile's model and provider, and every provider. */
export interface ModelOptions {
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly providers?: readonly HermesProvider[] | undefined;
}

/** What a run asks Hermes for: a provider and its model, or a model alone. */
export interface RunModel {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
}

/** A choice's id: `provider/model`. A model's own `/` (`openrouter/anthropic/…`) stays the model's. */
export function choiceId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** What a choice's id asks a run for. */
export function runModelOf(id: string): RunModel {
  const at = id.indexOf("/");
  return at <= 0 ? { model: id } : { provider: id.slice(0, at), model: id.slice(at + 1) };
}

/** One model it may run on: Hermes says no levels of effort, so it has none. */
interface Choice {
  readonly id: string;
  readonly label: string;
  readonly efforts: { id: string; label: string }[];
}

/** The profile's providers with models, signed in, its current one first. */
function providersOf(options: ModelOptions): HermesProvider[] {
  const ready = (options.providers ?? []).filter(
    (provider) => provider.authenticated !== false && (provider.models ?? []).length > 0,
  );
  const current = (provider: HermesProvider) => provider.is_current === true || provider.slug === options.provider;
  return [...ready.filter(current), ...ready.filter((provider) => !current(provider))];
}

/** Every model Hermes offers the profile, each once, its current provider's first. */
export function choicesOf(options: ModelOptions): Choice[] {
  const choices: Choice[] = [];
  for (const provider of providersOf(options)) {
    for (const model of provider.models ?? []) {
      const id = choiceId(provider.slug, model);
      if (choices.some((choice) => choice.id === id)) continue;
      choices.push({ id, label: `${model} · ${provider.name ?? provider.slug}`.slice(0, LABEL_MAX), efforts: [] });
    }
  }
  return choices;
}

/** The profile's own model, as a choice's id: what an agent with none of its own runs on. */
export function defaultOf(options: ModelOptions): string | undefined {
  const model = options.model?.trim();
  if (model === undefined || model === "") return undefined;
  return options.provider === undefined || options.provider === "" ? model : choiceId(options.provider, model);
}

/**
 * A model named on its own, as a config names one (`heron-2`): the choice it is, its current
 * provider's first, or itself when Hermes lists it under none.
 */
function matched(choices: readonly Choice[], model: string): string {
  if (choices.some((choice) => choice.id === model)) return model;
  return choices.find((choice) => runModelOf(choice.id).model === model)?.id ?? model;
}

/**
 * One agent's copy, as Chips takes it (`PUT /v1/agents/:id/model`): the model it runs on now, its
 * own (`own`, a choice's id or a model alone) or Hermes's default, and the models it may run on.
 * One it runs on that Hermes no longer offers is among its choices anyway, so the copy names what
 * is true. Nothing when Hermes names neither a model nor any to choose.
 */
export function copyOf(options: ModelOptions, own: string | undefined): AgentModelCopy | undefined {
  let choices = choicesOf(options);
  const fallback = defaultOf(options);
  const byDefault = fallback === undefined ? undefined : matched(choices, fallback);
  const mine = own === undefined ? undefined : matched(choices, own);
  const model = mine ?? byDefault ?? choices[0]?.id;
  if (model === undefined) return undefined;
  const keep = [model, ...(byDefault === undefined ? [] : [byDefault])];
  for (const id of keep) {
    if (!choices.some((choice) => choice.id === id)) choices = [{ id, label: id.slice(0, LABEL_MAX), efforts: [] }, ...choices];
  }
  let others = MODEL_CHOICES_MAX - keep.filter((id, at) => keep.indexOf(id) === at).length;
  choices = choices.filter((choice) => keep.includes(choice.id) || others-- > 0);
  return {
    model,
    own: mine !== undefined,
    ...(byDefault === undefined ? {} : { default: { label: DEFAULT_LABEL, model: byDefault } }),
    choices,
    editable: true,
  };
}
