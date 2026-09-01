# Mailvio — eerste werkende versie

Dit is een klein, apart project — losstaand van je andere Render-apps. Het haalt je IMAP-mailbox op, laat de Claude API elke mail indelen (dringend / vandaag / binnenkort / geen actie), en heeft een chatbox om vragen te stellen over je mailbox of een antwoord te laten opstellen.

Dit is bewust een eerste, kleine versie — niet de volledige wireframe met automatiseringen, agenda-koppeling of twee mailboxen. Die bouwen we erbij zodra deze basis goed werkt.

## Wat moet je zelf instellen (in het Render-dashboard van deze service, onder "Environment")

- `IMAP_HOST` — de mailserver van je hostingprovider (bv. `mail.dakwerken-demaeyer.be`, vraag dit na bij je hostingprovider als je het niet weet)
- `IMAP_PORT` — meestal `993`
- `IMAP_USER` — je volledige mailadres
- `IMAP_PASSWORD` — **maak hiervoor een apart app-wachtwoord aan**, gebruik nooit je hoofdwachtwoord
- `ANTHROPIC_API_KEY` — je Claude API-sleutel (aan te maken op console.anthropic.com)

Zonder deze gegevens start de app wel gewoon op, maar toont ze een melding dat de mailbox of de AI nog niet is ingesteld.

## Lokaal testen

```
npm install
cp .env.example .env   # vul je gegevens in
npm start
```

Ga dan naar `http://localhost:10000`.

## Kosten

Met de standaard cache van 5 minuten wordt de mailbox maar opnieuw geclassificeerd als het langer dan 5 minuten geleden is, of als je op "Ververs" klikt — dat houdt het aantal Claude-aanroepen laag.
