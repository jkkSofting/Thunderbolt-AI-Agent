# Thunderstorm

Thunderstorm ist eine Visual Studio Code Extension, die aus einer Ticket-Beschreibung automatisiert Code-Änderungen generiert, verifiziert und als Pull Request vorbereitet. Sie fungiert als konfigurierbare KI-Pipeline auf Basis der `vscode.lm`-API (VS Code Language Model API) in Verbindung mit GitHub Copilot und begleitet den Nutzer von der Anforderungsanalyse bis zum fertigen PR.

## Pipeline

1. **Anforderungsanalyse** – die KI bewertet, ob die Ticket-Beschreibung klar und vollständig genug für eine direkte Implementierung ist. Fehlt etwas, kann der Nutzer über ein Textfeld in der Sidebar zusätzliche Informationen nachreichen.
2. **Implementierung und Erklärung** – die KI generiert Code-Änderungen im aktuellen Workspace und liefert eine verständliche Erklärung, was warum geändert wurde.
3. **Verifizierung** – ein erneuter KI-Check prüft die Änderungen gegen die ursprünglichen Anforderungen und meldet Abweichungen.
4. **Pull Request Erstellung** – die Änderungen werden auf einem Branch committet; ist ein Push/PR nicht möglich (fehlende Rechte, kein Remote, GitHub CLI nicht installiert), verbleiben sie als lokaler Commit.
5. **Nutzer-Abnahme** – der Workflow pausiert, damit lokale Tests und eine manuelle Prüfung stattfinden können, bevor der Nutzer final freigibt.

Jeder kritische Schritt erfordert eine explizite Bestätigung über die Sidebar; Code-Reviews laufen über die native VS Code Diff-/Changes-Ansicht.

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

Jeder Schritt ist damit unabhängig in Modellwahl und Prompt konfigurierbar.

## Verpacken

```bash
npx @vscode/vsce package
```

erzeugt eine installierbare `.vsix`-Datei (Tool wird bei Bedarf temporär via `npx` geladen, keine feste Abhängigkeit im Projekt).
