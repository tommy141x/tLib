import Dialog from "@/components/Dialog";
import MarketplacePanel from "@/components/MarketplacePanel";
import Toast from "@/components/Toast";
import LayoutEditor from "@/layout/LayoutEditor";
import Menu from "@/menu/Menu";

// Side-effect import: registers theme-store's NUI listeners.
import "@/stores/theme-store";
// Side-effect import: registers shared/motion's setMotion listener, shared by every animating consumer.
import "@tlib/shared/motion";

export default function App() {
  return (
    <>
      <Menu />
      <Dialog />
      <MarketplacePanel />
      <Toast />
      <LayoutEditor />
    </>
  );
}
