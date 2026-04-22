import type { UiManifest } from "./ui-manifest";

// Static manifest registry for tgstudios. Mirrors the runtime manifests
// registered by tRadio2 and tELS at boot — kept in sync manually when
// those consumer manifests change.

const uiRadioManifest: UiManifest = {
  schemaVersion: 1,
  type: "ui-radio",
  label: "Radio Skin",
  states: {
    ln01: { kind: "string", label: "Display Line 1", default: "CH 01", maxLength: 32 },
    ln02: { kind: "string", label: "Display Line 2", default: "CITY PD", maxLength: 32 },
    time: { kind: "string", label: "Clock", default: "12:34" },

    "leds.power":     { kind: "boolean", label: "Power LED",     default: true  },
    "leds.connected": { kind: "boolean", label: "Connected LED", default: true  },
    "leds.transmit":  { kind: "boolean", label: "Transmit LED",  default: false },

    signal:  { kind: "enum", label: "Signal Bars", values: ["hidden", "0", "1", "2", "3", "4", "5"], default: "4" },
    battery: { kind: "enum", label: "Battery",     values: ["hidden", "0", "1", "2", "3", "4", "5", "c"], default: "4" },

    gps:   { kind: "boolean", label: "GPS Indicator",   default: false },
    scan:  { kind: "boolean", label: "Scan Indicator",  default: false },
    trunk: { kind: "boolean", label: "Trunk Indicator", default: false },
    warn:  { kind: "boolean", label: "Warn Indicator",  default: false },

    alertVisible: { kind: "boolean", label: "Alert Visible", default: false },
    alertMessage: { kind: "string",  label: "Alert Message", default: "EMERGENCY" },

    theme: { kind: "enum", label: "Theme", values: ["Dark", "Light"], default: "Dark" },
  },
  events: {
    power:        { label: "Power button" },
    channel_up:   { label: "Channel up" },
    channel_down: { label: "Channel down" },
    volume_up:    { label: "Volume up" },
    volume_down:  { label: "Volume down" },
    ptt:          { label: "Push-to-talk" },
    menu:         { label: "Menu" },
    scan:         { label: "Scan toggle" },
    emergency:    { label: "Emergency" },
  },
  presets: {
    idle: {
      label: "Idle",
      state: {
        ln01: "CH 01", ln02: "DISPATCH",
        "leds.power": true, "leds.connected": true, "leds.transmit": false,
        signal: "4", battery: "4",
        gps: false, scan: false, trunk: false, warn: false,
        alertVisible: false,
      },
    },
    transmitting: {
      label: "Transmitting",
      state: {
        ln01: "CH 01", ln02: "TX",
        "leds.power": true, "leds.connected": true, "leds.transmit": true,
        signal: "5", battery: "3",
      },
    },
    emergency: {
      label: "Emergency",
      state: {
        ln01: "EMERG", ln02: "PANIC",
        "leds.power": true, "leds.connected": true, "leds.transmit": true,
        warn: true, alertVisible: true, alertMessage: "EMERGENCY",
      },
    },
    low_battery: {
      label: "Low battery",
      state: {
        ln01: "CH 07", ln02: "LOW BAT",
        "leds.power": true, "leds.connected": true,
        signal: "2", battery: "1",
      },
    },
    disconnected: {
      label: "Disconnected",
      state: {
        ln01: "NO SIG", ln02: "—",
        "leds.power": true, "leds.connected": false,
        signal: "hidden", battery: "3",
      },
    },
  },
  required: ["leds.power"],
};

const uiTelsHudManifest: UiManifest = {
  schemaVersion: 1,
  type: "ui-tels-hud",
  label: "tELS HUD Layout",
  states: {
    inVehicle: { kind: "boolean", label: "In Vehicle", default: true },

    headlights: { kind: "boolean", label: "Headlights", default: false },
    highbeams:  { kind: "boolean", label: "High Beams", default: false },
    takedown:   { kind: "boolean", label: "Takedown",   default: false },
    rumblerOn:  { kind: "boolean", label: "Rumbler",    default: false },
    sirenOn:    { kind: "boolean", label: "Siren",      default: false },
    auxSirenOn: { kind: "boolean", label: "Aux Siren",  default: false },
    cruise:     { kind: "boolean", label: "Cruise",     default: false },
    presence:   { kind: "boolean", label: "Presence",   default: false },
    hornActive: { kind: "boolean", label: "Horn",       default: false },

    taMode: { kind: "enum", label: "TA Mode", values: ["off", "left", "right", "both"], default: "off" },

    patternName: { kind: "string", label: "Pattern Name", default: "CODE 3" },
    sirenTone:   { kind: "number", label: "Siren Tone",   default: 1, min: 1, max: 32, step: 1 },
    maxStage:    { kind: "number", label: "Max Stage",    default: 3, min: 1, max: 8,  step: 1 },

    "leds.R1": { kind: "color", label: "TA Pip 1", default: { r: 255, g: 96, b: 0, a: 1 } },
    "leds.R2": { kind: "color", label: "TA Pip 2", default: { r: 255, g: 96, b: 0, a: 1 } },
    "leds.R3": { kind: "color", label: "TA Pip 3", default: { r: 255, g: 96, b: 0, a: 1 } },
    "leds.R4": { kind: "color", label: "TA Pip 4", default: { r: 255, g: 96, b: 0, a: 1 } },
    "leds.R5": { kind: "color", label: "TA Pip 5", default: { r: 255, g: 96, b: 0, a: 1 } },
    "leds.R6": { kind: "color", label: "TA Pip 6", default: { r: 255, g: 96, b: 0, a: 1 } },
  },
  events: {
    lights:   { label: "Toggle lights" },
    pattern:  { label: "Cycle pattern" },
    siren:    { label: "Cycle siren" },
    auxSiren: { label: "Aux siren" },
    ta:       { label: "Cycle traffic advisor" },
    horn:     { label: "Horn" },
    takedown: { label: "Takedown" },
    cruise:   { label: "Cruise toggle" },
  },
  presets: {
    parked: {
      label: "Parked",
      state: { inVehicle: true, headlights: false, highbeams: false, sirenOn: false, taMode: "off" },
    },
    patrol: {
      label: "Patrol (lights on)",
      state: { inVehicle: true, headlights: true, patternName: "CODE 3" },
    },
    code3: {
      label: "Code 3",
      state: { inVehicle: true, headlights: true, sirenOn: true, patternName: "CODE 3" },
    },
    traffic_advisor_left: {
      label: "TA left",
      state: { inVehicle: true, taMode: "left", patternName: "TA LEFT" },
    },
    traffic_advisor_right: {
      label: "TA right",
      state: { inVehicle: true, taMode: "right", patternName: "TA RIGHT" },
    },
    takedown: {
      label: "Takedown + high beams",
      state: { inVehicle: true, headlights: true, highbeams: true, takedown: true },
    },
    not_in_vehicle: {
      label: "Out of vehicle",
      state: { inVehicle: false },
    },
  },
  required: ["inVehicle"],
};

export const manifests: Record<string, UiManifest> = {
  "ui-radio":    uiRadioManifest,
  "ui-tels-hud": uiTelsHudManifest,
};
