import { createMemo, createSignal, Show } from "solid-js";
import { Dynamic } from "@solidjs/web";
import { inGame } from "../bridge";
import { lucideFor } from "./lucide";

// MenuAPI icon-to-game-asset identifiers. No external image URLs are accepted.
// CitizenFX extra-natives-five/src/NuiTxdSource.cpp registers https://nui-img.
const icons: Record<string, [string, string, string]> = {
  AMMO: ["commonmenu", "shop_ammo_icon_a", "shop_ammo_icon_b"],
  ARMOR: ["commonmenu", "shop_armour_icon_a", "shop_armour_icon_b"],
  BARBER: ["commonmenu", "shop_barber_icon_a", "shop_barber_icon_b"],
  BIKE: ["commonmenu", "shop_garage_bike_icon_a", "shop_garage_bike_icon_b"],
  CAR: ["commonmenu", "shop_garage_icon_a", "shop_garage_icon_b"],
  CASH: ["commonmenu", "mp_specitem_cash", "mp_specitem_cash"],
  CLOTHING: ["commonmenu", "shop_clothing_icon_a", "shop_clothing_icon_b"],
  COKE: ["commonmenu", "mp_specitem_coke", "mp_specitem_coke"],
  CROWN: ["commonmenu", "mp_hostcrown", "mp_hostcrown"],
  FRANKLIN: ["commonmenu", "shop_franklin_icon_a", "shop_franklin_icon_b"],
  GUN: ["commonmenu", "shop_gunclub_icon_a", "shop_gunclub_icon_b"],
  HEALTH_HEART: ["commonmenu", "shop_health_icon_a", "shop_health_icon_b"],
  HEROIN: ["commonmenu", "mp_specitem_heroin", "mp_specitem_heroin"],
  LOCK: ["commonmenu", "shop_lock", "shop_lock"],
  MAKEUP_BRUSH: ["commonmenu", "shop_makeup_icon_a", "shop_makeup_icon_b"],
  MASK: ["commonmenu", "shop_mask_icon_a", "shop_mask_icon_b"],
  MEDAL_BRONZE: ["commonmenu", "mp_medal_bronze", "mp_medal_bronze"],
  MEDAL_GOLD: ["commonmenu", "mp_medal_gold", "mp_medal_gold"],
  MEDAL_SILVER: ["commonmenu", "mp_medal_silver", "mp_medal_silver"],
  METH: ["commonmenu", "mp_specitem_meth", "mp_specitem_meth"],
  MICHAEL: ["commonmenu", "shop_michael_icon_a", "shop_michael_icon_b"],
  STAR: ["commonmenu", "shop_new_star", "shop_new_star"],
  TATTOO: ["commonmenu", "shop_tattoos_icon_a", "shop_tattoos_icon_b"],
  TICK: ["commonmenu", "shop_tick_icon", "shop_tick_icon"],
  TREVOR: ["commonmenu", "shop_trevor_icon_a", "shop_trevor_icon_b"],
  WARNING: ["commonmenu", "mp_alerttriangle", "mp_alerttriangle"],
  WEED: ["commonmenu", "mp_specitem_weed", "mp_specitem_weed"],
  MALE: ["mpleaderboard", "leaderboard_male_icon", "leaderboard_male_icon"],
  FEMALE: ["mpleaderboard", "leaderboard_female_icon", "leaderboard_female_icon"],
  LOCK_ARENA: ["commonmenu", "shop_lock_arena", "shop_lock_arena"],
  ADVERSARY: ["commonmenutu", "adversary", "adversary"],
  BASE_JUMPING: ["commonmenutu", "base_jumping", "base_jumping"],
  BRIEFCASE: ["commonmenutu", "capture_the_flag", "capture_the_flag"],
  MISSION_STAR: ["commonmenutu", "custom_mission", "custom_mission"],
  DEATHMATCH: ["commonmenutu", "deathmatch", "deathmatch"],
  CASTLE: ["commonmenutu", "gang_attack", "gang_attack"],
  TROPHY: ["commonmenutu", "last_team_standing", "last_team_standing"],
  RACE_FLAG: ["commonmenutu", "race", "race"],
  RACE_FLAG_PLANE: ["commonmenutu", "race_air", "race_air"],
  RACE_FLAG_BICYCLE: ["commonmenutu", "race_bicycle", "race_bicycle"],
  RACE_FLAG_PERSON: ["commonmenutu", "race_foot", "race_foot"],
  RACE_FLAG_CAR: ["commonmenutu", "race_land", "race_land"],
  RACE_FLAG_BOAT_ANCHOR: ["commonmenutu", "race_water", "race_water"],
  ROCKSTAR: ["commonmenutu", "rockstar", "rockstar"],
  STUNT: ["commonmenutu", "stunt", "stunt"],
  STUNT_PREMIUM: ["commonmenutu", "stunt_premium", "stunt_premium"],
  RACE_FLAG_STUNT_JUMP: ["commonmenutu", "stunt_race", "stunt_race"],
  SHIELD: ["commonmenutu", "survival", "survival"],
  TEAM_DEATHMATCH: ["commonmenutu", "team_deathmatch", "team_deathmatch"],
  VEHICLE_DEATHMATCH: ["commonmenutu", "vehicle_deathmatch", "vehicle_deathmatch"],
  MP_AMMO_PICKUP: ["mphud", "ammo_pickup", "ammo_pickup"],
  MP_AMMO: ["mphud", "mp_anim_ammo", "mp_anim_ammo"],
  MP_CASH: ["mphud", "mp_anim_cash", "mp_anim_cash"],
  MP_RP: ["mphud", "mp_anim_rp", "mp_anim_rp"],
  MP_SPECTATING: ["mphud", "spectating", "spectating"],
  SALE: ["mpshopsale", "saleicon", "saleicon"],
  INV_ARM_WRESTLING: ["mpinventory", "arm_wrestling", "arm_wrestling"],
  INV_BASEJUMP: ["mpinventory", "basejump", "basejump"],
  INV_MISSION: ["mpinventory", "custom_mission", "custom_mission"],
  INV_DARTS: ["mpinventory", "darts", "darts"],
  INV_DEATHMATCH: ["mpinventory", "deathmatch", "deathmatch"],
  INV_DRUG: ["mpinventory", "drug_trafficking", "drug_trafficking"],
  INV_CASTLE: ["mpinventory", "gang_attack", "gang_attack"],
  INV_GOLF: ["mpinventory", "golf", "golf"],
  INV_BIKE: ["mpinventory", "mp_specitem_bike", "mp_specitem_bike"],
  INV_BOAT: ["mpinventory", "mp_specitem_boat", "mp_specitem_boat"],
  INV_ANCHOR: ["mpinventory", "mp_specitem_boatpickup", "mp_specitem_boatpickup"],
  INV_CAR: ["mpinventory", "mp_specitem_car", "mp_specitem_car"],
  INV_DOLLAR: ["mpinventory", "mp_specitem_cash", "mp_specitem_cash"],
  INV_COKE: ["mpinventory", "mp_specitem_coke", "mp_specitem_coke"],
  INV_KEY: ["mpinventory", "mp_specitem_cuffkeys", "mp_specitem_cuffkeys"],
  INV_DATA: ["mpinventory", "mp_specitem_data", "mp_specitem_data"],
  INV_HELI: ["mpinventory", "mp_specitem_heli", "mp_specitem_heli"],
  INV_HEORIN: ["mpinventory", "mp_specitem_heroin", "mp_specitem_heroin"],
  INV_KEYCARD: ["mpinventory", "mp_specitem_keycard", "mp_specitem_keycard"],
  INV_METH: ["mpinventory", "mp_specitem_meth", "mp_specitem_meth"],
  INV_BRIEFCASE: ["mpinventory", "mp_specitem_package", "mp_specitem_package"],
  INV_LINK: ["mpinventory", "mp_specitem_partnericon", "mp_specitem_partnericon"],
  INV_PERSON: ["mpinventory", "mp_specitem_ped", "mp_specitem_ped"],
  INV_PLANE: ["mpinventory", "mp_specitem_plane", "mp_specitem_plane"],
  INV_PLANE2: ["mpinventory", "mp_specitem_plane2", "mp_specitem_plane2"],
  INV_QUESTIONMARK: ["mpinventory", "mp_specitem_randomobject", "mp_specitem_randomobject"],
  INV_REMOTE: ["mpinventory", "mp_specitem_remote", "mp_specitem_remote"],
  INV_SAFE: ["mpinventory", "mp_specitem_safe", "mp_specitem_safe"],
  INV_STEER_WHEEL: ["mpinventory", "mp_specitem_steer_wheel", "mp_specitem_steer_wheel"],
  INV_WEAPON: ["mpinventory", "mp_specitem_weapons", "mp_specitem_weapons"],
  INV_WEED: ["mpinventory", "mp_specitem_weed", "mp_specitem_weed"],
  INV_RACE_FLAG_PLANE: ["mpinventory", "race_air", "race_air"],
  INV_RACE_FLAG_BICYCLE: ["mpinventory", "race_bike", "race_bike"],
  INV_RACE_FLAG_BOAT_ANCHOR: ["mpinventory", "race_boat", "race_boat"],
  INV_RACE_FLAG_PERSON: ["mpinventory", "race_foot", "race_foot"],
  INV_RACE_FLAG_CAR: ["mpinventory", "race_land", "race_land"],
  INV_RACE_FLAG_HELMET: ["mpinventory", "race_offroad", "race_offroad"],
  INV_SHOOTING_RANGE: ["mpinventory", "shooting_range", "shooting_range"],
  INV_SURVIVAL: ["mpinventory", "survival", "survival"],
  INV_TEAM_DEATHMATCH: ["mpinventory", "team_deathmatch", "team_deathmatch"],
  INV_TENNIS: ["mpinventory", "tennis", "tennis"],
  INV_VEHICLE_DEATHMATCH: ["mpinventory", "vehicle_deathmatch", "vehicle_deathmatch"],
  AUDIO_MUTE: ["mpleaderboard", "leaderboard_audio_mute", "leaderboard_audio_mute"],
  AUDIO_INACTIVE: ["mpleaderboard", "leaderboard_audio_inactive", "leaderboard_audio_inactive"],
  AUDIO_VOL1: ["mpleaderboard", "leaderboard_audio_1", "leaderboard_audio_1"],
  AUDIO_VOL2: ["mpleaderboard", "leaderboard_audio_2", "leaderboard_audio_2"],
  AUDIO_VOL3: ["mpleaderboard", "leaderboard_audio_3", "leaderboard_audio_3"],
  COUNTRY_USA: ["mpcarhud", "vehicle_card_icons_flag_usa", "vehicle_card_icons_flag_usa"],
  COUNTRY_UK: ["mpcarhud", "vehicle_card_icons_flag_uk", "vehicle_card_icons_flag_uk"],
  COUNTRY_SWEDEN: ["mpcarhud", "vehicle_card_icons_flag_sweden", "vehicle_card_icons_flag_sweden"],
  COUNTRY_KOREA: ["mpcarhud", "vehicle_card_icons_flag_korea", "vehicle_card_icons_flag_korea"],
  COUNTRY_JAPAN: ["mpcarhud", "vehicle_card_icons_flag_japan", "vehicle_card_icons_flag_japan"],
  COUNTRY_ITALY: ["mpcarhud", "vehicle_card_icons_flag_italy", "vehicle_card_icons_flag_italy"],
  COUNTRY_GERMANY: [
    "mpcarhud",
    "vehicle_card_icons_flag_germany",
    "vehicle_card_icons_flag_germany",
  ],
  COUNTRY_FRANCE: ["mpcarhud", "vehicle_card_icons_flag_france", "vehicle_card_icons_flag_france"],
  BRAND_ALBANY: ["mpcarhud", "albany", "albany"],
  BRAND_ANNIS: ["mpcarhud", "annis", "annis"],
  BRAND_BANSHEE: ["mpcarhud", "banshee", "banshee"],
  BRAND_BENEFACTOR: ["mpcarhud", "benefactor", "benefactor"],
  BRAND_BF: ["mpcarhud", "bf", "bf"],
  BRAND_BOLLOKAN: ["mpcarhud", "bollokan", "bollokan"],
  BRAND_BRAVADO: ["mpcarhud", "bravado", "bravado"],
  BRAND_BRUTE: ["mpcarhud", "brute", "brute"],
  BRAND_BUCKINGHAM: ["mpcarhud", "buckingham", "buckingham"],
  BRAND_CANIS: ["mpcarhud", "canis", "canis"],
  BRAND_CHARIOT: ["mpcarhud", "chariot", "chariot"],
  BRAND_CHEVAL: ["mpcarhud", "cheval", "cheval"],
  BRAND_CLASSIQUE: ["mpcarhud", "classique", "classique"],
  BRAND_COIL: ["mpcarhud", "coil", "coil"],
  BRAND_DECLASSE: ["mpcarhud", "declasse", "declasse"],
  BRAND_DEWBAUCHEE: ["mpcarhud", "dewbauchee", "dewbauchee"],
  BRAND_DILETTANTE: ["mpcarhud", "dilettante", "dilettante"],
  BRAND_DINKA: ["mpcarhud", "dinka", "dinka"],
  BRAND_DUNDREARY: ["mpcarhud", "dundreary", "dundreary"],
  BRAND_EMPORER: ["mpcarhud", "emporer", "emporer"],
  BRAND_ENUS: ["mpcarhud", "enus", "enus"],
  BRAND_FATHOM: ["mpcarhud", "fathom", "fathom"],
  BRAND_GALIVANTER: ["mpcarhud", "galivanter", "galivanter"],
  BRAND_GROTTI: ["mpcarhud", "grotti", "grotti"],
  BRAND_HIJAK: ["mpcarhud", "hijak", "hijak"],
  BRAND_HVY: ["mpcarhud", "hvy", "hvy"],
  BRAND_IMPONTE: ["mpcarhud", "imponte", "imponte"],
  BRAND_INVETERO: ["mpcarhud", "invetero", "invetero"],
  BRAND_JACKSHEEPE: ["mpcarhud", "jacksheepe", "jacksheepe"],
  BRAND_JOBUILT: ["mpcarhud", "jobuilt", "jobuilt"],
  BRAND_KARIN: ["mpcarhud", "karin", "karin"],
  BRAND_LAMPADATI: ["mpcarhud", "lampadati", "lampadati"],
  BRAND_MAIBATSU: ["mpcarhud", "maibatsu", "maibatsu"],
  BRAND_MAMMOTH: ["mpcarhud", "mammoth", "mammoth"],
  BRAND_MTL: ["mpcarhud", "mtl", "mtl"],
  BRAND_NAGASAKI: ["mpcarhud", "nagasaki", "nagasaki"],
  BRAND_OBEY: ["mpcarhud", "obey", "obey"],
  BRAND_OCELOT: ["mpcarhud", "ocelot", "ocelot"],
  BRAND_OVERFLOD: ["mpcarhud", "overflod", "overflod"],
  BRAND_PED: ["mpcarhud", "ped", "ped"],
  BRAND_PEGASSI: ["mpcarhud", "pegassi", "pegassi"],
  BRAND_PFISTER: ["mpcarhud", "pfister", "pfister"],
  BRAND_PRINCIPE: ["mpcarhud", "principe", "principe"],
  BRAND_PROGEN: ["mpcarhud", "progen", "progen"],
  BRAND_SCHYSTER: ["mpcarhud", "schyster", "schyster"],
  BRAND_SHITZU: ["mpcarhud", "shitzu", "shitzu"],
  BRAND_SPEEDOPHILE: ["mpcarhud", "speedophile", "speedophile"],
  BRAND_STANLEY: ["mpcarhud", "stanley", "stanley"],
  BRAND_TRUFFADE: ["mpcarhud", "truffade", "truffade"],
  BRAND_UBERMACHT: ["mpcarhud", "ubermacht", "ubermacht"],
  BRAND_VAPID: ["mpcarhud", "vapid", "vapid"],
  BRAND_VULCAR: ["mpcarhud", "vulcar", "vulcar"],
  BRAND_WEENY: ["mpcarhud", "weeny", "weeny"],
  BRAND_WESTERN: ["mpcarhud", "western", "western"],
  BRAND_WESTERNMOTORCYCLE: ["mpcarhud", "westernmotorcycle", "westernmotorcycle"],
  BRAND_WILLARD: ["mpcarhud", "willard", "willard"],
  BRAND_ZIRCONIUM: ["mpcarhud", "zirconium", "zirconium"],
  BRAND_GROTTI2: ["mpcarhud2", "grotti_2", "grotti_2"],
  BRAND_LCC: ["mpcarhud2", "lcc", "lcc"],
  BRAND_PROGEN2: ["mpcarhud2", "progen", "progen"],
  BRAND_RUNE: ["mpcarhud2", "rune", "rune"],
  INFO: ["shared", "info_icon_32", "info_icon_32"],
};
export function iconSource(name: string, selected: boolean): string | undefined {
  // Normalized: the Lua emits both 'warning'/'lock'/'tick' and their uppercase
  // spellings, and the lowercase ones used to miss this table entirely, which
  // made those icons render as nothing at all.
  const icon = icons[name.toUpperCase()];
  return icon && `https://nui-img/${icon[0]}/${icon[selected ? 2 : 1]}`;
}
// A texture dictionary that this build cannot serve fails once and then fails for
// every row that names it, so the miss is remembered process-wide rather than
// re-requested on each render. Keyed by txd/txn, since a dictionary can be
// present while one sprite in it is not.
const missing = new Set<string>();

