# Thunderstorm

Thunderstorm ist eine Visual Studio Code Extension, die aus einer Ticket-Beschreibung automatisiert Code-Änderungen generiert, verifiziert und als Pull Request vorbereitet. Sie fungiert als konfigurierbare KI-Pipeline auf Basis der `vscode.lm`-API (VS Code Language Model API) in Verbindung mit GitHub Copilot und begleitet den Nutzer von der Anforderungsanalyse bis zum fertigen PR.

## Pipeline

1. **Anforderungsanalyse** – die KI bewertet, ob die Ticket-Beschreibung klar und vollständig genug für eine direkte Implementierung ist. Fehlt etwas, kann der Nutzer über ein Textfeld in der Sidebar zusätzliche Informationen nachreichen.
2. **Implementierung und Erklärung** – die KI generiert Code-Änderungen im aktuellen Workspace und liefert eine verständliche Erklärung, was warum geändert wurde.
3. **Verifizierung** – ein erneuter KI-Check prüft die Änderungen gegen die ursprünglichen Anforderungen und meldet Abweichungen. Findet er welche, startet Thunderstorm Schritt 2 automatisch neu (bis zu `thunderstorm.verification.maxAutoRetries` Versuche) und verifiziert danach erneut – ohne dass der Nutzer jeden Zwischenschritt bestätigen muss. Ist das Limit erreicht, erscheint die manuelle Rückfrage ("Erneut implementieren" / "Trotzdem fortfahren").
4. **Pull Request Erstellung** – die Änderungen werden auf einem Branch committet; ist ein Push/PR nicht möglich (fehlende Rechte, kein Remote, GitHub CLI nicht installiert), verbleiben sie als lokaler Commit.
5. **Nutzer-Abnahme** – der Workflow pausiert, damit lokale Tests und eine manuelle Prüfung stattfinden können, bevor der Nutzer final freigibt.

Jeder kritische Schritt erfordert eine explizite Bestätigung über die Sidebar; Code-Reviews laufen über die native VS Code Diff-/Changes-Ansicht.

Schritt 2 hat außerdem Zugriff auf zwei Tools (`list_files`, `read_file`), mit denen die KI bei Bedarf Dateien im Workspace auflisten und ihren tatsächlichen Inhalt lesen kann – nicht nur den groben Kontext-Schnappschuss (Dateibaum, offene Editoren). Der kumulative Diff über alle Implementierungs-Runden eines Durchlaufs (auch nach "Änderungen anfordern" oder einem automatischen Korrekturversuch) bleibt erhalten, selbst wenn eine Runde nichts an einer bereits geänderten Datei ändert – Schritt 3 sieht so immer den vollständigen Änderungsstand.

### Auto-Modus

Auf dem Startbildschirm lässt sich vor dem Start ein Auto-Modus aktivieren. Sobald Schritt 1 (Anforderungsanalyse) die Ticket-Beschreibung als vollständig einstuft, laufen Schritt 2 (Implementierung) und Schritt 3 (Verifizierung) – inklusive automatischer Korrekturversuche – ohne weitere Bestätigung bis zur Pull-Request-Erstellung durch. Fälle, die eine Entscheidung erfordern (fehlende Anforderungsdetails, nicht behebbare Verifizierungs-Abweichungen nach Ausschöpfen der Korrekturversuche, Fehler), pausieren weiterhin wie gewohnt; Schritt 5 (Nutzer-Abnahme) bleibt immer ein manuelles Gate.

### Abbrechen

Während die Pipeline läuft, zeigt die Sidebar zwei Abbruch-Optionen (auch als Commands verfügbar):

- **Sofort abbrechen** – bricht die gerade laufende KI-Anfrage bzw. Git-Operation sofort ab.
- **Nach aktuellem Schritt abbrechen** – der aktuelle Schritt läuft noch zu Ende (nichts wird verworfen), aber der nächste Schritt (auch ein automatischer Korrekturversuch) wird nicht mehr gestartet. Lässt sich vor Wirksamkeit über „Abbruch zurücknehmen" wieder rückgängig machen.

In beiden Fällen wechselt die Pipeline in den Status „Abgebrochen"; bereits erzeugte Datei-Änderungen bleiben erhalten und lassen sich weiterhin per Diff-Ansicht einsehen.

