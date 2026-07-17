# Neuron-Plugin für OpenCode einrichten

## Voraussetzungen

- OpenCode ist installiert.
- Node.js 20 oder neuer ist installiert.
- Du hast einen Neuron-API-Key.

## 1. Plugin konfigurieren

```sh
npx opencode-plugin-neuron setup --global
```

Der Assistent fragt nach:

- Anzeigename, zum Beispiel `Neuron Arbeit`
- Provider-ID, zum Beispiel `neuron-arbeit`
- LiteLLM-URL; für Neuron einfach den Vorschlagswert übernehmen
- Neuron-API-Key
- Optional weiteren Profilen mit eigenen API-Keys

Der Key wird sicher in den OpenCode-Zugangsdaten und nicht in `opencode.json` gespeichert.

## 2. OpenCode neu starten

OpenCode vollständig beenden und neu starten. Danach `/models` ausführen und ein Modell unter dem eingerichteten Neuron-Profil auswählen.

## Probleme

- `401 Unauthorized`: API-Key prüfen und das Setup erneut ausführen.
- Plugin wird nicht gefunden: Node.js/npm-Version prüfen und den Befehl erneut ausführen.
- Modelle fehlen: OpenCode neu starten; die Modellliste wird beim Start geladen.
