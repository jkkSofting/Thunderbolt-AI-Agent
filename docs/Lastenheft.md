# Lastenheft: VS Code Extension "Thunderstorm"

## Projektübersicht
Entwicklung einer Visual Studio Code Extension, die aus einer übergebenen Ticket-Beschreibung automatisiert Code-Änderungen generiert, validiert und als Pull Request vorbereitet. Die Extension fungiert als konfigurierbare KI-Pipeline, die den Nutzer von der initialen Anforderungsanalyse bis zum fertigen PR begleitet.

## Funktionale Anforderungen und Workflow
Die Extension arbeitet eine mehrstufige Pipeline ab. Für jeden dieser Schritte muss über die Extension-Einstellungen (z.B. in der `settings.json` oder einer Config-UI) definierbar sein, wie die Anfrage verarbeitet wird und welches spezifische KI-Modell zum Einsatz kommt.

1. Anforderungsanalyse (Requirements Check)
- Input: Text der Ticket-Beschreibung durch den Nutzer.
- Aufgabe: Die KI bewertet, ob die Beschreibung klar, eindeutig und vollständig genug für eine direkte Implementierung ist.
- Output: Feedback an den Nutzer. Entweder ein Go für den nächsten Schritt oder eine Aufforderung, fehlende Details zu ergänzen.

2. Implementierung und Erklärung
- Aufgabe: Generierung des notwendigen Codes basierend auf dem Ticket und dem aktuellen Workspace-Kontext.
- Output: Die angewandten Code-Änderungen sowie eine verständliche Zusammenfassung und Erklärung, was genau warum geändert wurde.

3. Verifizierung
- Aufgabe: Ein erneuter KI-Check. Ein Modell prüft die in Schritt 2 vorgenommenen Code-Änderungen gegen die ursprünglichen Anforderungen aus Schritt 1.
- Output: Bestätigung, dass die Anforderungen erfüllt sind, oder Identifikation von Abweichungen.

4. Pull Request Erstellung
- Aufgabe: Die bestätigten Änderungen werden in einen Branch gepackt und ein Pull Request wird erstellt (inklusive Titel und Beschreibung aus den vorherigen Schritten).
- Fallback: Sollte es im aktuellen Setup nicht möglich sein, einen PR zu starten (z.B. fehlende Rechte, keine Remote-Anbindung), wird dieser Schritt übersprungen. Die Änderungen verbleiben als lokale Modifikationen.

5. Nutzer-Abnahme (User Verification)
- Aufgabe: Die Extension pausiert den Workflow, sodass der Nutzer die Änderungen lokal validieren kann (Ausführen von Unit Tests, manuelles Ausprobieren). Der Nutzer gibt den Vorgang abschließend frei.

## UX/UI-Design und Interaktionskonzept
Die Benutzeroberfläche muss nativ wirken und den Workflow transparent und steuerbar machen. 

- Hauptansicht: Die Interaktion findet primär in einer dedizierten Sidebar (Webview) statt.
- Workflow-Visualisierung: Der aktuelle Status der Pipeline (Analyse, Implementierung, Verifizierung, PR) wird als vertikaler Stepper oder Akkordeon dargestellt. So ist jederzeit ersichtlich, welcher Schritt gerade aktiv ist.
- Interaktive Freigaben: Jeder kritische Schritt (z.B. nach der Analyse oder vor der PR-Erstellung) erfordert eine Bestätigung des Nutzers über klar erkennbare Call-to-Action-Buttons (z.B. "Weiter", "Änderungen anfordern", "PR erstellen").
- Code-Reviews: Für die Überprüfung der Code-Änderungen sollen keine neuen UI-Elemente erfunden werden. Stattdessen wird die native Diff-Ansicht von VS Code aufgerufen.
- Fehlerbehandlung: Wenn ein Schritt blockiert (z.B. unklare Anforderungen), bietet die UI ein Textfeld in der Sidebar, um zusätzliche Informationen an die KI nachzureichen.

## Technische Vorgaben
- KI-Schnittstelle: Die Kommunikation mit den Sprachmodellen muss zwingend über die offizielle `vscode.lm` API (Language Model API von VS Code) in Verbindung mit GitHub Copilot erfolgen.
- Konfiguration: Die Prompts für die einzelnen Schritte und die Modellauswahl müssen modular austauschbar und für den Nutzer konfigurierbar sein.