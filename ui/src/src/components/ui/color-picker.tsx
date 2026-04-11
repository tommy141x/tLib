import { ColorPicker as ArkColorPicker, parseColor } from "@ark-ui/solid";
import type { Component, ComponentProps, JSX } from "solid-js";
import { For, Show, splitProps } from "solid-js";
import { Portal } from "solid-js/web";
import { Motion, Presence } from "solid-motionone";
import IconPipette from "~icons/lucide/pipette";
import { cn } from "../../lib/cn";
import type { ComponentMeta } from "../../lib/meta";

// Re-export parseColor for convenience
export { parseColor };

type ArkColorPickerRootProps = ComponentProps<typeof ArkColorPicker.Root>;
type ColorValue = ReturnType<typeof parseColor>;

interface ColorPickerProps {
  children?: JSX.Element;
  value?: ColorValue;
  defaultValue?: ColorValue;
  onValueChange?: (details: { value: ColorValue; valueAsString: string }) => void;
  onValueChangeEnd?: (details: { value: ColorValue; valueAsString: string }) => void;
  format?: "rgba" | "hsla" | "hsba";
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  invalid?: boolean;
  name?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (details: { open: boolean }) => void;
  closeOnSelect?: boolean;
  positioning?: ArkColorPickerRootProps["positioning"];
  class?: string;
  label?: JSX.Element;
  showAlpha?: boolean;
  showEyeDropper?: boolean;
  swatches?: string[];
}

