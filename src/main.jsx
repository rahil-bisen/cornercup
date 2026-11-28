import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";


import DefaultCafe from "./pages/DefaultCafe.jsx";
import Landing from "./pages/Landing.jsx";
import Menu from "./pages/Menu.jsx";
import OrderStatus from "./pages/OrderStatus.jsx";
import Legal from "./pages/Legal.jsx";

// The staff screens (and the QR-code library only they use) load when they are opened, so a guest on a
// slow phone connection downloads just the menu, cart and tracking code.
const Admin = lazy(() => import("./pages/Admin.jsx"));
const Operator = lazy(() => import("./pages/Operator.jsx"));

function StaffScreen({ children }) {
  return (
    <Suspense
      fallback={
        <main className="page-narrow" aria-busy="true">
          <p className="muted center">Loading…</p>
        </main>
      }
    >
      {children}
    </Suspense>
  );
}

// One deployment serves every café: everything a guest or an owner can touch lives under /c/:slug,
// and the only deployment-wide screen is the operator console that creates them.
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DefaultCafe />} />
        <Route
          path="/operator"
          element={
            <StaffScreen>
              <Operator />
            </StaffScreen>
          }
        />

        <Route path="/c/:slug" element={<Landing />} />
        {/* A ?table=N link opens the same menu; without a table the page asks for one. */}
        <Route path="/c/:slug/menu" element={<Menu />} />
        <Route path="/c/:slug/t/:tableId" element={<Menu />} />
        <Route path="/c/:slug/t/:tableId/order/:orderId" element={<OrderStatus />} />
        {/* Counter-service orders have no table, so they get their own order URL. */}
        <Route path="/c/:slug/order/:orderId" element={<OrderStatus />} />
        <Route
          path="/c/:slug/owner"
          element={
            <StaffScreen>
              <Admin />
            </StaffScreen>
          }
        />
        <Route
          path="/c/:slug/admin"
          element={
            <StaffScreen>
              <Admin />
            </StaffScreen>
          }
        />
        <Route path="/c/:slug/:legal" element={<Legal />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
