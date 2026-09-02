# Mailvio verhuizen naar Fly.io

Dit project bevat nu alles wat nodig is om Mailvio op Fly.io te draaien in plaats van op Render: `Dockerfile`, `.dockerignore` en `fly.toml`. Dat lost meteen twee problemen van het gratis Render-plan op:

- **Geen "opstarten" meer** — de app blijft altijd actief (`min_machines_running = 1`), dus geen trage eerste keer meer per dag.
- **Geen verloren instellingen meer** — je IMAP/SMTP/AI-instellingen komen op een aparte, persistente schijf (Fly Volume) te staan die een herdeploy overleeft.

## Kostprijs (belangrijk om te weten)

Fly.io heeft **geen gratis laag meer** — het is betalen per gebruik, met een creditcard gekoppeld aan je account. Voor deze app, altijd aan:

- Kleinste machine (shared-cpu-1x, 256MB): **≈ $1,94/maand**
- Persistente schijf van 1GB: **≈ $0,15/maand**
- Totaal: **ongeveer $2/maand** (~€1,90), plus het beetje dataverkeer dat de app gebruikt.

Dat is goedkoper dan het betaalde Render-plan (~€6-7/maand) waar we het eerder over hadden, en lost hetzelfde probleem op.

## Stappenplan voor morgen

### 1. Zip uploaden naar GitHub
Zoals gewoonlijk: upload de laatste zip (met `Dockerfile`, `.dockerignore` en `fly.toml` erbij) naar `Offlow/mailvio-app` op GitHub.

### 2. Fly-account en CLI
1. Maak een account op [fly.io](https://fly.io) als je er nog geen hebt (creditcard is verplicht).
2. Installeer de Fly command-line tool (`flyctl`) — op macOS: `brew install flyctl`, op Windows: het installatiescript op fly.io/docs/flyctl. Op Linux: `curl -L https://fly.io/install.sh | sh`.
3. Log in: `fly auth login` (opent je browser).

### 3. App aanmaken
Ga in je terminal naar de map met de Mailvio-bestanden (waar `fly.toml` in staat) en voer uit:

```
fly launch --no-deploy
```

Fly leest automatisch de `fly.toml` die al klaarstaat. Het zal vragen of je de instellingen wil overnemen — zeg ja. Als de naam `mailvio-app` al bezet is, stelt Fly zelf een alternatief voor (bv. `mailvio-app-123`) — dat is geen probleem.

Als er nog geen Volume is aangemaakt, doe dat met:

```
fly volumes create mailvio_data --region ams --size 1
```

(1 GB is ruim voldoende — het gaat om één klein instellingenbestand.)

### 4. Deployen

```
fly deploy
```

Dit bouwt de Docker-container en zet hem live. Na een paar minuten geeft Fly een URL, bv. `https://mailvio-app.fly.dev`.

### 5. Instellingen opnieuw ingeven
Open de nieuwe URL, ga naar Instellingen, en vul je IMAP/SMTP-gegevens en Claude API-sleutel nog één laatste keer in. Vanaf nu blijven ze bewaard bij elke volgende `fly deploy` — dat is precies wat de persistente schijf oplost.

### 6. Render-service
Zodra alles goed draait op Fly.io, kunnen we de oude `mailvio-app`-service op Render stopzetten of verwijderen — laat het weten wanneer je zover bent, dan help ik daarmee. Ik raak die service niet aan zonder dat je dat expliciet vraagt.

### Later, optioneel: eigen domeinnaam
Wil je Mailvio bereikbaar maken via bijvoorbeeld `mail.daklo.be` in plaats van `mailvio-app.fly.dev`, dan kan dat met `fly certs add mail.daklo.be` plus een DNS-wijziging bij Combell. Dat pakken we samen aan zodra deze verhuis achter de rug is — en zeker zonder de bestaande, echte mailconfiguratie van `mail.daklo.be` (die naar `pop3.mailprotect.be` wijst) aan te raken.

## Sources
- [Fly.io Resource Pricing](https://fly.io/docs/about/pricing/)
- [Fly.io App Configuration (fly.toml) reference](https://fly.io/docs/reference/configuration/)