export const ColorPicker: Component<ColorPickerProps> & {
  Root: typeof ColorPickerRoot;
  Label: typeof ColorPickerLabel;
  Control: typeof ColorPickerControl;
  Trigger: typeof ColorPickerTrigger;
  ValueText: typeof ColorPickerValueText;
  ValueSwatch: typeof ColorPickerValueSwatch;
  Positioner: typeof ColorPickerPositioner;
  Content: typeof ColorPickerContent;
  Area: typeof ColorPickerArea;
  AreaBackground: typeof ColorPickerAreaBackground;
  AreaThumb: typeof ColorPickerAreaThumb;
  ChannelSlider: typeof ColorPickerChannelSlider;
  ChannelSliderTrack: typeof ColorPickerChannelSliderTrack;
  ChannelSliderThumb: typeof ColorPickerChannelSliderThumb;
  ChannelInput: typeof ColorPickerChannelInput;
  TransparencyGrid: typeof ColorPickerTransparencyGrid;
  SwatchGroup: typeof ColorPickerSwatchGroup;
  SwatchTrigger: typeof ColorPickerSwatchTrigger;
  Swatch: typeof ColorPickerSwatch;
  SwatchIndicator: typeof ColorPickerSwatchIndicator;
  EyeDropperTrigger: typeof ColorPickerEyeDropperTrigger;
  HiddenInput: typeof ColorPickerHiddenInput;
  Context: typeof ArkColorPicker.Context;
} = (props: ColorPickerProps) => {
  const [local, others] = splitProps(props, [
    "children",
    "class",
    "label",
    "showAlpha",
    "showEyeDropper",
    "swatches",
  ]);

  const defaultSwatches = [
    "#ef4444",
    "#f97316",
    "#f59e0b",
    "#eab308",
    "#84cc16",
    "#22c55e",
    "#10b981",
    "#14b8a6",
    "#06b6d4",
    "#0ea5e9",
    "#3b82f6",
    "#6366f1",
    "#8b5cf6",
    "#a855f7",
    "#d946ef",
    "#ec4899",
    "#f43f5e",
  ];

  const swatchColors = () => local.swatches || defaultSwatches;

  return (
    <ArkColorPicker.Root
      class={cn("flex flex-col gap-2", local.class)}
      positioning={{ sameWidth: true, ...others.positioning }}
      {...others}
    >
      {local.label && (
        <ArkColorPicker.Label class="text-sm font-medium leading-none">
          {local.label}
        </ArkColorPicker.Label>
      )}
      <ArkColorPicker.Control class="flex items-center gap-2">
        <ArkColorPicker.ChannelInput
          channel="hex"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-all duration-200 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-invalid:border-destructive"
        />
        <ArkColorPicker.Trigger class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 w-10 p-0 relative overflow-hidden">
          <ArkColorPicker.ValueSwatch class="absolute inset-0 h-full w-full rounded-lg" />
        </ArkColorPicker.Trigger>
      </ArkColorPicker.Control>
      <Portal>
        <ArkColorPicker.Positioner>
          <ArkColorPicker.Context>
            {(context) => {
              const isOpen = () => context().open;

              return (
                <Presence exitBeforeEnter>
                  <Show when={isOpen()}>
                    <Motion.div
                      initial={{ opacity: 0, scale: 0.95, y: -10 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95, y: -10 }}
                      transition={{
                        duration: 0.15,
                        easing: [0.16, 1, 0.3, 1],
                      }}
                    >
                      <ArkColorPicker.Content class="z-50 w-full min-w-[300px] max-w-sm rounded-md border border-border bg-background p-4 shadow-md outline-none">
                        <div class="flex flex-col gap-3">
                          <ArkColorPicker.Area class="h-40 w-full rounded-lg border border-border relative">
                            <div class="absolute inset-0 overflow-hidden rounded-lg">
                              <ArkColorPicker.AreaBackground class="h-full w-full" />
                            </div>
                            <ArkColorPicker.AreaThumb class="h-4 w-4 rounded-full border-2 border-white shadow-md outline-none z-10" />
                          </ArkColorPicker.Area>

                          <div class="flex flex-col gap-2">
                            <ArkColorPicker.ChannelSlider channel="hue">
                              <ArkColorPicker.ChannelSliderTrack class="h-3 rounded-md bg-linear-to-r from-red-500 via-yellow-500 via-green-500 via-cyan-500 via-blue-500 via-purple-500 to-red-500" />
                              <ArkColorPicker.ChannelSliderThumb class="h-4 w-4 rounded-full border-2 border-white shadow-md -translate-x-1/2 -translate-y-1/2" />
                            </ArkColorPicker.ChannelSlider>

                            <Show when={local.showAlpha !== false}>
                              <ArkColorPicker.ChannelSlider channel="alpha">
                                <ArkColorPicker.TransparencyGrid size="8px" class="rounded-md" />
                                <ArkColorPicker.ChannelSliderTrack class="h-3 rounded-md" />
                                <ArkColorPicker.ChannelSliderThumb class="h-4 w-4 rounded-full border-2 border-white shadow-md -translate-x-1/2 -translate-y-1/2" />
                              </ArkColorPicker.ChannelSlider>
                            </Show>
                          </div>

                          <Show when={swatchColors().length > 0}>
                            <ArkColorPicker.SwatchGroup class="flex flex-wrap gap-2">
                              <For each={swatchColors()}>
                                {(color) => (
                                  <ArkColorPicker.SwatchTrigger
                                    value={color}
                                    class="relative h-8 w-8 rounded-md overflow-hidden border border-border cursor-pointer transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                  >
                                    <ArkColorPicker.Swatch value={color} class="h-full w-full" />
                                  </ArkColorPicker.SwatchTrigger>
                                )}
                              </For>
                            </ArkColorPicker.SwatchGroup>
                          </Show>

                          <Show when={local.showEyeDropper !== false}>
                            <ArkColorPicker.EyeDropperTrigger class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3">
                              <IconPipette class="h-4 w-4" />
                              Pick Color
                            </ArkColorPicker.EyeDropperTrigger>
                          </Show>
                        </div>
                      </ArkColorPicker.Content>
                    </Motion.div>
                  </Show>
                </Presence>
              );
            }}
          </ArkColorPicker.Context>
        </ArkColorPicker.Positioner>
      </Portal>
      <ArkColorPicker.HiddenInput />
    </ArkColorPicker.Root>
  );
};

