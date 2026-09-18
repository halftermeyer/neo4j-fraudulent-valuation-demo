# Rule provenance — where R1–R9 come from

Each row: (a) the signal in the customer's scoping brief (`inputs/prompt.md`) the rule
formalises, (b) the public source it echoes, (c) the exact provision or finding (quoted
≤ 15 words, linked), (d) a status label.

**Thresholds and SLAs are indicative placeholders everywhere** (`params_json` in
`inputs/control_obligations.csv`, editable in the Policy panel). No numeric value below
is regulation-derived; the sources anchor the *existence* of the control, never its
calibration. "Regulation-informed" is used only for rows whose status is *regulatory
requirement* or *supervisory guidance*.

Every quote below was verified against the linked text on 2026-09-18 (not from memory).

| Rule | Scoping signal it formalises | Public source it echoes | Provision / finding (verbatim, ≤ 15 words) | Status |
|---|---|---|---|---|
| **R1** Methodology pre-approval | "skipped Approval" around a `MethodologyChange`; "governance (… approvals …) fails to catch it" | Fed/OCC [SR 11-7](https://www.federalreserve.gov/supervisionreg/srletters/sr1107.htm), *Guidance on Model Risk Management*, §V (Validation) | "The range and rigor of validation activities conducted prior to first use of a model" | supervisory guidance |
| **R2** Post-change IPV | "missing IPVReview" after a methodology change; IPV failing to catch drift from fair value | [CRR Art. 105(8)](https://lexparency.org/eu/CRR/ART_105/), Regulation (EU) No 575/2013 | "Verification of market prices and model inputs shall be performed … at least monthly" | regulatory requirement |
| **R3** Override beyond tolerance | `PriceOverride` — "marks moved away from quotes"; methodology "drifts from fair value" | [Senate PSI report](https://www.hsgac.senate.gov/wp-content/uploads/imo/media/doc/REPORT%20-%20JPMorgan%20Chase%20Whale%20Trades%20(4-12-13).pdf), *JPMorgan Chase Whale Trades* (2013), Recommendation 3 | "deviations from midpoint prices … to be quantified, explained, and, if appropriate, investigated" | public case finding |
| **R4** Recurring overrides | recurrence of `PriceOverride` on one position — the conjunction, not the single event | [Senate PSI report](https://www.hsgac.senate.gov/wp-content/uploads/imo/media/doc/REPORT%20-%20JPMorgan%20Chase%20Whale%20Trades%20(4-12-13).pdf), Recommendation 3 (windowed review) | "deviations from midpoint prices over the course of a month" | public case finding |
| **R5** IPV divergence resolution | IPV divergence left unresolved; "escalation" failing to fire | [CRR Art. 105(8)](https://lexparency.org/eu/CRR/ART_105/) (independence of the verifying unit) | "performed by a person or unit independent from persons or units that benefit" | regulatory requirement |
| **R6** Persistent unexplained P&L | `PnLSignal` — "unexplained P&L — each one small", persistence below single-alert thresholds | [Senate PSI report](https://www.hsgac.senate.gov/wp-content/uploads/imo/media/doc/REPORT%20-%20JPMorgan%20Chase%20Whale%20Trades%20(4-12-13).pdf), Finding of fact 3 ("Hid Massive Losses") | "hid over $660 million in losses in the Synthetic Credit Portfolio for several months" | public case finding |
| **R7** Periodic review of illiquids | "a trader's illiquid bond position"; `MAPReview` as the periodic control | Fed/OCC [SR 11-7](https://www.federalreserve.gov/supervisionreg/srletters/sr1107.htm), §V (ongoing monitoring) | "periodic review—at least annually but more frequently if warranted—of each model" | supervisory guidance |
| **R8** Segregation of duties | "approval-chain shape" as a first-class `:RiskAttribute`; desk head approving own desk's overrides | [CRR Art. 105(2)](https://lexparency.org/eu/CRR/ART_105/) (valuation reporting lines) | "reporting lines … clear and independent of the front office" | regulatory requirement |
| **R9** Documentary evidence | `Evidence` / `EVIDENCED_BY` in the target schema — controls must leave a trace | [CRR Art. 105(2)(a)](https://lexparency.org/eu/CRR/ART_105/) | "documented policies and procedures for the process of valuation" | regulatory requirement |

## Secondary echoes (verified, kept out of the table for one-row-per-rule)

- **R5 / R3 case echo** — PSI Finding of fact 3: "supporting reviews which exposed the
  SCP's questionable pricing practices but upheld the suspect values" — the IPV-divergence-
  not-resolved failure mode R5 formalises.
- **R8 industry frame** — IIA, [*The Three Lines Model*](https://www.theiia.org/globalassets/documents/resources/the-iias-three-lines-model-an-update-of-the-three-lines-of-defense-july-2020/three-lines-model-updated-english.pdf)
  (2020, update of the three lines of defence), Principle 5: "independence from the
  responsibilities of management is critical to its objectivity, authority, and credibility"
  — status: **industry practice, not a rule**.
- **R8 / R9 case echo** — [SEC press release 2013-187](https://www.sec.gov/newsroom/press-releases/2013-187)
  (JPMorgan admits wrongdoing, $200M penalty): the valuation control group was "woefully
  ineffective and insufficiently independent from the traders it was supposed to police";
  "woefully deficient accounting controls in the CIO, including spreadsheet miscalculations".
- **R3 enforcement echo** — [SEC press release 2013-154](https://www.sec.gov/news/press-release/2013-154):
  fraud charges against two former traders for mismarking the same book (no quote used;
  cited as the enforcement companion to the PSI findings).

## Notes

- **SR 11-7 supersession.** On 17 April 2026 the Fed/OCC/FDIC issued
  [SR 26-2](https://www.federalreserve.gov/supervisionreg/srletters/SR2602.htm), which
  "supersedes and replaces SR letter 11-7". The R1/R7 quotes above are from SR 11-7, the
  text in force during the 2012 case and the reference the industry still names; treat
  them as historical guidance wording, to be re-anchored on SR 26-2 with the customer.
- **EBA RTS on prudent valuation** (Commission Delegated Regulation (EU) 2016/101) was
  checked and **not used**: it calibrates additional valuation adjustments (AVAs), and no
  provision maps to R2/R5's IPV timing more specifically than CRR Art. 105(8) itself.
- The status labels feed the **Source** column of the Policy panel
  (`app/src/content/rules_provenance.json` mirrors this table; keep both in sync).
