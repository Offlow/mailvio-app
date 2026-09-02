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

### A. Het blok "Is dit reclame?" — OPGELOST (02-09, avond)
- [x] "Bekijken" werkt nu altijd. De oorzaak: na elke hertekening van het
      dashboard werd op elke knop opnieuw een luisteraar gezet. Ververste het
      scherm net terwijl jij klikte, dan was die knop al vervangen door een
      nieuwe zonder luisteraar — en gebeurde er niets. Nu luistert het scherm
      zelf, en werkt elke knop, ook eentje die een seconde geleden nog niet
      bestond.
- [x] Rechtsklikken werkt nu ook op die kaarten: archiveren, verwijderen,
      naar een map verplaatsen.
- [x] "Echte mail" is GROEN, "Reclame" is ROOD. Geen blauw meer.

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
- [x] Die vlag wordt nu ook gebruikt: staat er uitdrukkelijk "hier hoeft geen
      antwoord op", dan valt de mail uit "vandaag te beantwoorden", uit "later
      deze week" en uit "blijft al langer liggen". Mails van vóór dit bestond
      blijven staan tot ze opnieuw beoordeeld zijn. *(02-09)*

### E. Mails van jezelf aan jezelf — OPGELOST
- [x] Mail van info@daklo.be naar info@daklo.be komt in je BESTAANDE
      to-dolijst. Geen nieuw scherm, geen nieuwe regel.

### F. Zien waarop je al geantwoord hebt — OPGELOST
- [x] Groen "✓ Beantwoord" naast elke mail waar via Mailvio een antwoord op
      vertrokken is — in de lijst én bovenaan de mail zelf. Dat is iets anders
      dan afvinken: afvinken zegt "hier moet ik niets mee", beantwoord zegt
      "er is een antwoord vertrokken".
- [x] Zo'n mail verdwijnt meteen uit Aanvragen en uit je openstaande zaken.

### G. Knop "Nieuwe mail" — OPGELOST
- [x] Groter, met een potlood in plaats van de envelop.

### H. "Mogelijk te verwijderen" — OPGELOST
- [x] Er komt veel meer in, vooral oude mails.
- [x] Gesorteerd van nieuw naar oud, met een knop om het om te draaien.

### D. LUCY (boekhouding)
- [x] Alles van de boekhouding krijgt "aanvraag: false" en "antwoordNodig: false"
      en verdwijnt uit de aanvragen *(03-09)*
- [x] Automatisch naar een map verplaatsen kan nu. Bij Automatisering is er een
      nieuwe actie "verplaats naar map": zet een regel op "als de afzender LUCY
      bevat → verplaats naar Boekhouding" en dat gebeurt vanaf dan vanzelf, op
      de achtergrond. Bewust GEEN standaardregel: jij zet hem aan, zodat er nooit
      buiten je weten mail verhuist. *(02-09)*

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

---

## 14. Weergave van mails (02-09, avond)

**Afbeeldingen.** Ze stonden standaard UIT: bij elke mail kreeg je eerst een
balk "externe afbeeldingen zijn geblokkeerd". Bij een nieuwsbrief die vooral uit
beeld bestaat zag je dan een leeg wit vlak, en bij een gewone mail verdwenen de
logo's en icoontjes. Nu laden ze altijd meteen. Wil je het toch anders, dan zet
je het uit bij Instellingen → Weergave van mails.

**Marge rondom.** De inhoud plakte tegen de rand van het venster: bovenaan wat
lucht, links en rechts niets. Nu staat er aan alle vier de kanten dezelfde
marge (20 boven en onder, 22 links en rechts), en staat de mail in een kader met
ronde hoeken — als een blad papier in plaats van een uitgeknipt stuk. Een mail
zonder opmaak krijgt precies dezelfde marge.

## 15. Tests na deze ronde (02-09, avond)

- browsertest als een mens: **87 geslaagd, 0 gefaald** (vier nieuwe: marge
  rondom, "Echte mail" groen, "Reclame" rood, en "Bekijken" werkt ook na een
  hertekening)
- openen 9/9 · voorrang 8/8 · sync 8/8 · bewaren 5/5 · AI 26/26 · kosten 7/7 ·
  mappen 3/3

---

## 16. De haperingen van 16 seconden — oorzaak gevonden (03-09, nacht)

Op de LIVE server gemeten, niet in een test: de server stond geregeld
**16,7 seconden** volledig stil tijdens "nieuwe mails ophalen" en
"gelezen-status nakijken". Zo lang staat dan ALLES stil, ook je klik. Toen ik
in je browser een nieuwsbrief opendeed, bleef het venster leeg en reageerde de
pagina zelfs helemaal niet meer.

**De oorzaak.** Er pasten maar twee mappen tegelijk in het geheugen van de
server, en op de achtergrond lopen je 102 mappen één voor één langs. Je INBOX
werd daardoor telkens weer uit het geheugen gegooid en moest bij het
eerstvolgende gebruik opnieuw van schijf gelezen en ontleed worden — een
bestand met 11.688 mails. Bij het nakijken van de gelezen-status gebeurde dat
zestig keer na elkaar.

**Wat er nu gebeurt:**
- De inbox blijft altijd in het geheugen staan. Die wordt nooit meer
  weggegooid voor een achtergrondmap.
- De gelezen-status wordt in één keer bijgewerkt in plaats van zestig keer
  apart.
- En een echte fout gevonden: het ophalen van de gelezen-status gaf door een
  verkeerd geplaatste `return` NOOIT iets terug. Gelezen/ongelezen werd dus in
  feite nooit bijgewerkt.

## 17. Afbeeldingen stonden uit door een ander vinkje (03-09, nacht)

De instelling "afbeeldingen altijd laden" stond op je account op UIT. Niet
omdat je dat gekozen had: het vakje in de instellingen werd leeg getoond zolang
de server dat veld nog niet meestuurde, en sloeg je dan een heel andere
instelling op, dan werd het als "uit" mee weggeschreven. Dat vakje staat nu
standaard aangevinkt, en ik heb het op je account weer aangezet.

## 18. Tests na deze ronde (03-09, nacht)

- browsertest als een mens: **91 geslaagd, 0 gefaald**. Nieuw erbij: een
  nieuwsbrief zoals ze écht gemaakt worden (alles in tabellen, opmaak in de
  head, verborgen voorproefje vooraan) wordt nu binnenin het venster nagekeken:
  staat er tekst, staan de tabellen er, staan de beelden er, en is het venster
  even hoog als de mail.
- openen 9/9 · voorrang 8/8 · sync 8/8 · bewaren 5/5 · AI 26/26 · kosten 7/7 ·
  mappen 3/3
