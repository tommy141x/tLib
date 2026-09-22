import Dialog from "@/components/Dialog";
import MarketplacePanel from "@/components/MarketplacePanel";
import Toast from "@/components/Toast";
import LayoutEditor from "@/layout/LayoutEditor";
import Menu from "@/menu/Menu";

// Theme store initializes its NUI listeners on import
import "@/stores/theme-store";

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
