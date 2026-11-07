# CK — commandes Bénin / Togo

Application JavaScript avec serveur Node.js pour enregistrer des commandes, préparer les devis, contacter le service par WhatsApp et suivre les livraisons.

## Démarrage

1. Installez Node.js 18 ou une version plus récente.
2. Dans `.env`, configurez `ADMIN_USERNAME`, un `ADMIN_PASSWORD` d'au moins 12 caractères, `SUPABASE_URL` et `SUPABASE_SECRET_KEY`. Ajoutez `GEMINI_API_KEY` pour activer la reconnaissance photo ; sans cette clé, les noms restent saisissables manuellement. Une ancienne clé Supabase `service_role` peut être fournie avec le nom `SUPABASE_SERVICE_ROLE_KEY`.
3. Exécutez `supabase-schema.sql` dans l'éditeur SQL. Il crée les tables `ck_users`, `ck_sessions` et `ck_orders`, les colonnes de suivi de paiement et les buckets Storage requis, afin de ne pas toucher à d'éventuelles tables `orders` déjà utilisées par un autre service. Réexécutez le script après une mise à jour qui modifie le schéma.
4. Dans un terminal, exécutez `npm install`, puis `npm start`.
5. Ouvrez `http://localhost:3000`. Connectez-vous avec les identifiants administrateur définis dans `.env`.

Les comptes, sessions, commandes, photos de produits et preuves de paiement sont stockés dans Supabase. Le bucket `ck-product-images` est public ; les reçus de paiement sont gardés dans le bucket privé `ck-payment-proofs`. Si un bucket manque, le serveur tente de le créer lors du premier téléversement (seul le serveur utilise la clé secrète). Les anciennes données de `data/orders.sqlite` et les images du dossier local `uploads/` ne sont pas migrées automatiquement.

## Fonctionnement

- Après connexion, les clients accèdent à « Accueil », « Mes commandes », « Commander » et « Aide ». La page « Commander » s'ouvre par défaut et la navigation est conservée dans l'adresse du navigateur.
- L'administrateur se connecte depuis `/admin` avec `ADMIN_USERNAME` et `ADMIN_PASSWORD` configurés dans `.env`. Un compte client ne peut pas accéder au tableau de bord.
- La page d'accueil propose des liens directs vers Alibaba, AliExpress, Amazon et Temu, avec leurs icônes de site enregistrées localement. Chaque colis reçoit une référence unique de type `REL-000001`, visible dans le suivi ; le message WhatsApp de demande contient cette référence.
- Les clients créent un compte avec un nom d'utilisateur et un mot de passe, ajoutent les produits et les coordonnées de livraison. Google Gemini suggère le nom du produit à partir de la photo ; le client doit le vérifier. Les photos envoyées sont transmises à Google pour reconnaissance. Le prix client est facultatif et indicatif.
- L'adresse se choisit sur une carte plein écran MapLibre GL utilisant le style Positron d'OpenFreeMap. L'utilisateur peut se géolocaliser, déplacer le repère ou coller un lien Google Maps, Apple Plans ou OpenStreetMap ; un lien contenant des coordonnées recentre automatiquement la carte. Les données cartographiques viennent d'OpenFreeMap/OpenStreetMap et la recherche d'adresse de Nominatim.
- L'image peut être téléversée (JPG, PNG, WEBP, 4 Mo maximum) ou fournie par URL.
- La commande se remplit en trois étapes : produits, adresse de livraison, puis vérification du récapitulatif. Le lien « Rechercher ce produit sur Google » ouvre une recherche Google ciblant les articles Alibaba ; le prix fourni par le client est facultatif et indicatif.
- À l'envoi, une fenêtre explique que le montant fourni ne vaut pas devis. Après l'enregistrement, une page de confirmation affiche le récapitulatif du colis et un bouton prépare le message WhatsApp avec sa référence. Bénin : +229 97 15 84 84 ; Togo : +228 90 29 00 81.
- Depuis `/admin`, l'administrateur indique le devis final en FCFA et l'enregistre pour ouvrir WhatsApp avec un message prérempli au client. Après vérification manuelle du paiement, il passe le statut à « Votre colis est en commande », puis à « Commandée auprès du fournisseur » une fois l'achat réellement passé. Les autres étapes sont « Dans l'avion », « Arrivé au pays » et « Livré ».
- L'espace admin comprend des compteurs, une recherche par référence ou téléphone, une liste des paiements à vérifier et les commandes en préparation fournisseur. Le client peut transmettre une preuve de paiement (JPG, PNG, WEBP ou PDF, 5 Mo maximum) ; le reçu reste privé et l'administrateur y accède avec un lien temporaire. Le site ne traite pas directement les paiements.
- Les clients voient le devis et les changements de statut avec une actualisation automatique toutes les 20 secondes. Avant de démarrer la commande fournisseur, le paiement doit être vérifié par l'administrateur. Une FAQ et un avertissement non bloquant sur les produits potentiellement soumis à des restrictions douanières sont disponibles.
- Les tarifs de transport au poids ou au volume ne sont pas estimés automatiquement : les tarifs réels du transitaire ne sont pas configurés. L'administrateur saisit le devis final.

## Repères de frais pour établir un devis

Ces repères ne sont pas calculés automatiquement et ne constituent pas le devis final. L'administrateur vérifie les produits et saisit le prix final en FCFA, transport compris. Les règles indicatives configurées sont :

- Jusqu'à 100 € inclus : forfait fixe de 6 600 FCFA pour le Bénin.
- Plus de 100 € jusqu'à 5 000 € inclus : 10 % du montant converti en FCFA.
- Au-delà de 5 000 € : 7 % du montant converti en FCFA.
- Pour le Togo, 2 points de pourcentage sont ajoutés au taux applicable (12 % ou 9 %). Dans la tranche forfaitaire, le supplément de 2 % sur le forfait porte les frais à 7 920 FCFA.

Le client ne voit pas de total automatique : le montant définitif lui est communiqué par devis WhatsApp.

## Mise en ligne

Configurez l'application derrière HTTPS avant de la rendre accessible sur Internet. Après avoir déployé une version qui ajoute ou modifie des colonnes, exécutez `supabase-schema.sql` dans Supabase avant de redéployer le serveur. La clé Secret Supabase doit rester uniquement dans les variables du serveur ; ne la placez jamais dans le navigateur ni dans le dépôt. Sauvegardez la base Supabase et les buckets `ck-product-images` et `ck-payment-proofs`.
