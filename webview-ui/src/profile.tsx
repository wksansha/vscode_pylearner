import React from "react";
import ReactDOM from "react-dom/client";
import { ProfilePanel } from "./components/ProfilePanel";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ProfilePanel />
  </React.StrictMode>
);
