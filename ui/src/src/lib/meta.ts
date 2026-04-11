import type { Component } from "solid-js";

export interface ComponentMeta<_P = object> {
  name: string;
  description?: string;
  examples?: {
    title: string;
    description?: string;
    code: Component;
  }[];
}