export function MenuIcon(props: { name: string; selected: boolean }) {
  // aria-label is the raw catalog name, not the lucide name: the accessible name
  // is the contract the parity specs match on.
  const glyph = () => lucideFor(props.name.toUpperCase());
  const source = createMemo(() => iconSource(props.name, props.selected));
  // The failed URL, not a boolean: a row's icon changes as the selection moves
  // and on selection alone, so a flag would strand a working icon behind one
  // earlier miss.
  const [failedUrl, setFailedUrl] = createSignal<string>();
  const broken = () => {
    const url = source();
    return !url || missing.has(url) || failedUrl() === url;
  };
  return (
    <Show when={props.name.toUpperCase() !== "NONE" && Boolean(source())}>
      {/* nui-img resolves against the game's own texture dictionaries, and a build
        that lacks one answers with an error rather than an image. Left alone that
        renders as a broken-image box with the raw catalog name beside it, so the
        lucide glyph stands in instead. */}
      <Show
        when={inGame && !broken()}
        fallback={
          <Dynamic component={glyph()} class="row-icon" role="img" aria-label={props.name} />
        }
      >
        <img
          class="row-icon"
          src={source()}
          alt={props.name}
          onError={() => {
            const url = source();
            if (url) {
              missing.add(url);
              setFailedUrl(url);
            }
          }}
        />
      </Show>
    </Show>
  );
}
