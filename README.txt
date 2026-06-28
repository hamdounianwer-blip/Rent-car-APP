╔══════════════════════════════════════════════════════╗
║        CITY RENT BARKA — Installation rapide         ║
╚══════════════════════════════════════════════════════╝

PRÉREQUIS
─────────
Node.js doit être installé sur ton PC.
Si ce n'est pas le cas :
  1. Va sur https://nodejs.org
  2. Télécharge la version "LTS" (recommandée)
  3. Installe-la (tout par défaut)

────────────────────────────────────────────────────────
LANCEMENT
─────────
Double-clique sur :  START_SAVE.bat

La PREMIÈRE fois : le programme installe automatiquement
la base de données SQLite (1-2 minutes, internet requis).
Toutes les fois suivantes : démarrage immédiat.

Le navigateur s'ouvre automatiquement sur :
  http://localhost:3000

C'est tout !

────────────────────────────────────────────────────────
MIGRATION AUTOMATIQUE
─────────────────────
Si tu as un ancien fichier data.json, il sera importé
automatiquement dans la base de données au premier
lancement. Un fichier data.json.bak sera conservé
comme sauvegarde de sécurité.

────────────────────────────────────────────────────────
SAUVEGARDE
──────────
Appuie sur le bouton  💾 Save  dans l'application.
Les données sont écrites dans :  cityrent.db

────────────────────────────────────────────────────────
BACKUP MANUEL
─────────────
Copie le fichier  cityrent.db  ailleurs
(clé USB, Google Drive, etc.)

Pour restaurer : remplace le fichier cityrent.db
par ta copie de sauvegarde.

────────────────────────────────────────────────────────
CONTENU DU DOSSIER
──────────────────
  START_SAVE.bat    → double-clic pour démarrer
  server.js         → le serveur (ne pas modifier)
  app.html          → l'application
  cityrent.db       → ta base de données (après 1er Save)
  node_modules/     → dépendances (créé automatiquement)
  videos/           → vidéos des contrats
  attachments/      → pièces jointes (reçus)
  templates/        → modèles de lettres
  README.txt        → ce fichier

────────────────────────────────────────────────────────
AVANTAGES SQLite vs JSON
────────────────────────
  ✅ Plusieurs personnes peuvent utiliser en même temps
  ✅ Données protégées contre la corruption
  ✅ Performance pour des milliers de contrats
  ✅ Backup simple (un seul fichier .db)
  ✅ Base solide pour l'expansion future

────────────────────────────────────────────────────────
