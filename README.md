# CK — commandes Bénin / Togo

Application JavaScript avec serveur Node.js pour enregistrer des commandes, calculer les frais de transport, contacter le service par WhatsApp et suivre les livraisons.

## Démarrage

1. Installez Node.js 18 ou une version plus récente.
2. Dans `.env`, configurez `ADMIN_USERNAME`, un `ADMIN_PASSWORD` d'au moins 12 caractères, `SUPABASE_URL` et `SUPABASE_SECRET_KEY`. Ajoutez `GEMINI_API_KEY` pour activer la reconnaissance photo ; sans cette clé, les noms restent saisissables manuellement. Une ancienne clé Supabase `service_role` peut être fournie avec le nom `SUPABASE_SERVICE_ROLE_KEY`.
3. Exécutez `supabase-schema.sql` dans l'éditeur SQL. Il crée les tables `ck_users`, `ck_sessions` et `ck_orders`, afin de ne pas toucher à d'éventuelles tables `orders` déjà utilisées par un autre service.
4. Dans un terminal, exécutez `npm install`, puis `npm start`.
5. Ouvrez `http://localhost:3000`. Connectez-vous avec les identifiants administrateur définis dans `.env`.

Les comptes, sessions et commandes sont stockés dans les tables CK de Supabase. Les images téléversées restent dans le dossier local `uploads/`. Les anciennes données de `data/orders.sqlite` ne sont pas migrées automatiquement.

## Fonctionnement

- Après connexion, les clients accèdent à trois pages : « Accueil », « Mes commandes » et « Commander ». La page « Commander » s'ouvre par défaut et la navigation est conservée dans l'adresse du navigateur.
- L'administrateur se connecte depuis `/admin` avec `ADMIN_USERNAME` et `ADMIN_PASSWORD` configurés dans `.env`. Un compte client ne peut pas accéder au tableau de bord.
- La page d'accueil propose des liens directs vers Alibaba, AliExpress, Amazon et Temu, avec leurs icônes de site enregistrées localement. Chaque colis reçoit une référence unique de type `REL-000001`, visible dans le suivi ; le message WhatsApp de demande contient cette référence.
- Les clients créent un compte avec un nom d'utilisateur et un mot de passe, ajoutent les produits et les coordonnées de livraison. Google Gemini suggère le nom du produit à partir de la photo ; le client doit le vérifier. Les photos envoyées sont transmises à Google pour reconnaissance. Le prix client est facultatif et indicatif.
- L'adresse se choisit sur une carte plein écran en noir et blanc. L'utilisateur peut déplacer le repère ou coller un lien Google Maps, Apple Plans ou OpenStreetMap ; un lien contenant des coordonnées recentre automatiquement la carte. Les tuiles sont fournies par OpenStreetMap et la recherche d'adresse par Nominatim.
- L'image peut être téléversée (JPG, PNG, WEBP, 4 Mo maximum) ou fournie par URL.
- La commande se remplit en trois étapes : produits, adresse de livraison, puis vérification du récapitulatif. Le lien « Rechercher ce produit sur Google » ouvre une recherche Google ciblant les articles Alibaba ; le prix fourni par le client est facultatif et indicatif.
- À l'envoi, une fenêtre explique que le montant fourni ne vaut pas devis. La demande est enregistrée et WhatsApp s'ouvre avec sa référence. Bénin : +229 97 15 84 84 ; Togo : +228 90 29 00 81.
- Depuis `/admin`, l'administrateur indique le devis final en FCFA et l'enregistre pour ouvrir WhatsApp avec un message prérempli au client. Après vérification manuelle du paiement, il passe le statut à « Votre colis est en commande », puis à « Commandée auprès du fournisseur » une fois l'achat réellement passé. Les autres étapes sont « Dans l'avion », « Arrivé au pays » et « Livré ».
- Les clients voient le devis et les changements de statut avec une actualisation automatique toutes les 20 secondes. Le site ne traite pas directement les paiements.

## Repères de frais pour établir un devis

Ces repères ne sont pas calculés automatiquement et ne constituent pas le devis final. L'administrateur vérifie les produits et saisit le prix final en FCFA, transport compris. Les règles indicatives configurées sont :

- Jusqu'à 100 € inclus : forfait fixe de 6 600 FCFA pour le Bénin.
- Plus de 100 € jusqu'à 5 000 € inclus : 10 % du montant converti en FCFA.
- Au-delà de 5 000 € : 7 % du montant converti en FCFA.
- Pour le Togo, 2 points de pourcentage sont ajoutés au taux applicable (12 % ou 9 %). Dans la tranche forfaitaire, le supplément de 2 % sur le forfait porte les frais à 7 920 FCFA.

Le client ne voit pas de total automatique : le montant définitif lui est communiqué par devis WhatsApp.

## Mise en ligne

Configurez l'application derrière HTTPS avant de la rendre accessible sur Internet. La clé Secret Supabase doit rester uniquement dans les variables du serveur ; ne la placez jamais dans le navigateur ni dans le dépôt. Sauvegardez la base Supabase et le dossier `uploads/`.
