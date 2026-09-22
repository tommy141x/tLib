// Public data/consumer contract; rendering and native focus stay in their own hosts.
export type HudAnchor = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
export interface HudLayout {
  x: number;
  y: number;
  scale: number;
  visible: boolean;
  anchor: HudAnchor;
}
export interface HudLayoutUpdate {
  id: string;
  layout: HudLayout;
  width: number;
  height: number;
  phase: "restore" | "preview" | "commit" | "rollback";
  editing: boolean;
}
export interface HudLayoutClient {
  attach(id: string, element: HTMLElement, onEdit?: (editing: boolean) => void): () => void;
  ready(): Promise<void>;
}
declare global {
  interface Window {
    /** Provided by https://cfx-nui-tLib/client/ui/assets/hud-layout.js, not this type-only module. */
    tLibHudLayout?: HudLayoutClient;
  }
}
