import { Tabs } from "@neo4j-ndl/react";
import { useState } from "react";
import "./App.css";
import ChatTab from "./components/ChatTab";
import ExploreTab from "./components/ExploreTab";
import QueryAuditDrawer from "./components/QueryAuditDrawer";
import ScenariosTab from "./components/ScenariosTab";

type TabId = "explore" | "scenarios" | "assistant";

export default function App() {
  const [tab, setTab] = useState<TabId>("explore");

  return (
    <div className="app-container">
      <header className="app-header">
        <div>
          <h1>Fraudulent Valuation — Mismarking Detection</h1>
          <p className="subtitle">
            The graph does not detect fraud. It detects the conjunction of weak signals
            that fraud leaves behind — a human establishes intent.
          </p>
        </div>
        <span className="header-badge">Neo4j + GDS · RISK ORM demo</span>
      </header>
      <nav className="app-tabs">
        <Tabs fill="underline" onChange={(t) => setTab(t as TabId)} value={tab}>
          <Tabs.Tab id="explore">Explore</Tabs.Tab>
          <Tabs.Tab id="scenarios">Scenarios</Tabs.Tab>
          <Tabs.Tab id="assistant">Assistant</Tabs.Tab>
        </Tabs>
      </nav>
      <main className="app-main">
        {tab === "explore" && <ExploreTab />}
        {tab === "scenarios" && <ScenariosTab />}
        {tab === "assistant" && <ChatTab />}
      </main>
      <QueryAuditDrawer />
    </div>
  );
}
