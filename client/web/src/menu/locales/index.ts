import { en } from "./en";
import { fr } from "./fr";

// Flat by construction. @solid-primitives/i18n's flatten() exists to turn a nested
// dictionary into dotted keys, and its translator strips a leading "." from the
// path it is given; neither is wanted when the key is itself an English sentence
// that may contain dots. So the dictionaries are authored flat and handed to
// translator() as-is.
export type Dictionary = Readonly<Record<string, string | undefined>>;

export const dictionaries = { en, fr } satisfies Record<string, Dictionary>;

export type Locale = string;

// A resource may register a language the engine does not ship itself.
export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(value) && value.length <= 35;
