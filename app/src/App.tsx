import { Tabs } from "@neo4j-ndl/react";
import { useEffect, useState } from "react";
import "./App.css";
import ChatTab from "./components/ChatTab";
import CompanionPanel from "./components/CompanionPanel";
import ExploreTab from "./components/ExploreTab";
import QueryAuditDrawer from "./components/QueryAuditDrawer";
import ScenariosTab from "./components/ScenariosTab";
import { getCompanionState, onCompanionChange, toggleCompanion } from "./lib/companion";
import { onExploreLink } from "./lib/exploreLink";
import { isGlossaryOn, onGlossaryChange, toggleGlossary } from "./lib/glossary";

type TabId = "explore" | "scenarios" | "assistant";

export default function App() {
  const [tab, setTab] = useState<TabId>("explore");
  const [companionOpen, setCompanionOpen] = useState(getCompanionState().open);

  useEffect(
    () => onCompanionChange(() => setCompanionOpen(getCompanionState().open)),
    [],
  );

  // "open this node in Explore" deep links (Assistant answers, DataGrid ids)
  useEffect(() => onExploreLink(() => setTab("explore")), []);

  const [glossaryOn, setGlossaryOn] = useState(isGlossaryOn());
  useEffect(() => onGlossaryChange(() => setGlossaryOn(isGlossaryOn())), []);

  return (
    <div className={`app-container ${companionOpen ? "companion-open" : ""}`}>
      <header className="app-header">
        <div>
          <h1>Fraudulent Valuation — Mismarking Detection</h1>
          <p className="subtitle">
            The graph does not detect fraud. It detects the conjunction of weak signals
            that fraud leaves behind — a human establishes intent.
          </p>
        </div>
        <div className="header-right">
          <button
            className={`header-companion-toggle ${glossaryOn ? "active" : ""}`}
            onClick={() => toggleGlossary()}
            title="Onboarding aid — off by default, session only"
          >
            Glossary
          </button>
          <button
            className={`header-companion-toggle ${companionOpen ? "active" : ""}`}
            onClick={() => toggleCompanion()}
          >
            ✦ AI companion
          </button>
          <span className="header-badge">Neo4j + GDS · RISK ORM demo</span>
        </div>
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
      <CompanionPanel />
      <QueryAuditDrawer />
    </div>
  );
}
