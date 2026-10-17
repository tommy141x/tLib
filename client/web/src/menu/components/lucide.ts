// Per-icon deep imports only. The `lucide-solid` barrel pulls the entire set
// (~400KB); each of these modules is a single path array plus the shared Icon
// component, statically imported so Rollup inlines them into the one entry
// chunk. Never import() an icon: that emits a second file for CEF to fetch.

import type { LucideProps } from "lucide-solid";
import Anchor from "lucide-solid/icons/anchor";
import Ban from "lucide-solid/icons/ban";
import Banknote from "lucide-solid/icons/banknote";
import Bike from "lucide-solid/icons/bike";
import Briefcase from "lucide-solid/icons/briefcase";
import Brush from "lucide-solid/icons/brush";
import Car from "lucide-solid/icons/car";
import Castle from "lucide-solid/icons/castle";
import Check from "lucide-solid/icons/check";
import ChevronDown from "lucide-solid/icons/chevron-down";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import ChevronUp from "lucide-solid/icons/chevron-up";
import CircleAlert from "lucide-solid/icons/circle-alert";
import CircleDot from "lucide-solid/icons/circle-dot";
import CircleQuestionMark from "lucide-solid/icons/circle-question-mark";
import CreditCard from "lucide-solid/icons/credit-card";
import Crosshair from "lucide-solid/icons/crosshair";
import Crown from "lucide-solid/icons/crown";
import Database from "lucide-solid/icons/database";
import Eye from "lucide-solid/icons/eye";
import Flag from "lucide-solid/icons/flag";
import FlagTriangleRight from "lucide-solid/icons/flag-triangle-right";
import Globe from "lucide-solid/icons/globe";
import Hand from "lucide-solid/icons/hand";
import Heart from "lucide-solid/icons/heart";
import Info from "lucide-solid/icons/info";
import Key from "lucide-solid/icons/key";
import Leaf from "lucide-solid/icons/leaf";
import Link from "lucide-solid/icons/link";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import Lock from "lucide-solid/icons/lock";
import LockKeyhole from "lucide-solid/icons/lock-keyhole";
import Medal from "lucide-solid/icons/medal";
import MessageSquare from "lucide-solid/icons/message-square";
import Package from "lucide-solid/icons/package";
import Pill from "lucide-solid/icons/pill";
import Plane from "lucide-solid/icons/plane";
import Radio from "lucide-solid/icons/radio";
import Scissors from "lucide-solid/icons/scissors";
import Search from "lucide-solid/icons/search";
import SearchX from "lucide-solid/icons/search-x";
import Send from "lucide-solid/icons/send";
import Shield from "lucide-solid/icons/shield";
import ShieldAlert from "lucide-solid/icons/shield-alert";
import Ship from "lucide-solid/icons/ship";
import Shirt from "lucide-solid/icons/shirt";
import Sparkles from "lucide-solid/icons/sparkles";
import Square from "lucide-solid/icons/square";
import Stamp from "lucide-solid/icons/stamp";
import Star from "lucide-solid/icons/star";
import Swords from "lucide-solid/icons/swords";
import Tag from "lucide-solid/icons/tag";
import Target from "lucide-solid/icons/target";
import TriangleAlert from "lucide-solid/icons/triangle-alert";
import Trophy from "lucide-solid/icons/trophy";
import UserRound from "lucide-solid/icons/user-round";
import Vault from "lucide-solid/icons/vault";
import VenetianMask from "lucide-solid/icons/venetian-mask";
import Volume from "lucide-solid/icons/volume";
import Volume1 from "lucide-solid/icons/volume-1";
import Volume2 from "lucide-solid/icons/volume-2";
import VolumeOff from "lucide-solid/icons/volume-off";
import Wind from "lucide-solid/icons/wind";
import X from "lucide-solid/icons/x";
import type { Component } from "solid-js";

// Built from lucide-solid's OWN props type rather than from Solid 2's
// `JSX.SvgSVGAttributes`. Props are contravariant, so an alias even slightly
// WIDER than what the real components accept makes every one of the 99
// re-exports below fail to satisfy it — and it reports as 99 unrelated icon
// errors rather than as one type being too generous. Solid 2 widened several
// SVG attributes (`class` to the whole `ClassValue` union, `width`/`height`
// to include `RemoveAttribute`), and narrowing them back one at a time was
// whack-a-mole: `LucideProps` is the single honest description, and it
// already carries `size` and `strokeWidth`.
export type IconComponent = Component<LucideProps>;

// Chrome affordances. These replace text glyphs, so they are decorative and the
// caller marks them aria-hidden; the surrounding control carries the label.
export {
  Ban,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Info,
  LoaderCircle,
  MessageSquare,
  Search,
  SearchX,
  Send,
  ShieldAlert,
  X,
};

