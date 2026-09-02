# Mailvio — wensen en openstaande punten

Bijgehouden sinds 2 september 2026. Alles wat Silvio vraagt komt hier eerst in,
zodat er niets verloren gaat. Afgewerkte punten blijven staan met een vinkje en
de datum, zodat je kan terugzien wat er wanneer veranderd is.

---

## Nu in behandeling

### 1. Antwoord op het dashboard — opmaak, wegklikken, versturen
- [x] Antwoord met echte opmaak in plaats van sterretjes en streepjes *(02-09)*
- [x] Kruisje om het antwoord weg te klikken *(02-09)*
- [x] Knop "Als mail versturen": zet het antwoord meteen in het opstelvenster,
      zonder opmaaktekens, met adres en onderwerp er al ingevuld *(02-09)*
- [x] Knop om het antwoord te kopiëren *(02-09)*
- [x] Spraakknop naast het vraagveld, in het Vlaams *(02-09)*

### 2. Het voorgestelde antwoord bij een mail
- [x] Knop "Volledig scherm" — schrijven over de hele breedte *(02-09)*
- [x] Schrijfvak bijna dubbel zo hoog *(02-09)*
- [x] Geen ruwe opmaaktekens meer in het voorstel *(02-09)*
- [x] Handtekening staat er altijd al onder en is zichtbaar *(02-09)*
- [x] Voorstel wordt al klaargezet vóór je de mail opent (recentste 250) *(02-09)*
- [x] Voorstel blijft bewaard op schijf, ook na verversen *(02-09)*

### 3. Aanvragen bevat te veel
- [x] Bevestigingen van formulieren die je zelf invult vallen eruit
      ("bedankt voor je aanvraag", "we hebben je bericht ontvangen", ...) *(02-09)*
- [x] Leveranciers, boekhouder, bank en overheid komen er niet meer in *(02-09)*

### 4. Reclame
- [x] Verplaats je een mail naar Reclame, dan wordt die afzender voortaan
      altijd als reclame herkend *(02-09)*
- [x] Mails die zelf een volledig html-document zijn, verloren hun opmaak —
      de kern wordt er nu netjes uitgehaald *(02-09)*
- [x] Klik je bij "Is dit reclame?" op ✓ of ✗, dan verdwijnt de kaart meteen *(02-09)*

### 5. Snelheid en lange mails
- [x] Server stond seconden stil bij elke aanvraag — 23 s → 35 ms *(02-09)*
- [x] Achtergrondwerk neemt niet meer de hele processor in *(02-09)*
- [x] Opstarthapering van 1,2 s weg *(02-09)*
- [x] Zoeken naar "wat moet er nog ingeladen worden" werd trager naarmate er
      meer ingeladen was — opgelost *(02-09)*
- [x] Voorstel van een antwoord haalde de mail opnieuw van de mailserver in
      plaats van uit de cache *(02-09)*
- [x] Mails groeiden eindeloos door: het venster mat zichzelf en werd daardoor
      steeds hoger *(02-09)*
- [x] Lange gesprekken staan ingeklapt achter "Vorige berichten tonen" *(02-09)*
- [x] Het inladen brak af zodra jij iets deed — en omdat je de app gebruikt,
      kwam het nooit verder dan een paar procent. Nu wacht het even en gaat het
      daarna verder. Gemeten: 7% → 100% in 90 seconden druk klikken *(02-09)*
- [x] Het inladen stond helemaal achteraan de grote achtergrondronde en kwam
      amper aan de beurt; het heeft nu zijn eigen ritme *(02-09)*

---

## Afgewerkt

- [x] "Is dit reclame?" liep helemaal vast (Maximum call stack size exceeded) *(02-09)*
- [x] Mails die leeg openden worden opnieuw opgehaald *(02-09)*
- [x] Verspilde AI-oproepen bij een leeg antwoord *(02-09)*
- [x] De AI kreeg het e-mailadres van de afzender nooit te zien *(02-09)*
- [x] Beoordeling gebeurt vóór het inladen van alle mailinhoud *(02-09)*
- [x] Waar je stond in de inbox, blijf je staan *(02-09)*
- [x] Meter in de app (`/api/snelheid`) die zegt waaraan traagheid ligt *(02-09)*

---

## Nog te bespreken (eerder voorgesteld, nog niet beslist)

- Een aparte lijst met leads van dakwAIrker
- Offertes met een status: verstuurd → opgevolgd → gewonnen/verloren
- Facturen van LUCY automatisch in de boekhoudmap
- Werfdossiers, gegroepeerd per adres
- Deadlines uit mails automatisch in de agenda

### 7. Rechtsklikmenu
- [x] Archiveren, verwijderen en "dit is reclame" werken en de mail verdwijnt
      meteen uit de lijst *(02-09)*
- [x] Verplaatsen naar je eigen mappen op de mailserver *(02-09)*
- [x] Je springt niet meer terug naar de inbox na een actie *(02-09)*

