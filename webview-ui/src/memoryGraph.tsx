import React from "react";
import ReactDOM from "react-dom/client";
import { MemoryGraphPanel } from "./components/MemoryGraphPanel";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryGraphPanel />
  </React.StrictMode>
);
