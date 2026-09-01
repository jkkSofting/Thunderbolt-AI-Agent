# Thunderstorm — Kurzzusammenfassung (KI-Kontext / Baseline)

**Thunderstorm** ist eine VS Code Extension (TypeScript, `vscode.lm`-API + GitHub Copilot als Modell-Backend), die aus einer Ticket-Beschreibung automatisiert Code-Änderungen generiert, verifiziert und als Pull Request vorbereitet.

## Kernkonzept

Eine frei konfigurierbare Stufenkette (`thunderstorm.pipeline.stages` in `settings.json`, beliebige Länge, in Sidebar oder JSON editierbar) statt fest einprogrammierter Schritte. Drei Stufentypen:

- **`ai`** — KI-Aufruf mit eigenem Prompt/Modell, optional Datei-Tools (`list_files`/`read_file`/`write_file`) zur selbstständigen Workspace-Exploration statt statischem Kontext-Snapshot. Optionales **Gate**: KI liefert zusätzlich `{ok, feedback, details}`; bei `ok:false` entweder Pause für manuelles Feedback oder automatischer Rücksprung zu einer früheren Stufe (begrenzte Retry-Anzahl).
- **`gitPr`** — rein mechanisch: committet auf Branch, versucht PR-Erstellung via `gh` CLI (Fallback: lokaler Commit falls kein Remote/Rechte/`gh`).
- **`userApproval`** — manuelles Gate, pausiert immer, nie automatisch übersprungen.

## Prompt-Platzhalter

In `ai`-Stufen verfügbar: `{{ticket}}`, `{{context}}` (alle bisherigen Stufenergebnisse), `{{lastResult}}` (nur letzte Stufe), `{{fileChanges}}` (kumulativer Diff), `{{workspaceContext}}` (Dateibaum/offene Editoren), `{{additionalInfo}}` (Gate-Feedback/Nutzereingabe, akkumuliert über mehrere Runden).

## Standard-Pipeline (5 Stufen)

Anforderungsanalyse (Gate, pausiert bei Unklarheit) → Implementierung (Read/Write-Tools) → Verifizierung (Gate, Auto-Retry zurück zu Implementierung) → Pull Request → Nutzer-Abnahme.

## Auto-Modus

Checkbox überspringt `requireApproval`-Pausen bei erfolgreichen `ai`-Stufen automatisch. Echte Entscheidungspunkte (Gate mit `onFail:pause`, ausgeschöpfte Retries, Fehler, `userApproval`) pausieren trotzdem immer.

## Abbruch

„Sofort" (bricht laufende Anfrage/Git-Op ab) vs. „Nach aktueller Stufe" (aktuelle Stufe läuft zu Ende, danach Stopp; rücknehmbar). Bereits geschriebene Dateiänderungen bleiben erhalten.

## Verbrauchsanzeige

Zeigt Anzahl KI-Anfragen (reale Copilot-„premium request"-Einheit) + grobe Token-Schätzung via `LanguageModelChat.countTokens` (keine echten Abrechnungsdaten verfügbar). Reset pro Durchlauf.

## Verlauf/Debug

Sidebar-Tab zeigt jede KI-Anfrage (Input/Output) des laufenden Fensters. Debug-Modus zusätzlich: Modell, vollständiger Prompt, alle Tool-Aufrufe inkl. Ergebnisse, Rohantwort — einsehbar im Verlauf-Eintrag und im Output-Channel „Thunderstorm".

## Voraussetzungen

VS Code ≥1.95, GitHub Copilot + Copilot Chat (aktives Abo), optional `gh` CLI für Auto-PR.

## Stand

Version 0.6.2, `publisher: thunderstorm-local` (privates/lokales Projekt, nicht im Marketplace veröffentlicht).