/** Fallback shape for a catalog name with no sensible lucide equivalent. */
export const GENERIC: IconComponent = Square;

// MenuAPI icon name -> lucide component, keyed uppercase to match `icons` in
// MenuIcon.tsx. Only consulted outside the game: in game the real GTA texture is
// drawn through nui-img, which is what the source shows and costs nothing.
export const lucideForMenuIcon: Record<string, IconComponent> = {
  WARNING: TriangleAlert,
  LOCK: Lock,
  LOCK_ARENA: LockKeyhole,
  TICK: Check,
  CAR: Car,
  INFO: Info,
  STAR: Star,
  MP_RP: Star,
  CROWN: Crown,
  MEDAL_BRONZE: Medal,
  MEDAL_GOLD: Medal,
  MEDAL_SILVER: Medal,
  CASH: Banknote,
  INV_DOLLAR: Banknote,
  MP_CASH: Banknote,
  SALE: Tag,
  COKE: Pill,
  HEROIN: Pill,
  METH: Pill,
  INV_DRUG: Pill,
  WEED: Leaf,
  INV_WEED: Leaf,
  AMMO: Package,
  MP_AMMO: Package,
  MP_AMMO_PICKUP: Package,
  ARMOR: Shield,
  SHIELD: Shield,
  INV_SURVIVAL: Shield,
  BARBER: Scissors,
  CLOTHING: Shirt,
  MAKEUP_BRUSH: Brush,
  MASK: VenetianMask,
  TATTOO: Stamp,
  FRANKLIN: UserRound,
  MICHAEL: UserRound,
  TREVOR: UserRound,
  INV_PERSON: UserRound,
  FEMALE: UserRound,
  MALE: UserRound,
  BIKE: Bike,
  INV_BIKE: Bike,
  GUN: Crosshair,
  INV_WEAPON: Crosshair,
  INV_SHOOTING_RANGE: Crosshair,
  HEALTH_HEART: Heart,
  ADVERSARY: Swords,
  TROPHY: Trophy,
  DEATHMATCH: Trophy,
  TEAM_DEATHMATCH: Trophy,
  VEHICLE_DEATHMATCH: Trophy,
  RACE_FLAG: FlagTriangleRight,
  RACE_FLAG_PLANE: FlagTriangleRight,
  RACE_FLAG_BIKE: FlagTriangleRight,
  RACE_FLAG_BOAT_ANCHOR: FlagTriangleRight,
  RACE_FLAG_CAR: FlagTriangleRight,
  RACE_FLAG_HELI: FlagTriangleRight,
  CASTLE: Castle,
  INV_CASTLE: Castle,
  BRIEFCASE: Briefcase,
  INV_BRIEFCASE: Briefcase,
  INV_KEY: Key,
  INV_KEYCARD: CreditCard,
  INV_SAFE: Vault,
  INV_PLANE: Plane,
  INV_PLANE2: Plane,
  INV_HELI: Plane,
  INV_BOAT: Ship,
  INV_ANCHOR: Anchor,
  INV_DATA: Database,
  INV_REMOTE: Radio,
  INV_LINK: Link,
  INV_QUESTIONMARK: CircleQuestionMark,
  INV_GOLF: Target,
  INV_TENNIS: Target,
  INV_DARTS: Target,
  INV_ARM_WRESTLING: Hand,
  BASE_JUMPING: Wind,
  INV_BASEJUMP: Wind,
  STUNT: Wind,
  STUNT_PREMIUM: Wind,
  MISSION_STAR: Star,
  INV_MISSION: Star,
  ROCKSTAR: Sparkles,
  MP_SPECTATING: Eye,
  GLOBE_WHITE: Globe,
  GLOBE_RED: Globe,
  GLOBE_BLUE: Globe,
  GLOBE_YELLOW: Globe,
  GLOBE_GREEN: Globe,
  GLOBE_ORANGE: Globe,
  AUDIO_MUTE: VolumeOff,
  AUDIO_INACTIVE: Volume,
  AUDIO_VOL1: Volume1,
  AUDIO_VOL2: Volume2,
  AUDIO_VOL3: Volume2,
  INV_STEER_WHEEL: CircleDot,
};

// Manufacturer logos and national flags have no lucide equivalent and are not
// worth hand-drawing: in game the real texture is used, and the browser only
// needs something the right size in the right box.
export function lucideFor(name: string): IconComponent {
  const mapped = lucideForMenuIcon[name];
  if (mapped) return mapped;
  if (name.startsWith("BRAND_")) return Car;
  if (name.startsWith("COUNTRY_")) return Flag;
  return GENERIC;
}