### 11. HET VOORSTEL MOET KLAARSTAAN VOOR JE DE MAIL OPENT
Silvio heeft dit tien keer gevraagd. Wat er stond en wat er nu is:

Wat er mis was:
- Het klaarzetten van de voorstellen liep mee helemaal ACHTERAAN de grote
  achtergrondronde: eerst alle mappen binnenhalen, dan honderden mails laten
  beoordelen, en dan pas dit. In de praktijk kwam het amper aan de beurt.
- Het brak bovendien af zodra jij iets deed in de app.
- Het voorstel werd enkel in het geheugen gehouden en bij elke verversing
  weggegooid, dus stond het er de volgende keer weer niet.
- Het voorstel haalde de mail opnieuw van de mailserver in plaats van uit de
  eigen cache.

De oplossing (03-09):
- [x] Het klaarzetten heeft nu een EIGEN motor die elke 30 seconden draait, los
      van al de rest.
- [x] Het wacht tot jij klaar bent in plaats van af te breken.
- [x] Voorstellen worden op schijf bewaard (voorstellen.json) en overleven een
      verversing en een herstart.
- [x] Het gebruikt de bewaarde mailinhoud, niet de mailserver.
- [x] 12 per beurt, voor de recentste 250 mails die een antwoord vragen.

Gemeten (klaar-test.js): 148 antwoorden stonden klaar zonder dat er iemand een
mail opende. Een voorstel ophalen duurt 3 tot 4 milliseconden, met actie,
urgentie en een verstuurbaar antwoord erbij.

### 12. Afbeeldingen en logo's
- [x] Afbeeldingen in mails laden nu meteen, ook logo's en iconen. De balk
      "afbeeldingen geblokkeerd" is weg. Uit te zetten bij Instellingen. *(03-09)*

### 13. Zijn de mails nu gecached?
Ja. Gemeten op de live server, drie keer met een half uur ertussen:
0% → 22% → 41%, ongeveer 1% per minuut. Het lukte al die tijd niet omdat de
mailserver de verbinding weigerde (AUTHENTICATIONFAILED); er kón niets
ingeladen worden. Sinds het wachtwoord goed staat, loopt het door.

---

### 14. ZO WEINIG MOGELIJK CREDITS (03-09)
Silvio: er ging al meer dan $5 op. Wat er nu gebeurt:
- [x] Voorstellen worden ALLEEN nog klaargezet bij aanvragen — nergens anders.
      Open je een gewone mail, dan staat er een knop "Toch een antwoord laten
      schrijven"; er gebeurt niets zonder dat jij het vraagt.
- [x] Het goedkope model schrijft de voorstellen op de achtergrond. Enkel als
      JIJ op "Maak een nieuw antwoord" duwt, komt het dure model eraan te pas.
- [x] Van een lange mail gaat hoogstens 6.000 tekens naar de AI in plaats van
      het hele gesprek.
- [x] Vier voorstellen per halve minuut in plaats van twaalf.
- [x] Alleen post van de laatste 45 dagen.
- [x] Een teller die per dag bijhoudt wat het kost, met een DAGGRENS van $1. Is
      die bereikt, dan ligt het achtergrondwerk stil tot morgen; wat jij zelf
      aanklikt gaat altijd door.
- [x] Bij Instellingen staat wat de AI vandaag gekost heeft.
- [x] "AI herschrijven" blijft gewoon bestaan.

### 15. Inspreken loopt niet door (03-09)
- [x] De browser kapte de herkenning af bij elke stilte, waardoor je bericht
      half uitgetypt bleef. Nu loopt het door tot JIJ op de knop duwt, en zie je
      de tekst meelopen terwijl je praat.

---

## LATER — pas oppakken als er tijd over is
Silvio: deze zijn minder belangrijk dan "het voorstel moet klaarstaan".
Niet aan beginnen zolang er iets dringenders is, tenzij hij er zelf om vraagt.

### A. Het blok "Is dit reclame?"
- [ ] Reageert supertraag en gaat niet vooruit
- [ ] "Bekijken" aanklikken werkt meestal niet
- [ ] Rechtsklikken werkt daar ook niet
- [ ] De knop "Echte mail" moet GROEN zijn. Groen en rood in dat blok, nooit blauw

### B. Aanvragen zijn er veel te veel (4.097) — OPGELOST (03-09)
- [x] De AI beslist nu zelf per mail of het een ECHTE aanvraag is, in dezelfde
      oproep waarin ze de mail toch al beoordeelt. Kost dus geen cent extra.
- [x] In de opdracht aan de AI staan de gevallen die eruit moeten: bevestigingen
      van formulieren die hij zelf invulde, "je 3D-model is klaar", logins en
      registratiemails, meldingen van programma's, alles van de boekhouding, en
      offertes die een leverancier hém stuurt.
