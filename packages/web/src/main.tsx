import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { keelApiContract } from "@keel/core";
import { initClient } from "@ts-rest/core";
import { App } from "./App.js";
import { FleetApp } from "./FleetApp.js";
import "./styles.css";

const api = initClient(keelApiContract, { baseUrl: "", baseHeaders: {} });
const ENGINE_ROOM_HASH = "#/engine-room";

/**
 * The Fleet is home once signed in; the original dashboard lives on as the Engine Room
 * (configuration, secrets, Kill Switch, research tools) at #/engine-room.
 */
function Root() {
  const [hash, setHash] = useState(window.location.hash);
  const [session, setSession] = useState<{
    authenticated: boolean;
    username: string | null;
  } | null>(null);

  const refreshSession = useCallback(async () => {
    const res = await api.auth.getSession();
    if (res.status === 200) {
      setSession({ authenticated: res.body.authenticated, username: res.body.username ?? null });
    }
  }, []);

  useEffect(() => {
    void refreshSession();
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [refreshSession]);

  if (hash === ENGINE_ROOM_HASH) {
    return (
      <App
        onExitEngineRoom={() => {
          window.location.hash = "";
          void refreshSession();
        }}
      />
    );
  }
  if (session === null) {
    return null;
  }
  if (!session.authenticated) {
    return <App onSignedIn={() => void refreshSession()} />;
  }
  return (
    <FleetApp
      username={session.username}
      onOpenEngineRoom={() => {
        window.location.hash = ENGINE_ROOM_HASH;
      }}
      onSignedOut={() => setSession({ authenticated: false, username: null })}
    />
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
