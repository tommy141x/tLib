/**
 * `bun run thumb` — the store/docs hero and banner, composited from real gallery captures.
 *
 * The frame, the light rig and the guards are in `shared/ts/build/hero.ts`, which every other
 * resource's `scripts/thumb.ts` also calls; this file is only tLib's words and its layer
 * placement.
 *
 * These layers come from `assets/gallery-hero/`, NOT `assets/gallery/`. tLib's NUI is
 * transparent over the game, and the gallery paints a backdrop behind it by default to make the
 * shots reviewable. ANY backdrop is wrong here — even one matching this frame's own black —
 * because the surfaces are small components on a large empty page, so the fill arrives as a
 * rectangle around the component instead of as the component. Shoot them transparent:
 *
 *   bun run gallery -- --only menu,dialog,toast --transparent --out assets/gallery-hero
 *
 * Both folders are git-ignored, so run that first if `assets/gallery-hero/` is empty.
 *
 *   bun run thumb
 *   bun run thumb -- --format banner
 *   bun run thumb -- --subtitle "..." --front dialog--tabbed
 */

import path from "node:path";
import { cliArg } from "../shared/ts/build/argv.ts";
import { type HeroLayer, renderHero } from "../shared/ts/build/hero.ts";

const REPO = path.resolve(import.meta.dir, "..");
const shot = (name: string) => path.join(REPO, "assets", "gallery-hero", `${name}.png`);
const out = (name: string) => path.join(REPO, "docs", "public", name);

const headline = cliArg("headline") ?? "tLib";
const subtitle = cliArg("subtitle") ?? "Shared UI and runtime for every t* resource";
const only = cliArg("format");

/**
 * Toasts and dialogs. Menus belong here too and are deliberately absent: tLib's menu currently
 * rejects the gallery's own snapshot fixture and renders "No available menus — check your ACE
 * permissions" instead of the page, so every `menu--*.png` is a picture of an empty state. The
 * gallery does not catch it, because it waits on `.menu-panel`, which the empty state also has.
 * Put them back the moment that is fixed — `menu--controls` is the one to use.
 *
 * Every layer is a transparent capture, so no border-radius and no box-shadow anywhere: both
 * would draw the rectangle of the SHOT rather than the edge of a component. Each surface is
 * anchored where the real NUI puts it — toasts top-right, dialogs centred — so the offsets below
 * are chosen to bring that anchor into frame, not to centre the image.
 */
const back = shot(cliArg("back", "toast--stack"));
const mid = shot(cliArg("mid", "dialog--tabbed"));
const front = shot(cliArg("front", "dialog--every-field"));

const thumb: HeroLayer[] = [
  {
    // Toasts sit at the top-RIGHT of their capture, so the layer is pulled left to bring that
    // corner into frame. Most of this element is empty transparent page.
    file: back,
    css: `width: 1950px; left: -210px; top: 20px; border-radius: 0;
          transform: rotateY(-9deg) rotateX(3deg) rotateZ(1.4deg);
          filter: brightness(1.02); opacity: .9;`,
  },
  {
    // Secondary, so it goes LEFT and stays soft. Its dialog is centred in the capture too, so
    // `left` is its target centre minus half the layer width: 330 - 575.
    file: mid,
    css: `width: 1150px; left: -245px; top: 18px; border-radius: 0;
          transform: rotateY(9deg) rotateX(3deg) rotateZ(-1.4deg);
          filter: blur(1.4px) brightness(.92); opacity: .6;`,
  },
  {
    // The centrepiece, so its dialog has to land on the frame's centre line — and the dialog is
    // centred within its own capture, which makes `left` the frame centre minus HALF THE LAYER
    // WIDTH, not minus the dialog's. Getting that wrong is what put it out at x=400.
    file: front,
    css: `width: 1900px; left: 10px; top: -84px; border-radius: 0;
          transform: rotateX(1.6deg) rotateZ(-.5deg);`,
  },
];

/**
 * Scaled so the dialog FITS, which the thumb does not have to do. The dialog is 845px of an
 * 1018px capture, so at the thumb's scale it is over 1200px tall against a 500px banner and all
 * you see is a crop of its middle. ~0.52 puts the whole thing in frame with room above and below.
 */
const banner: HeroLayer[] = [
  {
    file: back,
    css: `width: 1250px; left: 219px; top: 58px; border-radius: 0;
          transform: rotateY(-10deg) rotateX(3deg) rotateZ(1.4deg);
          filter: brightness(1.02); opacity: .88;`,
  },
  {
    file: front,
    css: `width: 832px; left: 484px; top: -14px; border-radius: 0;
          transform: rotateY(-8deg) rotateX(3deg) rotateZ(-.8deg);`,
  },
];

/** Four characters against tRadio's thirteen, so this runs above the 148px default to land on a
 *  comparable lockup width — matching the font-size would make the shorter name look small. */
if (only !== "banner") {
  await renderHero({
    format: "thumb",
    headline,
    subtitle,
    headlineSize: 186,
    stageCss: "top: 430px; height: 650px;",
    layers: thumb,
    out: out("thumb.jpg"),
  });
}
if (only !== "thumb") {
  await renderHero({
    format: "banner",
    headline,
    subtitle,
    headlineSize: 112,
    layers: banner,
    out: out("banner.jpg"),
  });
}