- [x] Boekhouding, bank en overheid komen sowieso niet meer in de lijst.
- [x] Bij twijfel blijft het er wel in — liever eentje te veel dan een gemiste klant.
- [x] Mails die al beoordeeld waren voordat dit bestond, verdwijnen niet: daar
      geldt de strenge vuistregel tot ze opnieuw beoordeeld worden.

### C. "Vandaag te beantwoorden" staat vol met dingen die geen antwoord vragen
- [x] De AI zet nu per mail "antwoordNodig": zit er een MENS op een antwoord te
      wachten, of is het een automatische melding, bevestiging, factuur,
      documentmelding of login? *(03-09)*
- [ ] Nog te doen: die vlag ook gebruiken om de lijst "vandaag te beantwoorden"
      op te schonen

### E. Mails van jezelf aan jezelf
- [ ] Mail van info@daklo.be naar info@daklo.be zijn je eigen to-do's — die
      horen in de BESTAANDE to-domap, geen nieuw scherm of nieuwe regel

### F. Zien waarop je al geantwoord hebt
- [ ] Een groen vinkje naast mails waarop al geantwoord is. Nu kan je wel
      afvinken, maar je ziet niet of er al een antwoord vertrokken is
- [ ] Zulke mails horen niet meer bij Aanvragen te staan

### G. Knop "Nieuwe mail"
- [ ] Ander icoontje, duidelijker en groter

### H. "Mogelijk te verwijderen"
- [ ] Er mag veel meer in komen, vooral oude mails, zodat de mailbox echt kan
      opruimen
- [ ] Logisch gesorteerd van nieuw naar oud, en omgekeerd te zetten

### D. LUCY (boekhouding)
- [x] Alles van de boekhouding krijgt "aanvraag: false" en "antwoordNodig: false"
      en verdwijnt uit de aanvragen *(03-09)*
- [ ] Nog te doen: automatisch naar een boekhoudmap verplaatsen

---

### 9. Twee mailboxen
- [ ] De twee mailboxen mogen NOOIT verdwijnen en mogen niet verwijderbaar zijn
- [ ] Ze moeten goed samenwerken; mails van allebei samen in één inbox mag
- [x] De foutmelding zegt nu wélke mailbox geweigerd wordt *(02-09)*

### 10. Mailserver (Combell)
- [x] Melding op het scherm wanneer je mailserver de verbinding weigert *(02-09)*
- [x] Knop "Verbinding testen" bij de mailinstellingen *(02-09)*
- [ ] LOPEND: IMAP wordt geweigerd (AUTHENTICATIONFAILED) terwijl webmail werkt

### 8. Spraak
- [x] Spraakknop op het dashboard *(02-09)*
- [x] Spraakknop bij het vraagveld in de inbox *(02-09)*
- [x] Antwoord in de inbox staat nu voluit met opmaak, in plaats van een
      afgekapt melding-balkje van 180 tekens *(02-09)*

---

## 11. Mails inladen — de echte oorzaak gevonden (02-09, avond)

**Klacht:** "het duurt nog steeds tien seconden voor een mail opengaat — dat
heeft niks met de AI te maken."

**Wat er misging (gemeten, niet gegokt):** het inladen op de achtergrond
wachtte tot jij *helemaal niets* deed. En omdat jij de app nu eenmaal
gebruikt, kwam dat moment nooit. Na 40 skips brak het inladen zelfs
helemaal af. Gemeten in de test: 360 van de 1500 mails ingeladen, en daarna
45 seconden lang géén enkele mail erbij zolang er geklikt werd.

**Wat er nu gebeurt:**
- Het inladen loopt gewoon door terwijl jij werkt. Jouw klik gaat sowieso
  vooraan in de rij naar de mailserver — daar was al voor gezorgd — dus
  wachten was nergens voor nodig.
- Ben jij bezig, dan haalt hij kleinere hapjes (10 mails in plaats van 60) in
  plaats van te stoppen.
- Het cijfer op je scherm werd maar één keer per minuut herteld, waardoor het
  minutenlang stil leek te staan. Nu elke tien seconden.

**Gemeten na de wijziging:** 800 van de 800 mails ingeladen binnen 40 seconden
terwijl er 94 keer geklikt werd, met jouw aanvragen 95% onder 31 ms.

## 12. Mappen laden zichzelf in (02-09, avond)

Verzonden, Concepten, Archief, Prullenmand en Ongewenst hebben nu een eigen
motor die ze binnenhaalt zonder dat je erop klikt.

**Gemeten:** 5 van de 5 mappen stonden na 6 seconden klaar
(Verzonden 250 · Concepten 20 · Archief 400 · Prullenmand 90 · Ongewenst 60),
en openen daarna in 3 tot 10 ms.

## 13. Alle tests, één keer achter elkaar (02-09, avond)

- browsertest als een mens: **83 geslaagd, 0 gefaald**
- mappen 3/3 · inladen 2/2 · openen 9/9 · voorrang 8/8 · sync 8/8 ·
  bewaren 5/5 · AI 26/26 · klaarstaan 8/8 · kosten 7/7 · mailfout 7/7
