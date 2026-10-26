import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AgentWindow } from "./AgentWindow";
import { RadialOverlayApp } from "./radial/RadialOverlayApp";
import { MusicPlayerWindow } from "./components/MusicPlayerWindow";
import "./styles.css";
import "./design-system.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get("window") === "radial" ? <RadialOverlayApp /> : new URLSearchParams(window.location.search).get("window") === "agent" ? <AgentWindow /> : new URLSearchParams(window.location.search).get("window") === "music" ? <MusicPlayerWindow /> : <App />}
  </StrictMode>
);
