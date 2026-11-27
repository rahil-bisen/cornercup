import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";

import { STARTUP_MESSAGE, subscribeStartupStatus } from "./lib/api.js";
import DefaultCafe from "./pages/DefaultCafe.jsx";
import Landing from "./pages/Landing.jsx";
import Menu from "./pages/Menu.jsx";
import OrderStatus from "./pages/OrderStatus.jsx";
import Admin from "./pages/Admin.jsx";
import Legal from "./pages/Legal.jsx";
import Operator from "./pages/Operator.jsx";

function StartupNotice() {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => subscribeStartupStatus(setVisible), []);

  if (!visible) return null;
  return (
    <div className="startup-notice" role="status" aria-live="polite">
      {STARTUP_MESSAGE}
    </div>
  );
}

// One deployment serves every café: everything a guest or an owner can touch lives under /c/:slug,
// and the only deployment-wide screen is the operator console that creates them.
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <StartupNotice />
      <Routes>
        <Route path="/" element={<DefaultCafe />} />
        <Route path="/operator" element={<Operator />} />

        <Route path="/c/:slug" element={<Landing />} />
        {/* A ?table=N link opens the same menu; without a table the page asks for one. */}
        <Route path="/c/:slug/menu" element={<Menu />} />
        <Route path="/c/:slug/t/:tableId" element={<Menu />} />
        <Route path="/c/:slug/t/:tableId/order/:orderId" element={<OrderStatus />} />
        {/* Counter-service orders have no table, so they get their own order URL. */}
        <Route path="/c/:slug/order/:orderId" element={<OrderStatus />} />
        <Route path="/c/:slug/owner" element={<Admin />} />
        <Route path="/c/:slug/admin" element={<Admin />} />
        <Route path="/c/:slug/:legal" element={<Legal />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
