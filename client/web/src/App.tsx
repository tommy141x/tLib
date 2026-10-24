import Dialog from "@/components/Dialog";
import MarketplacePanel from "@/components/MarketplacePanel";
import Toast from "@/components/Toast";
import LayoutEditor from "@/layout/LayoutEditor";
import Menu from "@/menu/Menu";

// Theme store initializes its NUI listeners on import
import "@/stores/theme-store";
// Same, but from `shared/` rather than from this app: every consumer that
// animates anything needs the identical `setMotion` listener, and tLib's own
// page is just the first of them.
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
