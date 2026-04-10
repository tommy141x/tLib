import { Progress as ArkProgress } from "@ark-ui/solid/progress";
import { cva, type VariantProps } from "class-variance-authority";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import { type Component, type JSX, Show } from "solid-js";
import { unoMerge } from "unocss-merge";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

const progressVariants = cva("relative flex flex-col gap-3 w-full", {
  variants: {
    variant: {
      linear: "",
      circular: "",
    },
  },
  defaultVariants: {
    variant: "linear",
  },
});

type ProgressProps = {
  value?: number | null;
  defaultValue?: number | null;
  min?: number;
  max?: number;
  onValueChange?: (details: { value: number | null }) => void;
  id?: string;
  class?: string;
  label?: JSX.Element;
  showValue?: boolean;
  size?: number;
  thickness?: number;
  orientation?: "horizontal" | "vertical";
  translations?: {
    value: (details: { value: number | null; max: number }) => string;
  };
} & VariantProps<typeof progressVariants>;

export const Progress: Component<ProgressProps> = (props) => {
  const variant = props.variant || "linear";
  const size = props.size || 120;
  const thickness = props.thickness || 12;
  const height = props.thickness || 8;

  return (
    <ArkProgress.Root
      value={props.value}
      defaultValue={props.defaultValue}
      min={props.min}
      max={props.max}
      onValueChange={props.onValueChange}
      orientation={props.orientation}
      translations={props.translations}
      id={props.id}
      class={cn(progressVariants({ variant }), props.class)}
      style={{
        "--size": `${size}px`,
        "--thickness": `${thickness}px`,
        "--height": `${height}px`,
      }}
    >
      <Show when={props.label || props.showValue}>
        <div class="flex items-center justify-between">
          <Show when={props.label}>
            <ArkProgress.Label class="text-sm font-medium leading-none">
              {props.label}
            </ArkProgress.Label>
          </Show>
          <Show when={props.showValue}>
            <ArkProgress.ValueText class="text-sm text-muted-foreground" />
          </Show>
        </div>
      </Show>
      {variant === "circular" ? (
        <div class="flex items-center justify-center">
          <div class="relative">
            <ArkProgress.Circle
              style={{
                width: "var(--size)",
                height: "var(--size)",
              }}
            >
              <ArkProgress.CircleTrack
                class="text-secondary"
                style={{
                  "--radius": `calc(var(--size) / 2 - var(--thickness) / 2)`,
                }}
                cx={`calc(var(--size) / 2)`}
                cy={`calc(var(--size) / 2)`}
                r="var(--radius)"
                fill="transparent"
                stroke="currentColor"
                stroke-width="var(--thickness)"
              />
              <ArkProgress.CircleRange
                class="text-primary"
                style={{
                  "--radius": `calc(var(--size) / 2 - var(--thickness) / 2)`,
                  "--circumference": "calc(2 * 3.14159 * var(--radius))",
                }}
                cx={`calc(var(--size) / 2)`}
                cy={`calc(var(--size) / 2)`}
                r="var(--radius)"
                fill="transparent"
                stroke="currentColor"
                stroke-width="var(--thickness)"
                stroke-linecap="round"
                stroke-dasharray="var(--circumference)"
                stroke-dashoffset="calc(var(--circumference) * (100 - var(--percent, 0)) / 100)"
                transform="rotate(-90deg)"
                transform-origin="center"
              />
            </ArkProgress.Circle>
            <ArkProgress.Context>
              {(context) => (
                <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div class="text-2xl font-bold text-primary">
                    {context().value !== null ? `${Math.round(context().value ?? 0)}%` : "..."}
                  </div>
                </div>
              )}
            </ArkProgress.Context>
          </div>
        </div>
      ) : (
        <ArkProgress.Context>
          {(context) => (
            <ArkProgress.Track
              class="relative w-full overflow-hidden rounded-full bg-secondary"
              style={{
                height: "var(--height)",
              }}
            >
              <ArkProgress.Range
                class="h-full bg-primary"
                style={{
                  width: `${context().percent}%`,
                }}
              />
            </ArkProgress.Track>
          )}
        </ArkProgress.Context>
      )}
    </ArkProgress.Root>
  );
};

export default Progress;
