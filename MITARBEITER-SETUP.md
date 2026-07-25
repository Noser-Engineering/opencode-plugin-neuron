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
- LiteLLM-URL deines Teams
- Neuron-API-Key
- Optional weiteren Profilen mit eigenen API-Keys

Die technische Provider-ID wird automatisch aus dem Anzeigenamen erzeugt. Sie erscheint später als Präfix vor dem Modellnamen, zum Beispiel `neuron-arbeit/modell-name`.

Der Key wird sicher in den OpenCode-Zugangsdaten und nicht in `opencode.json` gespeichert.

### Ohne Rückfragen

Wer alles schon weiss, gibt es direkt mit an — dann läuft das Setup ohne eine einzige Frage durch:

```sh
npx opencode-plugin-neuron setup --global \
  --name "Neuron Arbeit" \
  --url https://litellm.example.com/v1 \
  --key sk-dein-key
```

Damit der Key nicht in der Shell-History landet, stattdessen:

```sh
NEURON_API_KEY=sk-dein-key npx opencode-plugin-neuron setup --global \
  --name "Neuron Arbeit" --url https://litellm.example.com/v1
```

Der Befehl kann jederzeit erneut ausgeführt werden; ein bestehendes Profil wird dabei aktualisiert.

## 2. OpenCode neu starten

OpenCode vollständig beenden und neu starten. Danach `/models` ausführen und ein Modell unter dem eingerichteten Neuron-Profil auswählen.

## Probleme

- `401 Unauthorized`: API-Key prüfen und das Setup erneut ausführen.
- Plugin wird nicht gefunden: Node.js/npm-Version prüfen und den Befehl erneut ausführen.
- Modelle fehlen: OpenCode neu starten; die Modellliste wird beim Start geladen.
