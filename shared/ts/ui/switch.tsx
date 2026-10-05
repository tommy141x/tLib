import { Switch as ArkSwitch } from "@ark-ui/solid/switch";
import { cn } from "@tlib/shared/cn";
import type { JSX } from "@solidjs/web";
import type { Component } from "solid-js";
import { createUniqueId } from "solid-js";

type SwitchProps = {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (details: { checked: boolean }) => void;
  disabled?: boolean;
  invalid?: boolean;
  readOnly?: boolean;
  required?: boolean;
  name?: string;
  value?: string | number;
  form?: string;
  id?: string;
  class?: string;
  children?: JSX.Element;
};

export const Switch: Component<SwitchProps> = (props) => {
  // Generate a unique ID if not provided
  const switchId = props.id || createUniqueId();

  return (
    <ArkSwitch.Root
      checked={props.checked}
      defaultChecked={props.defaultChecked}
      onCheckedChange={props.onCheckedChange}
      disabled={props.disabled}
      invalid={props.invalid}
      readOnly={props.readOnly}
      required={props.required}
      name={props.name}
      value={props.value}
      form={props.form}
      id={switchId}
      class={cn("inline-flex items-center gap-2 cursor-pointer", props.class)}
    >
      <ArkSwitch.Control class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-[color,background-color,border-color,text-decoration-color,fill,stroke,outline-color] duration-200 ease-in-out outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring/40 focus-visible:-outline-offset-1 disabled:cursor-not-allowed data-[disabled]:opacity-60 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input">
        <ArkSwitch.Thumb class="pointer-events-none block h-5 w-5 rounded-full bg-background transition-transform duration-200 ease-in-out data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
      </ArkSwitch.Control>
      <ArkSwitch.Label class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
        {props.children}
      </ArkSwitch.Label>
      <ArkSwitch.HiddenInput />
    </ArkSwitch.Root>
  );
};

export default Switch;
