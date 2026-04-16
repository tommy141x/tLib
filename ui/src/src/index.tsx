import "virtual:uno.css";
import "./global.css";
import { render } from "solid-js/web";
import App from "./App";
import { fetchNui } from "@/lib/nui";

render(() => <App />, document.getElementById("root")!);

// All NUI event listeners are now registered. Signal Lua so it can flush
// any SendNUIMessage calls that were buffered while the page was loading.
fetchNui("__tlib_nui_ready");