// Composable components
interface ColorPickerRootProps {
  children?: JSX.Element;
  value?: ColorValue;
  defaultValue?: ColorValue;
  onValueChange?: (details: { value: ColorValue; valueAsString: string }) => void;
  onValueChangeEnd?: (details: { value: ColorValue; valueAsString: string }) => void;
  format?: "rgba" | "hsla" | "hsba";
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  invalid?: boolean;
  name?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (details: { open: boolean }) => void;
  closeOnSelect?: boolean;
  positioning?: ArkColorPickerRootProps["positioning"];
  class?: string;
}

const ColorPickerRoot: Component<ColorPickerRootProps> = (props) => {
  return <ArkColorPicker.Root {...props} class={cn("flex flex-col gap-2", props.class)} />;
};

const ColorPickerLabel: Component<{
  children?: JSX.Element;
  class?: string;
}> = (props) => {
  return (
    <ArkColorPicker.Label class={cn("text-sm font-medium leading-none", props.class)}>
      {props.children}
    </ArkColorPicker.Label>
  );
};

const ColorPickerControl: Component<{
  children?: JSX.Element;
  class?: string;
}> = (props) => {
  return (
    <ArkColorPicker.Control class={cn("flex items-center gap-2", props.class)}>
      {props.children}
    </ArkColorPicker.Control>
  );
};

const ColorPickerTrigger: Component<{
  children?: JSX.Element;
  class?: string;
}> = (props) => {
  return (
    <ArkColorPicker.Trigger
      class={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 w-10 p-0 relative overflow-hidden",
        props.class
      )}
    >
      {props.children}
    </ArkColorPicker.Trigger>
  );
};

const ColorPickerValueText: Component<{
  children?: JSX.Element;
  class?: string;
}> = (props) => {
  return (
    <ArkColorPicker.ValueText class={cn("text-sm text-muted-foreground", props.class)}>
      {props.children}
    </ArkColorPicker.ValueText>
  );
};

const ColorPickerValueSwatch: Component<{ class?: string }> = (props) => {
  return (
    <ArkColorPicker.ValueSwatch
      class={cn("absolute inset-0 h-full w-full rounded-lg", props.class)}
    />
  );
};

const ColorPickerPositioner: Component<{
  children?: JSX.Element;
  class?: string;
}> = (props) => {
  return (
    <Portal>
      <ArkColorPicker.Positioner class={props.class}>{props.children}</ArkColorPicker.Positioner>
    </Portal>
  );
};

const ColorPickerContent: Component<{
  children?: JSX.Element;
  class?: string;
}> = (props) => {
  return (
    <ArkColorPicker.Context>
      {(context) => {
        const isOpen = () => context().open;

        return (
          <Presence exitBeforeEnter>
            <Show when={isOpen()}>
              <Motion.div
                initial={{ opacity: 0, scale: 0.95, y: -10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -10 }}
                transition={{
                  duration: 0.15,
                  easing: [0.16, 1, 0.3, 1],
                }}
              >
                <ArkColorPicker.Content
                  class={cn(
                    "z-50 w-full min-w-[300px] max-w-sm rounded-md border border-border bg-background p-4 shadow-md outline-none",
                    props.class
                  )}
                >
                  {props.children}
                </ArkColorPicker.Content>
              </Motion.div>
            </Show>
          </Presence>
        );
      }}
    </ArkColorPicker.Context>
  );
};

const ColorPickerArea: Component<{
  children?: JSX.Element;
  class?: string;
  xChannel?: "hue" | "saturation" | "brightness" | "lightness" | "red" | "green" | "blue";
  yChannel?: "hue" | "saturation" | "brightness" | "lightness" | "red" | "green" | "blue";
}> = (props) => {
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <ArkColorPicker.Area
      class={cn("h-40 w-full rounded-lg border border-border relative", local.class)}
      {...others}
    >
      {local.children}
    </ArkColorPicker.Area>
  );
};

const ColorPickerAreaBackground: Component<{ class?: string }> = (props) => {
  return <ArkColorPicker.AreaBackground class={cn("h-full w-full", props.class)} />;
};

