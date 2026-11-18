import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
// First, so auto follows the system on every screen, the login included.
import "./theme";
import AuthGate from "./AuthGate";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
