import Dialog from "@/components/Dialog";
import Menu from "@/components/Menu";
import Toast from "@/components/Toast";

// Theme store initializes its NUI listeners on import
import "@/stores/theme-store";

export default function App() {
  return (
    <>
      <Menu />
      <Dialog />
      <Toast />
    </>
  );
}