const ColorPickerAreaThumb: Component<{ class?: string }> = (props) => {
  return (
    <ArkColorPicker.AreaThumb
      class={cn(
        "h-4 w-4 rounded-full border-2 border-white shadow-md outline-none z-10",
        props.class
      )}
    />
  );
};

const ColorPickerChannelSlider: Component<{
  children?: JSX.Element;
  channel: "hue" | "saturation" | "brightness" | "lightness" | "red" | "green" | "blue" | "alpha";
  class?: string;
}> = (props) => {
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <ArkColorPicker.ChannelSlider class={cn(local.class)} {...others}>
      {local.children}
    </ArkColorPicker.ChannelSlider>
  );
};

const ColorPickerChannelSliderTrack: Component<{ class?: string }> = (props) => {
  return <ArkColorPicker.ChannelSliderTrack class={cn(props.class)} />;
};

const ColorPickerChannelSliderThumb: Component<{ class?: string }> = (props) => {
  return <ArkColorPicker.ChannelSliderThumb class={cn(props.class)} />;
};

const ColorPickerChannelInput: Component<{
  channel:
    | "hex"
    | "alpha"
    | "hue"
    | "saturation"
    | "brightness"
    | "lightness"
    | "red"
    | "green"
    | "blue";
  class?: string;
}> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <ArkColorPicker.ChannelInput
      class={cn(
        "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-all duration-200 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-invalid:border-destructive",
        local.class
      )}
      {...others}
    />
  );
};

const ColorPickerTransparencyGrid: Component<{
  size?: string;
  class?: string;
}> = (props) => {
  return (
    <ArkColorPicker.TransparencyGrid
      size={props.size || "8px"}
      class={cn("rounded-lg", props.class)}
    />
  );
};

const ColorPickerSwatchGroup: Component<{
  children?: JSX.Element;
  class?: string;
}> = (props) => {
  return (
    <ArkColorPicker.SwatchGroup class={cn("flex flex-wrap gap-2", props.class)}>
      {props.children}
    </ArkColorPicker.SwatchGroup>
  );
};

const ColorPickerSwatchTrigger: Component<{
  children?: JSX.Element;
  value: string;
  disabled?: boolean;
  class?: string;
}> = (props) => {
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <ArkColorPicker.SwatchTrigger
      class={cn(
        "relative h-8 w-8 rounded-md overflow-hidden border border-border cursor-pointer transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed",
        local.class
      )}
      {...others}
    >
      {local.children}
    </ArkColorPicker.SwatchTrigger>
  );
};

const ColorPickerSwatch: Component<{
  children?: JSX.Element;
  value: string;
  class?: string;
}> = (props) => {
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <ArkColorPicker.Swatch class={cn("h-full w-full", local.class)} {...others}>
      {local.children}
    </ArkColorPicker.Swatch>
  );
};

const ColorPickerSwatchIndicator: Component<{
  children?: JSX.Element;
  class?: string;
}> = (props) => {
  return (
    <ArkColorPicker.SwatchIndicator
      class={cn("absolute inset-0 flex items-center justify-center", props.class)}
    >
      {props.children}
    </ArkColorPicker.SwatchIndicator>
  );
};

const ColorPickerEyeDropperTrigger: Component<{
  children?: JSX.Element;
  class?: string;
}> = (props) => {
  return (
    <ArkColorPicker.EyeDropperTrigger
      class={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3",
        props.class
      )}
    >
      {props.children}
    </ArkColorPicker.EyeDropperTrigger>
  );
};

const ColorPickerHiddenInput: Component = () => {
  return <ArkColorPicker.HiddenInput />;
};

