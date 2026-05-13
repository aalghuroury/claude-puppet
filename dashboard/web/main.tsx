import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "xterm/css/xterm.css";
import "./index.css";
import App from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