### Verlauf & Debug-Ausgabe

Der Tab „Verlauf" in der Sidebar zeigt zu jeder KI-Anfrage des laufenden VS-Code-Fensters einen Eintrag: was der Nutzer eingegeben hat (Ticket, zusätzliche Informationen, Änderungswünsche) und was die KI geantwortet hat (Klartext-Ergebnis), neueste zuerst.

Ist der „Debug-Modus" (Checkbox oben rechts) aktiv, wird zusätzlich pro Eintrag der komplette Austausch mit dem Sprachmodell festgehalten – verwendetes Modell, vollständiger Prompt, bei Schritt 2 alle Tool-Aufrufe (`list_files`/`read_file`) inklusive ihrer Ergebnisse, sowie die Rohantwort. Über „Debug-Details anzeigen" ist das direkt im Verlauf-Eintrag einsehbar; parallel läuft dieselbe Information in Klartext auch in den Output-Channel „Thunderstorm" (Befehl „Thunderstorm: Debug-Ausgabe anzeigen" bzw. Klick auf „Debug-Ausgabe"), zum Durchsuchen/Kopieren. Der Debug-Modus lässt sich jederzeit ein-/ausschalten, auch während die Pipeline läuft; er wirkt nur auf ab diesem Zeitpunkt neu aufgezeichnete Einträge.

## Voraussetzungen

- Visual Studio Code ≥ 1.95
- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) und [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) (liefern die Sprachmodelle für `vscode.lm`), mit aktivem Abonnement/Login
- Node.js ≥ 18 für die Entwicklung
- Optional: [GitHub CLI (`gh`)](https://cli.github.com/), authentifiziert, für die automatische Pull-Request-Erstellung

## Entwicklung

```bash
npm install
npm run compile
```

Zum Testen `F5` in VS Code drücken (Task „Run Extension“), um einen Extension Development Host zu starten. Thunderstorm erscheint als eigenes Icon in der Activity Bar.

```bash
npm run watch    # esbuild im Watch-Modus
npm run lint      # ESLint
npm run check-types
```

## Konfiguration

Alle Einstellungen befinden sich unter `thunderstorm.*` in der `settings.json`:

| Einstellung | Beschreibung |
| --- | --- |
| `thunderstorm.models.requirementsCheck.vendor` / `.family` | Modell für Schritt 1 (Anforderungsanalyse) |
| `thunderstorm.models.implementation.vendor` / `.family` | Modell für Schritt 2 (Implementierung) |
| `thunderstorm.models.verification.vendor` / `.family` | Modell für Schritt 3 (Verifizierung) |
| `thunderstorm.prompts.requirementsCheck` | Prompt-Vorlage für Schritt 1 (Platzhalter: `{{ticket}}`, `{{additionalInfo}}`) |
| `thunderstorm.prompts.implementation` | Prompt-Vorlage für Schritt 2 (Platzhalter: `{{ticket}}`, `{{workspaceContext}}`, `{{additionalInfo}}`) |
| `thunderstorm.prompts.verification` | Prompt-Vorlage für Schritt 3 (Platzhalter: `{{ticket}}`, `{{implementationSummary}}`, `{{diff}}`) |
| `thunderstorm.git.baseBranch` | Ziel-Branch für den Pull Request (Standard: `main`) |
| `thunderstorm.git.branchPrefix` | Präfix für automatisch erstellte Branches (Standard: `thunderstorm/`) |
| `thunderstorm.git.autoCreatePullRequest` | Automatische PR-Erstellung über `gh` aktivieren/deaktivieren |
| `thunderstorm.verification.maxAutoRetries` | Anzahl automatischer Korrekturversuche (Schritt 2 ↔ 3), bevor die manuelle Rückfrage erscheint (Standard: `2`, `0` deaktiviert die Automatik) |

Jeder Schritt ist damit unabhängig in Modellwahl und Prompt konfigurierbar.

## Verpacken

```bash
npx @vscode/vsce package
```

erzeugt eine installierbare `.vsix`-Datei (Tool wird bei Bedarf temporär via `npx` geladen, keine feste Abhängigkeit im Projekt).