// Attach composable components
ColorPicker.Root = ColorPickerRoot;
ColorPicker.Label = ColorPickerLabel;
ColorPicker.Control = ColorPickerControl;
ColorPicker.Trigger = ColorPickerTrigger;
ColorPicker.ValueText = ColorPickerValueText;
ColorPicker.ValueSwatch = ColorPickerValueSwatch;
ColorPicker.Positioner = ColorPickerPositioner;
ColorPicker.Content = ColorPickerContent;
ColorPicker.Area = ColorPickerArea;
ColorPicker.AreaBackground = ColorPickerAreaBackground;
ColorPicker.AreaThumb = ColorPickerAreaThumb;
ColorPicker.ChannelSlider = ColorPickerChannelSlider;
ColorPicker.ChannelSliderTrack = ColorPickerChannelSliderTrack;
ColorPicker.ChannelSliderThumb = ColorPickerChannelSliderThumb;
ColorPicker.ChannelInput = ColorPickerChannelInput;
ColorPicker.TransparencyGrid = ColorPickerTransparencyGrid;
ColorPicker.SwatchGroup = ColorPickerSwatchGroup;
ColorPicker.SwatchTrigger = ColorPickerSwatchTrigger;
ColorPicker.Swatch = ColorPickerSwatch;
ColorPicker.SwatchIndicator = ColorPickerSwatchIndicator;
ColorPicker.EyeDropperTrigger = ColorPickerEyeDropperTrigger;
ColorPicker.HiddenInput = ColorPickerHiddenInput;
ColorPicker.Context = ArkColorPicker.Context;

export const meta: ComponentMeta<ColorPickerProps> = {
  name: "ColorPicker",
  description:
    "A comprehensive color picker component with support for different color formats, alpha channel, and preset swatches. Built on Ark UI ColorPicker.",
  examples: [
    {
      title: "Basic",
      description: "A simple color picker with default settings",
      code: () => {
        return <ColorPicker label="Choose Color" defaultValue={parseColor("#3b82f6")} />;
      },
    },
    {
      title: "Without Alpha",
      description: "Color picker without alpha channel slider",
      code: () => {
        return (
          <ColorPicker
            label="Background Color"
            defaultValue={parseColor("#10b981")}
            showAlpha={false}
          />
        );
      },
    },
    {
      title: "Composable with Custom Swatches",
      description: "Build custom layouts using composable parts with custom preset colors",
      code: () => {
        return (
          <ColorPicker.Root defaultValue={parseColor("#f59e0b")}>
            <ColorPicker.Label>Custom Layout</ColorPicker.Label>
            <ColorPicker.Control>
              <div class="flex gap-2 w-full">
                <ColorPicker.Trigger>
                  <ColorPicker.TransparencyGrid />
                  <ColorPicker.ValueSwatch />
                </ColorPicker.Trigger>
                <ColorPicker.ChannelInput channel="hex" class="flex-1" />
              </div>
            </ColorPicker.Control>
            <ColorPicker.Positioner>
              <ColorPicker.Content>
                <div class="flex flex-col gap-3">
                  <ColorPicker.Area>
                    <ColorPicker.AreaBackground />
                    <ColorPicker.AreaThumb />
                  </ColorPicker.Area>
                  <ColorPicker.ChannelSlider channel="hue">
                    <ColorPicker.ChannelSliderTrack class="h-3 rounded-md bg-linear-to-r from-red-500 via-yellow-500 via-green-500 via-cyan-500 via-blue-500 via-purple-500 to-red-500" />
                    <ColorPicker.ChannelSliderThumb class="h-4 w-4 rounded-full border-2 border-white shadow-md -translate-x-1/2 -translate-y-1/2" />
                  </ColorPicker.ChannelSlider>
                  <ColorPicker.SwatchGroup>
                    <For each={["#ef4444", "#f97316", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899"]}>
                      {(color) => (
                        <ColorPicker.SwatchTrigger value={color}>
                          <ColorPicker.Swatch value={color} />
                        </ColorPicker.SwatchTrigger>
                      )}
                    </For>
                  </ColorPicker.SwatchGroup>
                </div>
              </ColorPicker.Content>
            </ColorPicker.Positioner>
            <ColorPicker.HiddenInput />
          </ColorPicker.Root>
        );
      },
    },
  ],
};

export default ColorPicker;
