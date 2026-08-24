# Thunderstorm

Thunderstorm ist eine Visual Studio Code Extension, die aus einer Ticket-Beschreibung automatisiert Code-Änderungen generiert, verifiziert und als Pull Request vorbereitet. Sie fungiert als konfigurierbare KI-Pipeline auf Basis der `vscode.lm`-API (VS Code Language Model API) in Verbindung mit GitHub Copilot und begleitet den Nutzer von der Anforderungsanalyse bis zum fertigen PR.

## Pipeline

Der Ablauf ist eine frei konfigurierbare **Stufenkette** beliebiger Länge (Tab „Stufen" in der Sidebar bzw. Einstellung `thunderstorm.pipeline.stages`) – keine fest einprogrammierten Schritte. Jede Stufe hat einen von drei Typen:

- **`ai`** – ein KI-Aufruf mit eigenem Prompt und Modell. Kann optionales Datei-Werkzeug (`list_files`/`read_file`/`write_file`) erhalten, um den Workspace selbstständig zu erkunden und Änderungen zu schreiben, statt sich auf eine grobe Kontext-Momentaufnahme zu verlassen. Optional mit **Gate**: Die KI liefert zusätzlich `{"ok": boolean, "feedback": string, "details": string[]}`; bei `ok:false` pausiert die Stufe entweder für eine manuelle Rückmeldung, oder Thunderstorm springt automatisch zu einer früheren Stufe zurück (begrenzte Anzahl an Versuchen), bevor doch eine manuelle Entscheidung nötig wird.
- **`gitPr`** – rein mechanisch: committet die bisherigen Änderungen auf einem Branch und versucht einen Pull Request zu erstellen; ist das nicht möglich (fehlende Rechte, kein Remote, `gh` nicht installiert), verbleiben die Änderungen als lokaler Commit.
- **`userApproval`** – reines manuelles Gate: pausiert mit Hinweistext, bis der Nutzer bestätigt. Wird nie durch den Auto-Modus übersprungen.

Jede `ai`-Stufe erreicht die Werkzeuge und den bisherigen Verlauf über Platzhalter im Prompt: `{{ticket}}` (Ticket-Text), `{{context}}` (alle bisherigen Stufen-Ergebnisse, formatiert), `{{lastResult}}` (nur das direkt vorangegangene Ergebnis), `{{fileChanges}}` (kumulativer Diff aller bisher geschriebenen Dateien), `{{workspaceContext}}` (Dateibaum/offene Editoren, nur falls `includeWorkspaceContext` aktiv) und `{{additionalInfo}}` (Rückmeldung aus einem Gate-Fehlschlag oder einer manuellen Nutzereingabe).

Die mitgelieferte Standard-Konfiguration bildet den klassischen 5-Schritte-Ablauf nach: Anforderungsanalyse (Gate, pausiert bei Unklarheit) → Implementierung (Datei-Lese-/Schreibzugriff) → Verifizierung (Gate, springt bei Abweichungen automatisch zurück zur Implementierung) → Pull Request → Nutzer-Abnahme. Diese Kette lässt sich beliebig erweitern (z. B. eine zusätzliche Security- oder Style-Review-Stufe einfügen), umsortieren, verzweigen (mehrere Gates auf unterschiedliche Ziel-Stufen) oder komplett neu aufbauen.

Jede `ai`-Stufe mit `requireApproval: true` pausiert nach einem erfolgreichen (bzw. Gate-bestandenen) Lauf für „Weiter" oder „Änderungen anfordern" (Freitext-Feedback, führt zu einem erneuten Lauf derselben Stufe); Code-Reviews laufen über die native VS Code Diff-/Changes-Ansicht.

Pausiert eine `ai`-Stufe mit `onFail: pause` auf Rückfrage (z. B. die Anforderungsanalyse bei einer unklaren Ticket-Beschreibung), steht neben dem Feld für zusätzliche Informationen auch „Entwickler soll selbst entscheiden" zur Verfügung: überspringt die Rückfrage, die nächste Stufe bekommt Ticket-Text und alle bislang gegebenen Informationen wie gewohnt, zusätzlich den expliziten Hinweis, offene Punkte selbstständig zu entscheiden statt zu blockieren. Mehrfache Runden „Erneut prüfen" akkumulieren dabei ohnehin – jede spätere Runde sieht alle zuvor gegebenen Informationen, nicht nur die der letzten Runde.

### Auto-Modus

Checkbox auf dem Startbildschirm. Ist sie aktiv, werden `requireApproval`-Pausen bei erfolgreichen `ai`-Stufen automatisch übersprungen (ebenso während eines automatischen Gate-Korrekturversuchs, unabhängig vom Auto-Modus). Fälle, die eine echte Entscheidung brauchen – ein Gate mit `onFail: pause`, ein Gate nach Ausschöpfen der automatischen Versuche, oder ein Fehler – pausieren immer, ebenso jede `userApproval`-Stufe. Damit lässt sich der Auto-Modus nicht dazu missbrauchen, über ungelöste Probleme hinwegzulaufen.

### Abbrechen

Während die Pipeline läuft, zeigt die Sidebar zwei Abbruch-Optionen (auch als Commands verfügbar):

- **Sofort abbrechen** – bricht die gerade laufende KI-Anfrage bzw. Git-Operation sofort ab.
- **Nach aktueller Stufe abbrechen** – die aktuelle Stufe läuft noch zu Ende (nichts wird verworfen), aber die nächste Stufe (auch ein automatischer Gate-Korrekturversuch) wird nicht mehr gestartet. Lässt sich vor Wirksamkeit über „Abbruch zurücknehmen" wieder rückgängig machen.

In beiden Fällen wechselt die Pipeline in den Status „Abgebrochen"; bereits erzeugte Datei-Änderungen bleiben erhalten und lassen sich weiterhin per Diff-Ansicht einsehen.

### Verbrauchsanzeige

Sobald der aktuelle Durchlauf mindestens eine KI-Anfrage gestellt hat, zeigt die Sidebar die Anzahl der Anfragen sowie eine grobe Token-Schätzung (Ein-/Ausgabe, via `LanguageModelChat.countTokens`). Die Anfragen-Zahl ist real (das ist die Einheit, die Copilot als „premium request" abrechnet); die Token-Zahlen sind nur ein ungefährer Anhaltspunkt – `vscode.lm` gibt keinen Zugriff auf echte Abrechnungs-/Credit-Daten, daher wird hier bewusst nichts als „Credits" ausgegeben. Setzt sich pro Durchlauf zurück (bei „Zurücksetzen" oder einem neuen Start).

### Verlauf & Debug-Ausgabe

Der Tab „Verlauf" in der Sidebar zeigt zu jeder KI-Anfrage des laufenden VS-Code-Fensters einen Eintrag: was der Nutzer/die Pipeline eingegeben hat und was die KI geantwortet hat (Klartext-Ergebnis), neueste zuerst.

Ist der „Debug-Modus" (Checkbox oben rechts) aktiv, wird zusätzlich pro Eintrag der komplette Austausch mit dem Sprachmodell festgehalten – verwendetes Modell, vollständiger Prompt, alle Tool-Aufrufe (`list_files`/`read_file`/`write_file`) inklusive ihrer Ergebnisse, sowie die Rohantwort. Über „Debug-Details anzeigen" ist das direkt im Verlauf-Eintrag einsehbar; parallel läuft dieselbe Information in Klartext auch in den Output-Channel „Thunderstorm" (Befehl „Thunderstorm: Debug-Ausgabe anzeigen" bzw. Klick auf „Debug-Ausgabe"), zum Durchsuchen/Kopieren. Der Debug-Modus lässt sich jederzeit ein-/ausschalten, auch während die Pipeline läuft; er wirkt nur auf ab diesem Zeitpunkt neu aufgezeichnete Einträge.

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

Die gesamte Stufenkette steht in der einen Einstellung `thunderstorm.pipeline.stages` (Array) in der `settings.json`. Bearbeitbar wahlweise:

- **In der Sidebar** (Tab „Stufen"): Stufen hinzufügen, duplizieren, löschen, per ↑/↓ umsortieren – wirkt sofort auf `settings.json`. Für Detailänderungen (Prompt-Text, Modell, Gate-Konfiguration) „Als JSON bearbeiten" nutzen.
- **Direkt in `settings.json`**: siehe Feldbeschreibung oben unter [Pipeline](#pipeline) bzw. die `markdownDescription` der Einstellung im Settings-Editor.

Ungültige Stufen (fehlende Pflichtfelder, unbekannter `type`, doppelte `id`) werden beim Speichern verworfen statt die ganze Konfiguration zu blockieren; die Sidebar zeigt dabei eine Warnung. Ist die Einstellung leer oder komplett ungültig, greift die eingebaute 5-Stufen-Standardkette.

Änderungen an der Stufenkette wirken sich erst auf den **nächsten** Start aus, nicht auf einen bereits laufenden Durchlauf.

## Verpacken

```bash
npx @vscode/vsce package
```

erzeugt eine installierbare `.vsix`-Datei (Tool wird bei Bedarf temporär via `npx` geladen, keine feste Abhängigkeit im Projekt).
