# Neuron-Plugin für OpenCode einrichten

## Voraussetzungen

- OpenCode ist installiert.
- Node.js 20 oder neuer ist installiert.
- Du hast einen Neuron-API-Key.

## 1. Plugin konfigurieren

```sh
npx @noser-engineering/opencode-plugin-neuron setup --global
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
npx @noser-engineering/opencode-plugin-neuron setup --global \
  --name "Neuron Arbeit" \
  --url https://litellm.example.com/v1 \
  --key sk-dein-key
```

Damit der Key nicht in der Shell-History landet, stattdessen:

```sh
NEURON_API_KEY=sk-dein-key npx @noser-engineering/opencode-plugin-neuron setup --global \
  --name "Neuron Arbeit" --url https://litellm.example.com/v1
```

Der Befehl kann jederzeit erneut ausgeführt werden; ein bestehendes Profil wird dabei aktualisiert.

## 2. OpenCode neu starten

OpenCode vollständig beenden und neu starten. Danach `/models` ausführen und ein Modell unter dem eingerichteten Neuron-Profil auswählen.

## 3. Was das Plugin sonst noch tut

Ab Version 0.3.0 sperrt das Plugin Provider, die niemand eingetragen hat.

Das ist kein Schikane-Feature. OpenCode lädt einen Provider automatisch, sobald irgendein Zugangsdatum dafür existiert — ein `ANTHROPIC_API_KEY`, der noch von einem anderen Mandat in deiner Shell steht, reicht. Im Modellwähler steht dann ein Endpoint, den für die Daten dieses Projekts niemand freigegeben hat. Genau das verhindert das Plugin.

Ausserdem wird `/share` abgeschaltet (das würde die Konversation samt Codeausschnitten auf opencode.ai veröffentlichen) und die automatische Aktualisierung auf „nur benachrichtigen" gestellt.

**Wichtig:** Was du bewusst in `opencode.json` einträgst, bleibt erlaubt. Die Sperre trifft nur, was du nie genannt hast.

### Kundenaccount verwenden

Wenn du für ein Projekt einen freigegebenen Kundenaccount nutzen darfst, trägst du ihn ins **Projekt**-`opencode.json` ein — also in die Datei im Projektverzeichnis, nicht in die globale:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": {}
  }
}
```

Mehr braucht es nicht. Der Key kommt wie gewohnt über `opencode auth login`.

Zwei Gründe für genau diese Form:

- **Native Provider-ID verwenden**, also `anthropic`, `openai`, `azure` — nicht `kunde-xy`. Nur bei einer nativen ID erbt OpenCode die Modell-Metadaten aus models.dev: Modellliste, Kontextlimits, Kosten und Fähigkeiten kommen dann automatisch. Unter einem Fantasienamen musst du jedes Modell mit allen Angaben von Hand pflegen.
- **Ins Projekt, nicht global.** So gilt die Freigabe für das Mandat, für das sie erteilt wurde, und wandert nicht ins nächste Projekt mit.

Der leere Block `{}` genügt, weil damit nur die Freigabe ausgesprochen wird; alles Weitere kommt aus models.dev.

## Probleme

- `401 Unauthorized`: API-Key prüfen und das Setup erneut ausführen.
- Plugin wird nicht gefunden: Node.js/npm-Version prüfen und den Befehl erneut ausführen.
- Modelle fehlen: OpenCode neu starten; die Modellliste wird beim Start geladen.
- Ein Provider, den du bisher genutzt hast, ist verschwunden: Er wurde nie in `opencode.json` eingetragen, sondern lief über automatisch geladene Zugangsdaten. Ist er für dieses Projekt freigegeben, trag ihn ein wie oben unter „Kundenaccount verwenden". Ist er es nicht, hat die Sperre ihre Arbeit getan.
- OpenCode stürzt beim Start ab mit `Expected ConfigV2.Experimental.Policy, got {...}`: Du hattest 0.3.0 installiert, bevor der Fehler in 0.3.1 behoben wurde. OpenCode cached installierte Plugin-Pakete und lädt sie nicht automatisch neu, nur weil eine neuere Version auf npm liegt. Cache einmal löschen, dann Setup erneut ausführen:

  ```sh
  rm -rf ~/.cache/opencode/packages/@noser-engineering/opencode-plugin-neuron*
  ```
