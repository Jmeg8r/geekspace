import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { convex } from "./lib/convex";
import App from "./App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { AppCrash } from "./components/common/ViewError";
import "./styles/index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConvexProvider client={convex}>
      <ErrorBoundary
        onError={(error) => console.error("Geekspace failed to render", error)}
        fallback={(error) => <AppCrash error={error} />}
      >
        <App />
      </ErrorBoundary>
    </ConvexProvider>
  </React.StrictMode>
);
