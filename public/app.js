import * as maplibregl from "maplibre-gl";

const statusNames = {
  demande_recue: "Liens reçus · panier en préparation",
  devis_envoye: "Panier envoyé · paiement MoMo attendu",
  commande_fournisseur: "Commandé auprès du vendeur",
  recu_france: "Reçu à notre adresse en France",
  en_transit: "En route vers vous",
  arrive: "Arrivé au pays",
  livre: "Livré"
};
const statusOrder = [
  "demande_recue",
  "devis_envoye",
  "commande_fournisseur",
  "recu_france",
  "en_transit",
  "arrive",
  "livre"
];

// Règles tarifaires (identiques à celles du serveur).
const EUR_TO_FCFA = 666;
const AIR_RATE_EUR_PER_KG = 15;
const roundCents = (amount) => Math.round(amount * 100) / 100;
function commissionFor(articlesEur) {
  if (articlesEur < 100) return 10;
  if (articlesEur > 5000) return roundCents(articlesEur * 0.07);
  return roundCents(articlesEur * 0.1);
}
const toFcfa = (amountEur) => Math.round(amountEur * EUR_TO_FCFA);
const eurFormatter = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const formatEur = (amount) => eurFormatter.format(amount);
const formatFcfa = (amount) => `${new Intl.NumberFormat("fr-FR").format(Math.round(amount))} FCFA`;
const shippingModeNames = { avion: "Avion", bateau: "Bateau" };
const $ = (selector) => document.querySelector(selector);
let currentUser = null;
let signupMode = false;
let refreshTimer = null;
let adminOrdersCache = [];
let checkoutStep = 1;
let deliveryMap = null;
let selectedMapPoint = null;
let selectedMapLink = "";
let quoteNoticeConfirmed = false;
const customerPageHashes = {
  home: "#accueil",
  orders: "#mes-commandes",
  order: "#commander",
  faq: "#aide"
};
const paymentStatusNames = {
  not_started: "Paiement non envoyé",
  awaiting_proof: "En attente de paiement",
  proof_received: "Preuve reçue · à vérifier",
  verified: "Paiement vérifié"
};
const isAdminRoute = window.location.pathname.replace(/\/+$/, "") === "/admin";

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Une erreur est survenue.");
    error.status = response.status;
    error.setup = Boolean(data.setup);
    throw error;
  }
  return data;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function setAuthMode(signup) {
  signupMode = signup;
  $("#login-tab").classList.toggle("active", !signup);
  $("#signup-tab").classList.toggle("active", signup);
  $("#auth-submit").textContent = signup ? "Créer mon compte" : "Se connecter";
  $("#auth-title").textContent = signup ? "Créer un compte" : "Bon retour";
  $("#auth-subtitle").textContent = signup
    ? "Quelques secondes suffisent pour commander et suivre vos colis"
    : "Vos commandes et vos colis vous attendent";
  $("#auth-switch").firstChild.textContent = signup ? "Déjà inscrit ? " : "Pas encore de compte ? ";
  $("#auth-switch-button").textContent = signup ? "Se connecter" : "Créer un compte";
  $("#auth-form [name=password]").autocomplete = signup ? "new-password" : "current-password";
  $("#signup-country").hidden = !signup;
  if (signup && !$("#signup-country input:checked")) {
    $(`#signup-country input[value="${guessCountry()}"]`).checked = true;
  }
  $("#auth-message").textContent = "";
  const panel = $(".auth-panel");
  panel.classList.remove("is-switching");
  void panel.offsetWidth;
  panel.classList.add("is-switching");
}

if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.querySelectorAll("svg").forEach((svg) => svg.pauseAnimations?.());
}

const preloaderStartedAt = performance.now();
function hidePreloader() {
  const preloader = $("#preloader");
  if (!preloader) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const remaining = reducedMotion ? 0 : Math.max(0, 3000 - (performance.now() - preloaderStartedAt));
  window.setTimeout(() => {
    preloader.classList.add("is-done");
    window.setTimeout(() => preloader.remove(), 700);
  }, remaining);
}

function addProductRow() {
  const row = document.createElement("div");
  row.className = "product-row";
  row.innerHTML = `
    <div class="product-card-header"><strong>Lien <span class="product-number"></span></strong>
      <button class="remove-product" type="button" aria-label="Supprimer ce lien">×</button>
    </div>
    <label>Lien de l'article ou du panier<input class="product-link" type="url" required maxlength="2000" inputmode="url" placeholder="https://…"></label>
    <label>Description (facultatif)<input class="product-name" maxlength="120" placeholder="Ex. Baskets taille 42, couleur noire"></label>
    <div class="product-inline">
      <label>Quantité<input class="product-quantity" type="number" min="1" max="99" step="1" value="1" required></label>
      <label>Prix unitaire €<input class="product-price" type="number" min="0.01" max="1000000" step="0.01" placeholder="Facultatif"></label>
    </div>
    <details class="product-photo">
      <summary>Ajouter une photo (facultatif)</summary>
      <button class="image-picker" type="button" aria-label="Ajouter une photo de l'article">
        <img class="image-preview" alt="Aperçu de l'article" hidden>
        <span class="image-placeholder"><span class="plus-icon">＋</span><span>Choisir une photo</span></span>
      </button>
      <input class="product-image-file" type="file" accept="image/jpeg,image/png,image/webp">
      <div class="ai-recognition" aria-live="polite">
        <span class="ai-status">Une description sera proposée à partir de la photo.</span>
        <button class="apply-ai-suggestion" type="button" hidden>Utiliser la suggestion</button>
      </div>
      <div class="image-control">
        <input class="image-url" type="url" placeholder="Ou collez le lien de l'image">
        <span class="image-error" aria-live="polite"></span>
      </div>
    </details>`;
  const updateNumber = () => {
    [...$("#product-list").children].forEach((product, index) => {
      product.querySelector(".product-number").textContent = String(index + 1).padStart(2, "0");
    });
  };
  row.querySelector(".remove-product").addEventListener("click", () => {
    if ($("#product-list").children.length > 1) {
      const currentPreview = row.querySelector(".image-preview").src;
      if (currentPreview.startsWith("blob:")) URL.revokeObjectURL(currentPreview);
      row.remove();
      updateNumber();
      refreshQuote();
    }
  });
  const imageInput = row.querySelector(".product-image-file");
  const imagePreview = row.querySelector(".image-preview");
  const imagePicker = row.querySelector(".image-picker");
  const imageUrl = row.querySelector(".image-url");
  const imageError = row.querySelector(".image-error");
  const aiStatus = row.querySelector(".ai-status");
  const applySuggestion = row.querySelector(".apply-ai-suggestion");
  const nameInput = row.querySelector(".product-name");
  applySuggestion.addEventListener("click", () => {
    nameInput.value = row.dataset.aiSuggestion || "";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  imagePicker.addEventListener("click", () => imageInput.click());
  imageInput.addEventListener("change", () => {
    const file = imageInput.files[0];
    if (imagePreview.src.startsWith("blob:")) URL.revokeObjectURL(imagePreview.src);
    imageError.textContent = "";
    if (file) {
      imagePreview.src = URL.createObjectURL(file);
      imagePreview.hidden = false;
      imagePicker.classList.add("has-image");
      row.dataset.aiSuggestion = "";
      applySuggestion.hidden = true;
      if (file.size > 4 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        aiStatus.textContent = "Format non pris en charge ou image supérieure à 4 Mo.";
      } else {
        recognizeProductImage(file, row);
      }
    } else {
      aiStatus.textContent = "Une description sera proposée à partir de la photo.";
      imageUrl.dispatchEvent(new Event("input"));
    }
  });
  imageUrl.addEventListener("input", () => {
    imageError.textContent = "";
    if (imageInput.files.length) return;
    if (!imageUrl.value.trim()) {
      imagePreview.removeAttribute("src");
      imagePreview.hidden = true;
      imagePicker.classList.remove("has-image");
      return;
    }
    imagePreview.onload = () => {
      imagePreview.hidden = false;
      imagePicker.classList.add("has-image");
      imageError.textContent = "";
    };
    imagePreview.onerror = () => {
      imagePreview.hidden = true;
      imagePicker.classList.remove("has-image");
      imageError.textContent = "Aperçu indisponible pour ce lien.";
    };
    imagePreview.src = imageUrl.value.trim();
  });
  $("#product-list").append(row);
  updateNumber();
  refreshQuote();
}

function setCheckoutStep(step) {
  checkoutStep = step;
  document.querySelectorAll("[data-checkout-step]").forEach((section) => {
    section.hidden = Number(section.dataset.checkoutStep) !== step;
  });
  document.querySelectorAll(".progress-step").forEach((indicator) => {
    const number = Number(indicator.dataset.step);
    indicator.classList.toggle("active", number === step);
    indicator.classList.toggle("complete", number < step);
  });
  $("#checkout-title").textContent = ["", "1. Vos liens", "2. Expédition et livraison", "3. Vérification"][step];
  $("#next-step").textContent = step === 1 ? "Continuer vers la livraison →" : "Vérification →";
  $("#previous-step").hidden = step === 1;
  $("#next-step").hidden = step === 3;
  $("#submit-order").hidden = step !== 3;
  $("#order-message").textContent = "";
  if (step === 3) updateCheckoutReview();
}

// ---------------------------------------------------------------------------
// Carte de livraison : repère fixe au centre, on déplace la carte dessous.
// ---------------------------------------------------------------------------
const countryCenters = {
  benin: { center: [6.3703, 2.3912], name: "Bénin" },
  togo: { center: [6.1375, 1.2123], name: "Togo" }
};
const addressCache = new Map();
let reverseTimer = null;
let reverseRequestId = 0;
let searchTimer = null;
let searchRequestId = 0;
let pendingProgrammaticMove = null;
let selectedMapAddress = "";
let autoLocateTried = false;

// Pays de la personne : celui du compte, sinon déduit du fuseau horaire et de la langue de l'appareil.
function guessCountry() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (zone === "Africa/Lome") return "togo";
    if (zone === "Africa/Porto-Novo") return "benin";
  } catch {
    // Fuseau indisponible : on se rabat sur la langue.
  }
  const languages = (navigator.languages || [navigator.language || ""]).join(",").toUpperCase();
  if (languages.includes("-TG")) return "togo";
  return "benin";
}

function userCountry() {
  return currentUser?.country || guessCountry();
}

function whatsappNumberFor(country) {
  return country === "togo" ? "22890290081" : "22997158484";
}

function assistantLabelFor(country) {
  return country === "togo" ? "Assistant Togo · +228 90 29 00 81" : "Assistant Bénin · +229 97 15 84 84";
}

function destinationMapCenter() {
  const destination = $("#order-form [name=destination]").value;
  return (countryCenters[destination] || countryCenters[userCountry()]).center;
}

function mapCoordinates([lat, lng]) {
  return [lng, lat];
}

function setMapStatus(title, detail) {
  $("#map-selection-title").textContent = title;
  $("#map-selection-detail").textContent = detail;
}

function shortAddress(result) {
  const address = result.address || {};
  const first = [address.road || address.pedestrian || address.neighbourhood || address.suburb, address.house_number]
    .filter(Boolean).join(" ");
  const second = address.suburb || address.city_district || address.village || address.town || address.city || "";
  return [first, second].filter(Boolean).join(", ") || (result.display_name || "").split(",").slice(0, 2).join(",");
}

async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (addressCache.has(key)) return addressCache.get(key);
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", lat.toFixed(6));
  url.searchParams.set("lon", lng.toFixed(6));
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "fr");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Service d'adresse indisponible (${response.status}).`);
  const result = await response.json();
  const value = { short: shortAddress(result), full: result.display_name || "" };
  addressCache.set(key, value);
  return value;
}

function selectMapPoint({ lat, lng }, { keepLink = false } = {}) {
  selectedMapPoint = { lat, lng };
  selectedMapAddress = "";
  if (!keepLink) {
    selectedMapLink = "";
    $("#map-position-link").value = "";
  }
  $("#confirm-map").disabled = false;
  const coordinates = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  setMapStatus(keepLink ? "Lien de position prêt" : "Recherche de l'adresse…", `Position GPS : ${coordinates}`);
  clearTimeout(reverseTimer);
  const requestId = ++reverseRequestId;
  // Délai court pour respecter le service d'adresse (une requête à la fois).
  reverseTimer = setTimeout(async () => {
    try {
      const address = await reverseGeocode(lat, lng);
      if (requestId !== reverseRequestId) return;
      selectedMapAddress = address.full;
      if (!keepLink) setMapStatus(address.short || "Adresse sélectionnée", address.full || `Position GPS : ${coordinates}`);
    } catch {
      if (requestId !== reverseRequestId) return;
      if (!keepLink) setMapStatus("Position sélectionnée", `Adresse introuvable · position GPS : ${coordinates}`);
    }
  }, 650);
}

function resetMapSelection() {
  selectedMapPoint = null;
  selectedMapLink = "";
  selectedMapAddress = "";
  reverseRequestId += 1;
  $("#map-position-link").value = "";
  setMapStatus("Déplacez la carte", "Placez le repère sur votre adresse, recherchez-la ou utilisez votre position.");
  $("#confirm-map").disabled = true;
}

// Déplacement déclenché par le code (recherche, localisation, lien) : la position d'arrivée est retenue.
function moveMapTo({ lat, lng }, zoom = 17, options = {}) {
  pendingProgrammaticMove = options;
  deliveryMap.flyTo({ center: [lng, lat], zoom, speed: 1.6, essential: true });
}

function coordinatesFromMapUrl(url) {
  const source = `${url.href.replace(/%2C/gi, ",")} ${url.hash}`;
  const patterns = [
    /@(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/,
    /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/i,
    /(?:q|query|ll|destination|daddr)=(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/i,
    /#map=\d+\/(-?\d{1,2}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  }
  return null;
}

function useMapPositionLink(event) {
  event.preventDefault();
  const input = $("#map-position-link");
  let url;
  try {
    url = new URL(input.value.trim());
  } catch {
    input.setCustomValidity("Collez un lien Google Maps valide.");
    input.reportValidity();
    return;
  }
  const host = url.hostname.toLowerCase();
  const isMapLink = url.protocol === "https:" && (
    host === "google.com" || host.endsWith(".google.com")
    || host === "maps.app.goo.gl" || host === "goo.gl"
    || host === "maps.apple.com" || host === "openstreetmap.org"
    || host.endsWith(".openstreetmap.org")
  );
  if (!isMapLink) {
    input.setCustomValidity("Utilisez un lien Google Maps, Apple Plans ou OpenStreetMap.");
    input.reportValidity();
    return;
  }
  input.setCustomValidity("");
  selectedMapLink = url.toString();
  const coordinates = coordinatesFromMapUrl(url);
  if (coordinates) {
    moveMapTo(coordinates, 17, { keepLink: true });
  } else {
    selectedMapPoint = null;
    $("#confirm-map").disabled = false;
    setMapStatus("Lien de position prêt", "Ce lien sera enregistré avec la commande.");
  }
}

function hideSearchResults() {
  $("#map-search-results").hidden = true;
  $("#map-search-results").innerHTML = "";
}

async function searchAddress(query) {
  const requestId = ++searchRequestId;
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", query);
  url.searchParams.set("countrycodes", "bj,tg");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "fr");
  const list = $("#map-search-results");
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error();
    const results = await response.json();
    if (requestId !== searchRequestId) return;
    list.innerHTML = results.length
      ? results.map((result) => `<li><button type="button" role="option" data-lat="${escapeHtml(result.lat)}" data-lng="${escapeHtml(result.lon)}">
          <strong>${escapeHtml(shortAddress(result))}</strong><span>${escapeHtml(result.display_name)}</span></button></li>`).join("")
      : '<li class="map-search-empty">Aucun résultat. Essayez un quartier ou une ville.</li>';
  } catch {
    if (requestId !== searchRequestId) return;
    list.innerHTML = '<li class="map-search-empty">Recherche indisponible pour le moment.</li>';
  }
  list.hidden = false;
}

function locateOnMap({ silent = false } = {}) {
  const button = $("#locate-on-map");
  if (!navigator.geolocation) {
    if (!silent) setMapStatus("Localisation indisponible", "La géolocalisation n'est pas prise en charge par ce navigateur.");
    return;
  }
  button.classList.add("is-loading");
  if (!silent) setMapStatus("Localisation…", "Recherche de votre position GPS.");
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      button.classList.remove("is-loading");
      moveMapTo({ lat: coords.latitude, lng: coords.longitude }, 17);
    },
    (error) => {
      button.classList.remove("is-loading");
      if (silent && !selectedMapPoint) {
        resetMapSelection();
        return;
      }
      const messages = {
        1: "Autorisez l'accès à votre position dans les réglages du navigateur, ou déplacez la carte.",
        2: "Position indisponible. Vérifiez le GPS ou déplacez la carte.",
        3: "La recherche a pris trop de temps. Réessayez ou déplacez la carte."
      };
      setMapStatus("Position introuvable", messages[error.code] || "Impossible d'obtenir votre position.");
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

function openDeliveryMap() {
  $("#map-modal").hidden = false;
  document.body.classList.add("map-open");
  const savedLat = Number($("#map-latitude").value);
  const savedLng = Number($("#map-longitude").value);
  const hasSaved = Number.isFinite(savedLat) && Number.isFinite(savedLng) && savedLat && savedLng;
  const start = hasSaved ? [savedLat, savedLng] : destinationMapCenter();
  if (!deliveryMap) {
    deliveryMap = new maplibregl.Map({
      container: "delivery-map",
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: mapCoordinates(start),
      zoom: hasSaved ? 16 : 12,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false
    });
    deliveryMap.touchZoomRotate.disableRotation();
    deliveryMap.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    // Mentions repliées par défaut (le bouton « i » les affiche) pour ne pas masquer la carte.
    deliveryMap.once("load", () => {
      deliveryMap.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    });
    deliveryMap.on("movestart", () => $("#map-modal").classList.add("is-moving"));
    deliveryMap.on("moveend", (event) => {
      $("#map-modal").classList.remove("is-moving");
      const userMoved = Boolean(event.originalEvent);
      if (!userMoved && !pendingProgrammaticMove) return;
      const options = userMoved ? {} : pendingProgrammaticMove;
      pendingProgrammaticMove = null;
      const center = deliveryMap.getCenter();
      selectMapPoint({ lat: center.lat, lng: center.lng }, options);
    });
  } else {
    deliveryMap.jumpTo({ center: mapCoordinates(start), zoom: hasSaved ? 16 : 12 });
  }
  hideSearchResults();
  $("#map-search").value = "";
  if (selectedMapLink && !hasSaved) {
    $("#map-position-link").value = selectedMapLink;
    $("#confirm-map").disabled = false;
    setMapStatus("Lien de position prêt", "Ce lien sera enregistré avec la commande.");
  } else if (hasSaved) {
    selectMapPoint({ lat: savedLat, lng: savedLng }, { keepLink: Boolean(selectedMapLink) });
  } else {
    resetMapSelection();
    // Première ouverture : on centre directement sur la personne si elle l'accepte.
    if (!autoLocateTried) {
      autoLocateTried = true;
      locateOnMap({ silent: true });
    }
  }
  window.setTimeout(() => deliveryMap.resize(), 0);
}

function closeDeliveryMap() {
  $("#map-modal").hidden = true;
  document.body.classList.remove("map-open");
  hideSearchResults();
  $("#open-map").focus();
}

function confirmDeliveryLocation() {
  if (!selectedMapPoint && !selectedMapLink) return;
  if (selectedMapLink) {
    $("#order-form [name=location]").value = selectedMapLink;
    $("#map-latitude").value = selectedMapPoint ? selectedMapPoint.lat.toFixed(5) : "";
    $("#map-longitude").value = selectedMapPoint ? selectedMapPoint.lng.toFixed(5) : "";
    $("#location-coordinates").textContent = "Lien de position ajouté.";
    closeDeliveryMap();
    return;
  }
  const latitude = selectedMapPoint.lat.toFixed(5);
  const longitude = selectedMapPoint.lng.toFixed(5);
  const address = selectedMapAddress || `Position GPS ${latitude}, ${longitude}`;
  $("#order-form [name=location]").value = `${address.slice(0, 245)} (${latitude}, ${longitude})`;
  $("#map-latitude").value = latitude;
  $("#map-longitude").value = longitude;
  $("#location-coordinates").textContent = `Position GPS : ${latitude}, ${longitude}`;
  closeDeliveryMap();
}

function validateProducts() {
  const rows = [...$("#product-list").children];
  for (const row of rows) {
    const link = row.querySelector(".product-link");
    const quantity = row.querySelector(".product-quantity");
    const price = row.querySelector(".product-price");
    if (!link.reportValidity()) return false;
    if (!/^https?:\/\//i.test(link.value.trim())) {
      link.setCustomValidity("Le lien doit commencer par https://");
      link.reportValidity();
      link.setCustomValidity("");
      return false;
    }
    if (!row.querySelector(".product-name").reportValidity()) return false;
    if (!quantity.reportValidity()) return false;
    if (price.value && !price.reportValidity()) return false;
    const file = row.querySelector(".product-image-file").files[0];
    const imageUrl = row.querySelector(".image-url");
    if (file && (file.size > 4 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type))) {
      $("#order-message").textContent = "Choisissez une photo JPG, PNG ou WEBP de moins de 4 Mo.";
      return false;
    }
    if (!file && imageUrl.value.trim() && !imageUrl.checkValidity()) {
      row.querySelector(".product-photo").open = true;
      imageUrl.reportValidity();
      return false;
    }
  }
  return true;
}

async function recognizeProductImage(file, row) {
  const status = row.querySelector(".ai-status");
  const applySuggestion = row.querySelector(".apply-ai-suggestion");
  status.textContent = "Analyse de la photo en cours…";
  applySuggestion.hidden = true;
  try {
    const imageData = await readFileAsDataUrl(file);
    const { suggestion } = await api("/api/recognize-product", {
      method: "POST",
      body: JSON.stringify({ imageData })
    });
    if (!row.isConnected || row.querySelector(".product-image-file").files[0] !== file) return;
    row.dataset.aiSuggestion = suggestion;
    const nameInput = row.querySelector(".product-name");
    if (!nameInput.value.trim()) {
      nameInput.value = suggestion;
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      status.textContent = "Suggestion IA ajoutée ; vérifiez et corrigez si besoin.";
    } else {
      status.textContent = `Suggestion IA : ${suggestion}`;
      applySuggestion.hidden = false;
    }
  } catch (error) {
    if (!row.isConnected || row.querySelector(".product-image-file").files[0] !== file) return;
    status.textContent = error.message;
  }
}

function updateCheckoutReview() {
  const form = new FormData($("#order-form"));
  const destination = form.get("destination") === "benin" ? "Bénin" : "Togo";
  const items = [...$("#product-list").children].map((row, index) => ({
    name: row.querySelector(".product-name").value.trim() || `Article ${index + 1}`,
    link: row.querySelector(".product-link").value.trim(),
    quantity: Number(row.querySelector(".product-quantity").value) || 1,
    price: row.querySelector(".product-price").value,
    image: row.querySelector(".image-preview").hidden ? "" : row.querySelector(".image-preview").src
  }));
  const products = items.map((item) => `
    <div class="review-product">
      ${itemThumb(item.image)}
      <div><strong>${item.quantity} × ${escapeHtml(item.name)}</strong>
        <span class="review-link">${escapeHtml(item.link)}</span>
        <span>${item.price ? `${escapeHtml(formatEur(Number(item.price)))} l'unité (indicatif)` : "Prix à confirmer"}</span></div>
    </div>`).join("");
  const phone = form.get("phone") || "Non renseigné";
  const name = form.get("customerName") || "Non renseigné";
  const location = form.get("location") || "Non renseignée";
  const mode = form.get("shippingMode") === "bateau" ? "Bateau · tarif selon les produits" : "Avion · 15 € par kilo";
  $("#checkout-review").innerHTML = `${products}
    <div class="review-delivery"><strong>Livraison au ${destination}</strong>
      <span>Expédition : ${mode}</span>
      <span>${escapeHtml(name)} · ${escapeHtml(phone)}</span>
      <span>${escapeHtml(location)}</span>
    </div>`;
  refreshQuote();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Impossible de lire l'image sélectionnée."));
    reader.readAsDataURL(file);
  });
}

// Supabase renvoie « 2026-11-18T09:12:33.123+00:00 » ; d'anciennes lignes « 2026-11-18 09:12:33 » sans fuseau (UTC).
function orderDate(value) {
  if (!value) return null;
  const text = String(value).replace(" ", "T");
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatNumber(amount) {
  return new Intl.NumberFormat("fr-FR").format(amount);
}

function itemThumb(image) {
  return image
    ? `<img src="${escapeHtml(image)}" alt="">`
    : '<span class="item-thumb" aria-hidden="true"><svg><use href="#i-box"/></svg></span>';
}

// Estimation côté client à partir des prix saisis : seul le montant envoyé par l'admin fait foi.
function refreshQuote() {
  if (!$("#product-list")) return;
  const rows = [...$("#product-list").children];
  let articles = 0;
  let pricedRows = 0;
  for (const row of rows) {
    const price = Number(row.querySelector(".product-price").value);
    const quantity = Number(row.querySelector(".product-quantity").value) || 1;
    if (Number.isFinite(price) && price > 0) {
      articles += price * quantity;
      pricedRows += 1;
    }
  }
  articles = roundCents(articles);
  const complete = pricedRows === rows.length;
  const commission = pricedRows ? commissionFor(articles) : 0;
  const total = roundCents(articles + commission);
  const articlesText = pricedRows ? `${formatEur(articles)}${complete ? "" : " (partiel)"}` : "Non renseigné";
  const commissionText = pricedRows ? formatEur(commission) : "—";
  const totalText = pricedRows ? `${formatEur(total)} ≈ ${formatFcfa(toFcfa(total))}` : "Montant exact à venir";
  $("#quote-products").textContent = articlesText;
  $("#quote-shipping").textContent = commissionText;
  $("#quote-total").textContent = totalText;
  $("#estimate-articles").textContent = articlesText;
  $("#estimate-commission").textContent = commissionText;
  $("#estimate-total").textContent = pricedRows ? totalText : "Indiquez un prix pour estimer";
}

function statusOptions(order) {
  return statusOrder.map((status) => {
    const index = statusOrder.indexOf(status);
    const disabled = (order.paymentStatus !== "verified" && index >= statusOrder.indexOf("commande_fournisseur"))
      || (!order.shippingPaid && index >= statusOrder.indexOf("en_transit"));
    return `<option value="${status}" ${status === order.status ? "selected" : ""} ${disabled ? "disabled" : ""}>${statusNames[status]}</option>`;
  }).join("");
}

function quoteBreakdown(order) {
  if (order.articlesEur === null || order.articlesEur === undefined) return "";
  const total = roundCents(order.articlesEur + order.commissionEur);
  return `<div class="cost-block">
    <strong>Étape 2 · Votre panier</strong>
    <div class="cost-line"><span>Articles</span><b>${formatEur(order.articlesEur)}</b></div>
    <div class="cost-line"><span>Commission</span><b>${formatEur(order.commissionEur)}</b></div>
    <div class="cost-line cost-total"><span>Total à payer par MoMo</span><b>${formatEur(total)} · ${formatFcfa(order.quoteTotalFcfa)}</b></div>
    <span class="cost-status">${paymentStatusNames[order.paymentStatus] || ""}</span>
  </div>`;
}

function shippingBreakdown(order) {
  if (order.shippingEur === null || order.shippingEur === undefined) return "";
  const detail = order.shippingMode === "avion" && order.shippingWeightKg
    ? `Avion · ${formatNumber(order.shippingWeightKg)} kg × ${AIR_RATE_EUR_PER_KG} €`
    : `${shippingModeNames[order.shippingMode]}${order.shippingWeightKg ? ` · ${formatNumber(order.shippingWeightKg)} kg` : ""}`;
  return `<div class="cost-block">
    <strong>Étape 3 · Expédition depuis la France</strong>
    <div class="cost-line"><span>${detail}</span><b>${formatEur(order.shippingEur)}</b></div>
    <div class="cost-line cost-total"><span>À payer par MoMo</span><b>${formatFcfa(toFcfa(order.shippingEur))}</b></div>
    <span class="cost-status">${order.shippingPaid ? "✓ Frais d'expédition réglés" : "À régler avant le départ du colis"}</span>
  </div>`;
}


function renderItems(order) {
  return order.items.map((item) => {
    const quantity = item.quantity || 1;
    const label = `${quantity > 1 ? `${quantity} × ` : ""}${escapeHtml(item.name)}${item.priceEur ? ` · ${escapeHtml(formatEur(item.priceEur))}` : ""}`;
    const unavailable = item.available === false;
    const badge = unavailable ? `<em class="item-badge">Indisponible${item.adminComment ? ` · ${escapeHtml(item.adminComment)}` : ""}</em>` : "";
    const content = `${itemThumb(item.image)}<span>${label}${badge}</span>`;
    const className = `item-chip${unavailable ? " is-unavailable" : ""}`;
    return item.link
      ? `<a class="${className}" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${content}<span class="item-chip-arrow" aria-hidden="true">↗</span></a>`
      : `<span class="${className}">${content}</span>`;
  }).join("");
}

function paymentProofFormFor(order) {
  if (!order.quoteTotalFcfa || order.paymentStatus === "verified") return "";
  return `
    <form class="payment-proof-form" data-order-id="${order.id}">
      <strong>${order.paymentStatus === "proof_received" ? "Reçu envoyé · vérification en cours" : `Payez ${formatFcfa(order.quoteTotalFcfa)} par MoMo puis envoyez le reçu`}</strong>
      <label>Moyen de paiement
        <select name="paymentMethod" required>
          ${["Mobile Money", "Virement bancaire", "Autre"].map((method) => `<option value="${method}" ${(order.paymentMethod || "Mobile Money") === method ? "selected" : ""}>${method === "Mobile Money" ? "Mobile Money (MoMo)" : method}</option>`).join("")}
        </select>
      </label>
      <label>Référence de transaction (facultatif)
        <input name="paymentReference" maxlength="100" value="${escapeHtml(order.paymentReference || "")}" placeholder="Ex. ID de la transaction MoMo">
      </label>
      <label>Reçu de paiement (JPG, PNG, WEBP ou PDF · 5 Mo max)
        <input name="proofFile" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required>
      </label>
      <button class="button button-outline" type="submit">${order.hasPaymentProof ? "Remplacer le reçu" : "Envoyer le reçu"}</button>
      <span class="payment-proof-message" aria-live="polite"></span>
    </form>`;
}

function shippingProofLink(order) {
  if (order.shippingEur === null || order.shippingEur === undefined || order.shippingPaid) return "";
  const message = [
    `Bonjour, voici le reçu MoMo des frais d'expédition de ma commande ${order.reference}.`,
    `Montant : ${formatFcfa(toFcfa(order.shippingEur))}.`
  ].join("\n");
  return `<a class="button button-primary shipping-whatsapp" href="https://wa.me/${whatsappNumberFor(userCountry())}?text=${encodeURIComponent(message)}" target="_blank" rel="noopener noreferrer">Envoyer le reçu à mon assistant</a>`;
}

// Lien direct vers la commande, ajouté à chaque message WhatsApp envoyé au client.
function orderLink(order) {
  return `${window.location.origin}/#commande-${encodeURIComponent(order.reference)}`;
}

function customerWhatsappUrl(order, lines) {
  let phone = order.phone.replace(/\D/g, "");
  if (phone.length === 8) phone = `${order.destination === "benin" ? "229" : "228"}${phone}`;
  const text = [...lines, "", `Suivez votre commande ici : ${orderLink(order)}`].join("\n");
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

// L'onglet s'ouvre au clic (sinon le navigateur bloque la fenêtre) ; en secours, un lien reste affiché.
function openBlankWindow() {
  const target = window.open("about:blank", "_blank");
  if (target) target.opener = null;
  return target;
}

function sendWhatsapp(target, url) {
  if (target && !target.closed) {
    target.location.href = url;
    return;
  }
  const banner = $("#whatsapp-fallback");
  banner.querySelector("a").href = url;
  banner.hidden = false;
}

const statusWhatsappLines = {
  demande_recue: "Nous avons bien reçu vos liens : nous préparons le montant exact de votre panier.",
  devis_envoye: "Le montant de votre panier est prêt : il reste à le régler par MoMo.",
  commande_fournisseur: "Vos articles ont été commandés auprès du vendeur.",
  recu_france: "Votre colis est arrivé à notre adresse en France.",
  en_transit: "Votre colis est en route vers vous.",
  arrive: "Votre colis est arrivé au pays : nous vous contactons pour la livraison.",
  livre: "Votre colis a été livré. Merci pour votre confiance !"
};

function statusWhatsappMessage(order, status = order.status) {
  return [`Bonjour ${order.customerName},`, `Commande ${order.reference} : ${statusWhatsappLines[status] || statusNames[status]}`];
}

function adminCardState(order) {
  if (order.cancelled) return "is-cancelled";
  if (order.status === "livre") return "state-delivered";
  if (order.paymentStatus === "verified") return "state-paid";
  if (order.quoteTotalFcfa) return "state-sent";
  return "";
}

function adminControls(order) {
  const canQuote = ["demande_recue", "devis_envoye"].includes(order.status)
    && !["proof_received", "verified"].includes(order.paymentStatus);
  const quoteSection = canQuote ? `
    <div class="admin-step">
      <strong>Étape 2 · Panier au montant exact</strong>
      <label class="admin-quote-label" for="articles-eur-${order.id}">Montant exact des articles (€)
        <input id="articles-eur-${order.id}" class="articles-eur-input" data-preview-id="${order.id}" type="number" required min="0.01" max="1000000" step="0.01" value="${order.articlesEur ?? ""}" placeholder="Ex. 149,90">
      </label>
      <p class="quote-preview" id="quote-preview-${order.id}">${quotePreviewText(order.articlesEur)}</p>
      <button class="button button-primary send-quote" type="button" data-quote-id="${order.id}">
        ${order.articlesEur ? "Mettre à jour et renvoyer sur WhatsApp" : "Enregistrer et envoyer sur WhatsApp"}
      </button>
    </div>` : "";
  const hasProof = order.paymentStatus === "proof_received";
  const paymentSection = order.quoteTotalFcfa && ["awaiting_proof", "proof_received"].includes(order.paymentStatus) ? `
    <div class="payment-review">
      <strong>${hasProof ? "Reçu MoMo envoyé par le client" : "Paiement MoMo attendu"} · ${formatFcfa(order.quoteTotalFcfa)}</strong>
      ${hasProof ? `<button class="button button-outline view-payment-proof" type="button" data-proof-order-id="${order.id}">Consulter le reçu</button>` : ""}
      <button class="button button-primary verify-payment" type="button" data-verify-payment-id="${order.id}">✓ Paiement MoMo reçu</button>
      ${hasProof ? `<button class="button button-outline button-danger" type="button" data-reject-payment-id="${order.id}">Refuser le reçu</button>` : ""}
      ${order.paymentMethod ? `<span>Moyen : ${escapeHtml(order.paymentMethod)}</span>` : ""}
      ${order.paymentReference ? `<span>Transaction : ${escapeHtml(order.paymentReference)}</span>` : ""}
    </div>` : order.paymentStatus === "verified" ? '<div class="payment-verified">✓ Panier payé</div>' : "";
  const canSetShipping = order.status === "recu_france" && order.paymentStatus === "verified" && !order.shippingPaid;
  const shippingSection = canSetShipping ? `
    <div class="admin-step">
      <strong>Étape 3 · Expédition (${shippingModeNames[order.shippingMode]})</strong>
      <label class="admin-quote-label" for="weight-kg-${order.id}">Poids du colis (kg)${order.shippingMode === "bateau" ? " · facultatif" : ""}
        <input id="weight-kg-${order.id}" class="weight-kg-input" data-preview-id="${order.id}" data-mode="${order.shippingMode}" type="number" min="0.01" max="5000" step="0.01" value="${order.shippingWeightKg ?? ""}" placeholder="Ex. 2,5" ${order.shippingMode === "avion" ? "required" : ""}>
      </label>
      ${order.shippingMode === "bateau" ? `
      <label class="admin-quote-label" for="shipping-eur-${order.id}">Tarif bateau (€)
        <input id="shipping-eur-${order.id}" type="number" min="0.01" max="1000000" step="0.01" value="${order.shippingEur ?? ""}" placeholder="Montant en euros" required>
      </label>` : `<p class="quote-preview" id="shipping-preview-${order.id}">${shippingPreviewText(order.shippingWeightKg)}</p>`}
      <button class="button button-primary send-shipping" type="button" data-shipping-id="${order.id}">
        ${order.shippingEur ? "Mettre à jour et renvoyer sur WhatsApp" : "Enregistrer et envoyer sur WhatsApp"}
      </button>
      ${order.shippingEur ? `<button class="button button-outline" type="button" data-shipping-paid-id="${order.id}">Confirmer le paiement de l'expédition</button>` : ""}
    </div>` : "";
  const actions = `<div class="admin-actions">
      ${order.cancelled ? "" : `<button class="button button-outline button-whatsapp" type="button" data-notify-order-id="${order.id}">Prévenir sur WhatsApp</button>`}
      <button class="button button-outline" type="button" data-edit-order-id="${order.id}">Modifier</button>
      ${order.cancelled
        ? `<button class="button button-outline" type="button" data-restore-order-id="${order.id}">Rétablir</button>`
        : order.status !== "livre" ? `<button class="button button-outline button-danger" type="button" data-cancel-order-id="${order.id}">Annuler</button>` : ""}
      <button class="button button-outline button-danger" type="button" data-delete-order-id="${order.id}">Supprimer</button>
    </div>`;
  if (order.cancelled) {
    return `<div class="admin-controls">
      <div class="cancelled-box"><strong>Commande annulée</strong><span>${escapeHtml(order.cancelReason || "")}</span>
        ${order.paymentStatus === "verified" ? "<span>Le client avait payé : pensez au remboursement MoMo.</span>" : ""}</div>
      ${actions}
    </div>`;
  }
  return `<div class="admin-controls">
    ${quoteSection}${paymentSection}${shippingSection}
    ${order.shippingPaid ? '<div class="payment-verified">✓ Expédition payée</div>' : ""}
    <label class="admin-status-label">Suivi
      <select aria-label="Modifier le statut de la commande ${escapeHtml(order.reference)}" data-order-id="${order.id}">${statusOptions(order)}</select>
    </label>
    ${actions}
  </div>`;
}

function quotePreviewText(articlesEur) {
  const articles = Number(articlesEur);
  if (!Number.isFinite(articles) || articles <= 0) return "Saisissez le montant pour calculer la commission.";
  const commission = commissionFor(roundCents(articles));
  const total = roundCents(articles + commission);
  return `Commission ${formatEur(commission)} · Total ${formatEur(total)} = ${formatFcfa(toFcfa(total))}`;
}

function shippingPreviewText(weightKg) {
  const weight = Number(weightKg);
  if (!Number.isFinite(weight) || weight <= 0) return `Saisissez le poids : ${AIR_RATE_EUR_PER_KG} € par kilo.`;
  const shipping = roundCents(weight * AIR_RATE_EUR_PER_KG);
  return `${formatNumber(weight)} kg × ${AIR_RATE_EUR_PER_KG} € = ${formatEur(shipping)} = ${formatFcfa(toFcfa(shipping))}`;
}

function linkHost(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "lien";
  }
}

// Détail de ce que le client a demandé : chaque lien, la quantité, le prix indiqué et la disponibilité.
function adminItemsTable(order) {
  const quantity = order.items.reduce((sum, item) => sum + (item.quantity || 1), 0);
  const unavailable = order.items.filter((item) => item.available === false).length;
  const rows = order.items.map((item, index) => {
    const off = item.available === false;
    return `<li class="admin-item${off ? " is-unavailable" : ""}">
      ${itemThumb(item.image)}
      <div class="admin-item-body">
        <strong>${index + 1}. ${escapeHtml(item.name)}</strong>
        <span>Qté ${item.quantity || 1}${item.priceEur ? ` · ${escapeHtml(formatEur(item.priceEur))} l'unité (indiqué par le client)` : " · prix non indiqué"}</span>
        ${off ? `<em class="item-badge">Indisponible${item.adminComment ? ` · ${escapeHtml(item.adminComment)}` : ""}</em>` : item.adminComment ? `<em class="item-comment">${escapeHtml(item.adminComment)}</em>` : ""}
      </div>
      <a class="admin-item-link" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkHost(item.link))} ↗</a>
    </li>`;
  }).join("");
  return `<div class="admin-items">
    <div class="admin-items-head"><strong>Articles demandés</strong><span>${order.items.length} lien(s) · ${quantity} article(s)${unavailable ? ` · <b>${unavailable} indisponible(s)</b>` : ""}${order.subtotalEur ? ` · estimation client ${escapeHtml(formatEur(order.subtotalEur))}` : ""}</span></div>
    <ol>${rows}</ol>
  </div>`;
}

function renderOrder(order, isAdmin) {
  if (isAdmin) return renderAdminCard(order);
  return renderTicket(order, renderItems(order));
}

function renderAdminCard(order) {
  const created = orderDate(order.createdAt);
  const date = created ? created.toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const statusLabel = order.cancelled
    ? '<span class="status" data-status="annule">Annulée</span>'
    : `<span class="status" data-status="${order.status}">${statusNames[order.status]}</span>`;
  const open = String(openAdminSheetId) === String(order.id);
  const articleCount = order.items.reduce((sum, item) => sum + (item.quantity || 1), 0);
  const amount = order.quoteTotalFcfa ? formatFcfa(order.quoteTotalFcfa) : "Montant à envoyer";
  // Sur mobile : carte réduite ; un appui ouvre le détail dans un panneau qui monte du bas de l'écran.
  return `<article class="order-card admin-card ${adminCardState(order)}${open ? " is-open" : ""}" data-order-id="${order.id}">
    <button class="admin-summary" type="button" data-open-sheet="${order.id}" aria-label="Ouvrir la commande ${escapeHtml(order.reference)}">
      <span class="admin-summary-top"><b>Réf. ${escapeHtml(order.reference)}</b>${statusLabel}</span>
      <span class="admin-summary-line">${escapeHtml(order.customerName)} · ${articleCount} article(s) · ${order.destination === "benin" ? "Bénin" : "Togo"}</span>
      <span class="admin-summary-bottom"><strong>${escapeHtml(amount)}</strong><i aria-hidden="true">›</i></span>
    </button>
    <div class="admin-sheet-backdrop" data-close-sheet></div>
    <div class="admin-card-body">
    <div class="admin-sheet-head"><span class="admin-sheet-handle" aria-hidden="true"></span><strong>Réf. ${escapeHtml(order.reference)}</strong><button type="button" class="admin-sheet-close" data-close-sheet aria-label="Fermer">✕</button></div>
    <div class="admin-card-main">
      <div class="order-top"><span class="order-id">Réf. ${escapeHtml(order.reference)}</span>${date ? `<span class="order-date">${escapeHtml(date)}</span>` : ""}<span class="order-destination">${order.destination === "benin" ? "Bénin" : "Togo"} · ${shippingModeNames[order.shippingMode]}</span>${statusLabel}</div>
      ${adminItemsTable(order)}
      <div class="admin-meta">Client : <strong>${escapeHtml(order.username)}</strong> · ${escapeHtml(order.customerName)}<br>
        Tél. ${escapeHtml(order.phone)} · ${escapeHtml(order.location)}${order.notes ? `<br>Note du client : ${escapeHtml(order.notes)}` : ""}
      </div>
      ${order.adminNote ? `<div class="admin-note"><strong>Note interne</strong>${escapeHtml(order.adminNote)}</div>` : ""}
      ${order.customerMessage ? `<div class="customer-message"><strong>Message affiché au client</strong>${escapeHtml(order.customerMessage)}</div>` : ""}
      <div class="cost-blocks">${quoteBreakdown(order)}${shippingBreakdown(order)}</div>
    </div>${adminControls(order)}
    </div>
  </article>`;
}

const ticketStatusNames = {
  demande_recue: "Panier en préparation",
  devis_envoye: "Paiement MoMo attendu",
  commande_fournisseur: "Commandé",
  recu_france: "Reçu en France",
  en_transit: "En route",
  arrive: "Arrivé au pays",
  livre: "Livré"
};

function ticketStub(order) {
  const cartPaid = order.paymentStatus === "verified";
  const shippingDue = order.shippingEur !== null && order.shippingEur !== undefined && !order.shippingPaid;
  if (!order.quoteTotalFcfa) return { label: "PANIER", amount: "À venir", note: "Montant exact envoyé sur WhatsApp" };
  if (!cartPaid) return { label: "À PAYER · MOMO", amount: `${formatNumber(order.quoteTotalFcfa)} <small>FCFA</small>`, note: paymentStatusNames[order.paymentStatus] || "" };
  if (shippingDue) return { label: "EXPÉDITION · MOMO", amount: `${formatNumber(toFcfa(order.shippingEur))} <small>FCFA</small>`, note: "À régler avant le départ" };
  if (order.shippingPaid) return { label: "TOUT EST RÉGLÉ", amount: "✓ Payé", note: "Panier et expédition" };
  return { label: "PANIER PAYÉ", amount: `${formatNumber(order.quoteTotalFcfa)} <small>FCFA</small>`, note: "Expédition calculée à réception en France" };
}

function renderTicket(order, items) {
  const index = Math.max(0, statusOrder.indexOf(order.status));
  const progress = Math.round((index / (statusOrder.length - 1)) * 100);
  const created = orderDate(order.createdAt);
  const shortDate = created ? created.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }).replace(".", "").toUpperCase() : "";
  const isBenin = order.destination === "benin";
  const delivered = order.status === "livre";
  const stub = order.cancelled
    ? { label: "ANNULÉE", amount: "—", note: order.cancelReason }
    : ticketStub(order);
  const costs = `${quoteBreakdown(order)}${shippingBreakdown(order)}`;
  const canCancel = !order.cancelled && ["demande_recue", "devis_envoye"].includes(order.status)
    && !["proof_received", "verified"].includes(order.paymentStatus);
  const message = order.customerMessage && !order.cancelled
    ? `<div class="customer-message"><strong>Message de votre assistant</strong>${escapeHtml(order.customerMessage)}</div>` : "";
  const foot = order.cancelled
    ? `<div class="cancelled-box"><strong>Commande annulée</strong><span>${escapeHtml(order.cancelReason || "")}</span></div>`
    : `${message}${costs ? `<div class="cost-blocks">${costs}</div>` : ""}${paymentProofFormFor(order)}${shippingProofLink(order)}${canCancel ? `<button class="text-button cancel-own-order" type="button" data-cancel-own-id="${order.id}">Annuler cette demande</button>` : ""}`;
  return `<article class="order-card ticket${delivered ? " is-delivered" : ""}${order.cancelled ? " is-cancelled" : ""}" data-order-id="${order.id}" data-reference="${escapeHtml(order.reference)}" data-group="${delivered ? "delivered" : "active"}">
    <div class="ticket-body">
      <div class="ticket-main">
        <header class="ticket-head">
          <span class="ticket-ref">Réf. ${escapeHtml(order.reference)}</span>
          <span class="ticket-brand"><svg aria-hidden="true"><use href="#i-plane"/></svg> ${shippingModeNames[order.shippingMode]}</span>
        </header>
        <div class="ticket-content">
        <div class="ticket-route">
          <div class="route-point"><small>DÉPART</small><strong>FR</strong><span>France</span></div>
          <div class="route-track" style="--progress:${progress}%">
            <span class="route-status">${ticketStatusNames[order.status] || ""}</span>
            <span class="route-line"><span class="route-fill"></span><svg class="route-plane" aria-hidden="true"><use href="#i-plane"/></svg></span>
            <span class="route-step">Étape ${index + 1}/${statusOrder.length}</span>
          </div>
          <div class="route-point route-end"><small>ARRIVÉE</small><strong>${isBenin ? "BJ" : "TG"}</strong><span>${isBenin ? "Bénin" : "Togo"}</span></div>
        </div>
        <dl class="ticket-meta">
          <div><dt>Statut</dt><dd>${order.cancelled ? '<span class="status" data-status="annule">Annulée</span>' : `<span class="status" data-status="${order.status}">${statusNames[order.status]}</span>`}</dd></div>
          <div><dt>Articles</dt><dd>${order.items.reduce((sum, item) => sum + (item.quantity || 1), 0)}</dd></div>
          <div><dt>Destinataire</dt><dd>${escapeHtml(order.customerName || "—")}</dd></div>
        </dl>
        <div class="order-items">${items}</div>
        <div class="order-address">${escapeHtml(order.location)} · ${escapeHtml(order.phone)}</div>
        </div>
      </div>
      <div class="ticket-stub">
        <span class="ticket-date">${escapeHtml(shortDate)}</span>
        <small>${stub.label}</small>
        <strong>${stub.amount}</strong>
        ${stub.note ? `<span>${escapeHtml(stub.note)}</span>` : ""}
        <span class="ticket-barcode" aria-hidden="true"></span>
      </div>
    </div>
    ${foot ? `<div class="ticket-foot">${foot}</div>` : ""}
  </article>`;
}

let pendingOrderFocus = "";

// Ouvert depuis le lien WhatsApp : affiche « Mes commandes » et met la commande en évidence.
function openOrderFromHash() {
  const match = window.location.hash.match(/^#commande-(.+)$/);
  if (!match) return false;
  pendingOrderFocus = decodeURIComponent(match[1]);
  customerOrderFilter = "all";
  document.querySelectorAll("[data-order-filter]").forEach((button) => {
    const active = button.dataset.orderFilter === "all";
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  showCustomerPage("orders", false);
  focusPendingOrder();
  return true;
}

function focusPendingOrder() {
  if (!pendingOrderFocus) return;
  const ticket = [...document.querySelectorAll("#orders-list [data-reference]")]
    .find((element) => element.dataset.reference === pendingOrderFocus);
  if (!ticket) return;
  pendingOrderFocus = "";
  ticket.scrollIntoView({ behavior: "smooth", block: "center" });
  ticket.classList.add("is-new");
  window.setTimeout(() => ticket.classList.remove("is-new"), 4000);
}

let customerOrdersCache = [];
let customerOrderFilter = "all";
let lastCustomerOrdersHtml = "";

function renderCustomerOrders() {
  const orders = customerOrdersCache;
  const delivered = orders.filter((order) => order.status === "livre").length;
  const cancelled = orders.filter((order) => order.cancelled).length;
  $("#count-all").textContent = String(orders.length);
  $("#count-active").textContent = String(orders.length - delivered - cancelled);
  $("#count-delivered").textContent = String(delivered);
  const visible = orders.filter((order) => {
    if (customerOrderFilter === "active") return order.status !== "livre" && !order.cancelled;
    if (customerOrderFilter === "delivered") return order.status === "livre";
    return true;
  });
  const emptyMessage = orders.length
    ? "Aucune commande dans cette catégorie."
    : "Aucune commande pour le moment.";
  const html = visible.length
    ? visible.map((order) => renderOrder(order, false)).join("")
    : `<div class="empty-state">${emptyMessage}</div>`;
  if (html === lastCustomerOrdersHtml || isEditingInside("#orders-list")) return;
  lastCustomerOrdersHtml = html;
  $("#orders-list").innerHTML = html;
}

let adminOrderFilter = "todo";
const adminFilters = {
  todo: (order) => !order.cancelled && (order.status === "demande_recue" || order.paymentStatus === "proof_received"
    || (order.status === "recu_france" && !order.shippingPaid)),
  active: (order) => !order.cancelled && order.status !== "livre",
  delivered: (order) => !order.cancelled && order.status === "livre",
  cancelled: (order) => order.cancelled,
  all: () => true
};

function renderAdminOrders() {
  const search = $("#admin-order-search").value.trim();
  const normalizedSearch = search.toLocaleLowerCase("fr");
  const phoneSearch = search.replace(/\D/g, "");
  const orders = adminOrdersCache.filter((order) => {
    if (!adminFilters[adminOrderFilter](order)) return false;
    if (!normalizedSearch) return true;
    const text = [order.reference, order.username, order.customerName, order.location, ...order.items.map((item) => item.name)]
      .join(" ").toLocaleLowerCase("fr");
    const matchesPhone = phoneSearch.length >= 3 && order.phone.replace(/\D/g, "").includes(phoneSearch);
    return text.includes(normalizedSearch) || matchesPhone;
  });
  document.querySelectorAll("[data-admin-filter]").forEach((button) => {
    const count = button.querySelector("b");
    if (count) count.textContent = String(adminOrdersCache.filter(adminFilters[button.dataset.adminFilter]).length);
  });
  $("#admin-search-results").textContent = `${orders.length} commande(s) affichée(s) sur ${adminOrdersCache.length}.`;
  const html = orders.length
    ? orders.map((order) => renderOrder(order, true)).join("")
    : `<div class="empty-state">${adminOrderFilter === "todo" && !search ? "Rien à traiter pour le moment." : "Aucune commande ne correspond."}</div>`;
  if (html === lastAdminOrdersHtml || isEditingInside("#admin-orders")) return;
  lastAdminOrdersHtml = html;
  $("#admin-orders").innerHTML = html;
  setAdminSheet(document.querySelector("#admin-orders .admin-card.is-open") ? openAdminSheetId : null);
}

let openAdminSheetId = null;

function setAdminSheet(orderId) {
  openAdminSheetId = orderId;
  document.querySelectorAll("#admin-orders .admin-card").forEach((card) => {
    card.classList.toggle("is-open", orderId !== null && card.dataset.orderId === String(orderId));
  });
  document.body.classList.toggle("sheet-open", orderId !== null);
}

let lastAdminOrdersHtml = "";
// Évite d'effacer une saisie en cours lors de l'actualisation automatique (toutes les 20 s).
function isEditingInside(selector) {
  const active = document.activeElement;
  return Boolean(active && active.matches("input, select, textarea") && $(selector).contains(active));
}

// Après l'enregistrement : redirection vers « Mes commandes », message de succès et commande mise en évidence.
function showOrderSuccess(order) {
  const destination = order.destination === "benin" ? "Bénin" : "Togo";
  const country = userCountry();
  const whatsappNumber = whatsappNumberFor(country);
  $("#order-success-reference").textContent = order.reference;
  $("#assistant-label").textContent = assistantLabelFor(country);
  const message = [
    `Bonjour, voici ma commande ${order.reference}.`,
    ...order.items.map((item) => `- ${item.quantity || 1} × ${item.name} : ${item.link}`),
    `Expédition : ${shippingModeNames[order.shippingMode] || "Avion"}.`,
    `Destinataire : ${order.customerName}, livraison au ${destination} : ${order.location}.`,
    "Merci de m'envoyer le montant exact de mon panier."
  ].join("\n");
  $("#send-order-whatsapp").href = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
  $("#order-success").hidden = false;
  customerOrderFilter = "all";
  document.querySelectorAll("[data-order-filter]").forEach((button) => {
    const active = button.dataset.orderFilter === "all";
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  lastCustomerOrdersHtml = "";
  renderCustomerOrders();
  showCustomerPage("orders");
  const ticket = document.querySelector(`#orders-list [data-order-id="${order.id}"]`);
  if (ticket) {
    ticket.classList.add("is-new");
    window.setTimeout(() => ticket.classList.remove("is-new"), 4000);
  }
}

async function loadOrders() {
  if (!currentUser) return;
  try {
    const { orders } = await api("/api/orders");
    const target = currentUser.role === "admin" ? $("#admin-orders") : $("#orders-list");
    if (currentUser.role === "admin") {
      adminOrdersCache = orders;
      const live = orders.filter((order) => !order.cancelled);
      $("#admin-quotes-pending").textContent = String(live.filter((order) => order.status === "demande_recue").length);
      $("#admin-payments-pending").textContent = String(live.filter((order) => order.paymentStatus === "proof_received").length);
      $("#admin-orders-to-ship").textContent = String(live.filter((order) => order.status === "recu_france" && !order.shippingPaid).length);
      renderAdminOrders();
    } else {
      $("#home-order-count").textContent = String(orders.length);
      customerOrdersCache = orders;
      renderCustomerOrders();
      focusPendingOrder();
    }
  } catch (error) {
    console.error(error);
  }
}

function showCustomerPage(page, updateHash = true) {
  if (!Object.hasOwn(customerPageHashes, page)) page = "order";
  $("#customer-nav").hidden = false;
  if (page !== "orders") $("#order-success").hidden = true;
  document.querySelectorAll(".customer-page").forEach((section) => {
    section.hidden = section.id !== `customer-page-${page}`;
  });
  document.querySelectorAll("[data-page-link]").forEach((button) => {
    const active = button.dataset.pageLink === page;
    if (button.classList.contains("nav-link")) {
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });
  const navLinks = [...document.querySelectorAll("#customer-nav .nav-link")];
  $("#customer-nav").style.setProperty("--active-index", String(Math.max(0, navLinks.findIndex((link) => link.dataset.pageLink === page))));
  if (updateHash && window.location.hash !== customerPageHashes[page]) {
    window.location.hash = customerPageHashes[page];
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showApp(user) {
  currentUser = user;
  document.body.classList.remove("auth-screen");
  $("#auth-view").hidden = true;
  $("#app-view").hidden = false;
  $("#account-bar").hidden = false;
  $("#account-name").textContent = user.username;
  $("#welcome-name").textContent = user.username;
  $("#customer-view").hidden = user.role === "admin";
  $("#customer-nav").hidden = user.role === "admin";
  $("#admin-view").hidden = user.role !== "admin";
  if (user.role !== "admin") {
    if ($("#product-list").children.length === 0) addProductRow();
    // Destination présélectionnée selon le pays de la personne (modifiable dans le formulaire).
    if (!$("#order-form [name=location]").value) {
      $("#order-form [name=destination]").value = userCountry();
    }
    if (!openOrderFromHash()) {
      const initialPage = Object.keys(customerPageHashes).find((page) => customerPageHashes[page] === window.location.hash) || "order";
      showCustomerPage(initialPage, window.location.hash !== customerPageHashes[initialPage]);
    }
  }
  loadOrders();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(loadOrders, 20000);
}

$("#login-tab").addEventListener("click", () => setAuthMode(false));
$("#signup-tab").addEventListener("click", () => setAuthMode(true));
$("#auth-switch-button").addEventListener("click", () => setAuthMode(!signupMode));
$("#toggle-password").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const input = $("#auth-password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  button.setAttribute("aria-pressed", String(show));
  button.setAttribute("aria-label", show ? "Masquer le mot de passe" : "Afficher le mot de passe");
  button.querySelector("use").setAttribute("href", show ? "#i-eye" : "#i-eye-off");
});
$("#close-order-success").addEventListener("click", () => { $("#order-success").hidden = true; });

// Grand écran : panneau de navigation réductible, choix mémorisé sur cet appareil.
const NAV_COLLAPSED_KEY = "ck-nav-collapsed";
function setNavCollapsed(collapsed) {
  $("#customer-view").classList.toggle("nav-collapsed", collapsed);
  const button = $("#nav-collapse");
  const label = collapsed ? "Agrandir le menu" : "Réduire le menu";
  button.setAttribute("aria-expanded", String(!collapsed));
  button.title = label;
  button.querySelector("span").textContent = label;
  try {
    localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Stockage indisponible (navigation privée) : le choix vaut pour cette visite seulement.
  }
}
try {
  if (localStorage.getItem(NAV_COLLAPSED_KEY) === "1") setNavCollapsed(true);
} catch {
  // Stockage indisponible : panneau agrandi par défaut.
}
$("#nav-collapse").addEventListener("click", () => {
  setNavCollapsed(!$("#customer-view").classList.contains("nav-collapsed"));
});
// Icône de boutique indisponible : on affiche son initiale à la place.
document.querySelectorAll(".marketplace-icon img").forEach((image) => {
  const fallback = () => image.closest(".marketplace-icon").classList.add("is-fallback");
  if (image.complete && !image.naturalWidth) fallback();
  else image.addEventListener("error", fallback, { once: true });
});
document.querySelector(".order-filters").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-order-filter]");
  if (!chip) return;
  customerOrderFilter = chip.dataset.orderFilter;
  document.querySelectorAll("[data-order-filter]").forEach((button) => {
    const active = button === chip;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderCustomerOrders();
});
$("#contact-menu-toggle").addEventListener("click", () => {
  const menu = $("#contact-menu");
  const isOpening = menu.hidden;
  menu.hidden = !isOpening;
  $("#contact-menu-toggle").setAttribute("aria-expanded", String(isOpening));
});
document.addEventListener("click", (event) => {
  if (event.target.closest(".contact-menu-wrap")) return;
  $("#contact-menu").hidden = true;
  $("#contact-menu-toggle").setAttribute("aria-expanded", "false");
});
$("#contact-menu").addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  $("#contact-menu").hidden = true;
  $("#contact-menu-toggle").setAttribute("aria-expanded", "false");
  $("#contact-menu-toggle").focus();
});
$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#auth-message");
  const submit = $("#auth-submit");
  message.textContent = "";
  const form = new FormData(event.currentTarget);
  submit.disabled = true;
  submit.classList.add("is-loading");
  try {
    const data = await api(signupMode ? "/api/signup" : "/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
        ...(signupMode ? { country: form.get("country") || guessCountry() } : {})
      })
    });
    if (isAdminRoute && data.user.role !== "admin") {
      await api("/api/logout", { method: "POST", body: "{}" });
      throw new Error("Accès réservé à l'administration.");
    }
    showApp(data.user);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.classList.remove("is-loading");
  }
});

$("#logout-button").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  clearInterval(refreshTimer);
  currentUser = null;
  document.body.classList.add("auth-screen");
  $("#auth-view").hidden = false;
  $("#app-view").hidden = true;
  $("#account-bar").hidden = true;
  $("#auth-form").reset();
  customerOrdersCache = [];
  lastCustomerOrdersHtml = "";
  $("#orders-list").innerHTML = "";
  history.replaceState(null, "", window.location.pathname + window.location.search);
});

$("#customer-view").addEventListener("click", (event) => {
  const button = event.target.closest("[data-page-link]");
  if (button) showCustomerPage(button.dataset.pageLink);
});
$("#admin-order-search").addEventListener("input", renderAdminOrders);
$("#orders-list").addEventListener("submit", async (event) => {
  const form = event.target.closest(".payment-proof-form");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector("button[type=submit]");
  const message = form.querySelector(".payment-proof-message");
  const data = new FormData(form);
  const file = data.get("proofFile");
  if (!(file instanceof File) || !file.size) {
    message.textContent = "Sélectionnez le reçu de paiement.";
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    message.textContent = "Le fichier ne doit pas dépasser 5 Mo.";
    return;
  }
  button.disabled = true;
  message.textContent = "Envoi du reçu…";
  try {
    await api(`/api/orders/${form.dataset.orderId}/payment-proof`, {
      method: "POST",
      body: JSON.stringify({
        proofData: await readFileAsDataUrl(file),
        paymentMethod: data.get("paymentMethod"),
        paymentReference: data.get("paymentReference")
      })
    });
    await loadOrders();
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
});
window.addEventListener("hashchange", () => {
  if (!currentUser || currentUser.role === "admin") return;
  if (openOrderFromHash()) return;
  const page = Object.keys(customerPageHashes).find((key) => customerPageHashes[key] === window.location.hash) || "order";
  showCustomerPage(page, false);
});

$("#add-product").addEventListener("click", addProductRow);
$("#open-map").addEventListener("click", openDeliveryMap);
$("#locate-on-map").addEventListener("click", () => locateOnMap());
$("#map-search").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  const query = event.target.value.trim();
  if (query.length < 3) {
    searchRequestId += 1;
    hideSearchResults();
    return;
  }
  searchTimer = setTimeout(() => searchAddress(query), 450);
});
$("#map-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const first = $("#map-search-results button");
  if (first) first.click();
  else if (event.currentTarget.querySelector("input").value.trim().length >= 3) searchAddress($("#map-search").value.trim());
});
$("#map-search-results").addEventListener("click", (event) => {
  const result = event.target.closest("button[data-lat]");
  if (!result) return;
  $("#map-search").value = result.querySelector("strong").textContent;
  $("#map-search").blur();
  hideSearchResults();
  moveMapTo({ lat: Number(result.dataset.lat), lng: Number(result.dataset.lng) }, 17);
});
$("#close-map").addEventListener("click", closeDeliveryMap);
$("#cancel-map").addEventListener("click", closeDeliveryMap);
$("#confirm-map").addEventListener("click", confirmDeliveryLocation);
$("#map-link-form").addEventListener("submit", useMapPositionLink);
$("#map-position-link").addEventListener("input", (event) => event.target.setCustomValidity(""));
$("#map-modal").addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDeliveryMap();
});
$("#next-step").addEventListener("click", () => {
  if (checkoutStep === 1 && !validateProducts()) return;
  if (checkoutStep === 2) {
    if (!$("#order-form [name=location]").value) {
      $("#order-message").textContent = "Choisissez votre adresse sur la carte pour continuer.";
      openDeliveryMap();
      return;
    }
    const requiredFields = [...$("#order-form").querySelectorAll("[data-checkout-step='2'] [required]")];
    for (const field of requiredFields) {
      if (!field.reportValidity()) return;
    }
  }
  setCheckoutStep(checkoutStep + 1);
});
$("#previous-step").addEventListener("click", () => setCheckoutStep(checkoutStep - 1));
$("#edit-quote-request").addEventListener("click", () => $("#quote-notice").close());
$("#confirm-quote-request").addEventListener("click", () => {
  $("#quote-notice").close();
  quoteNoticeConfirmed = true;
  $("#order-form").requestSubmit();
});
$("#product-list").addEventListener("input", (event) => {
  if (event.target.matches(".product-price, .product-quantity")) refreshQuote();
});
$("#order-form [name=destination]").addEventListener("change", () => {
  refreshQuote();
  $("#order-form [name=location]").value = "";
  $("#map-latitude").value = "";
  $("#map-longitude").value = "";
  $("#location-coordinates").textContent = "";
  selectedMapLink = "";
  $("#map-position-link").value = "";
  if ($("#map-modal").hidden || !deliveryMap) return;
  resetMapSelection();
  deliveryMap.jumpTo({ center: mapCoordinates(destinationMapCenter()), zoom: 13 });
});
$("#order-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!quoteNoticeConfirmed) {
    $("#quote-notice").showModal();
    return;
  }
  quoteNoticeConfirmed = false;
  const button = $("#submit-order");
  const message = $("#order-message");
  message.textContent = "";
  button.disabled = true;
  try {
    const form = new FormData(event.currentTarget);
    const items = [];
    for (const row of $("#product-list").children) {
      const file = row.querySelector(".product-image-file").files[0];
      items.push({
        name: row.querySelector(".product-name").value,
        link: row.querySelector(".product-link").value.trim(),
        quantity: Number(row.querySelector(".product-quantity").value) || 1,
        priceEur: row.querySelector(".product-price").value || null,
        imageUrl: file ? "" : row.querySelector(".image-url").value.trim(),
        imageData: file ? await readFileAsDataUrl(file) : ""
      });
    }
    const values = {
      customerName: form.get("customerName"),
      phone: form.get("phone"),
      destination: form.get("destination"),
      location: form.get("location"),
      notes: form.get("notes"),
      shippingMode: form.get("shippingMode"),
      items
    };
    const { order } = await api("/api/orders", { method: "POST", body: JSON.stringify(values) });
    [...$("#product-list").querySelectorAll(".image-preview")].forEach((image) => {
      if (image.src.startsWith("blob:")) URL.revokeObjectURL(image.src);
    });
    $("#order-form").reset();
    $("#order-form [name=destination]").value = userCountry();
    $("#map-latitude").value = "";
    $("#map-longitude").value = "";
    $("#location-coordinates").textContent = "";
    selectedMapLink = "";
    $("#map-position-link").value = "";
    selectedMapPoint = null;
    $("#product-list").innerHTML = "";
    addProductRow();
    setCheckoutStep(1);
    await loadOrders();
    showOrderSuccess(order);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#admin-orders").addEventListener("change", async (event) => {
  const select = event.target.closest("select[data-order-id]");
  if (!select) return;
  const order = adminOrdersCache.find((candidate) => String(candidate.id) === select.dataset.orderId);
  const target = openBlankWindow();
  select.disabled = true;
  try {
    await api(`/api/orders/${select.dataset.orderId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: select.value })
    });
    if (order) sendWhatsapp(target, customerWhatsappUrl(order, statusWhatsappMessage(order, select.value)));
    else target?.close();
    await loadOrders();
  } catch (error) {
    target?.close();
    window.alert(error.message);
    await loadOrders();
  }
});

$("#admin-orders").addEventListener("click", async (event) => {
  const proofButton = event.target.closest("button[data-proof-order-id]");
  if (proofButton) {
    const proofWindow = window.open("about:blank", "_blank");
    if (!proofWindow) {
      window.alert("Autorisez les fenêtres pop-up pour consulter la preuve.");
      return;
    }
    proofWindow.opener = null;
    proofButton.disabled = true;
    try {
      const { url } = await api(`/api/orders/${proofButton.dataset.proofOrderId}/payment-proof-link`, {
        method: "POST",
        body: "{}"
      });
      proofWindow.location.href = url;
    } catch (error) {
      proofWindow.close();
      window.alert(error.message);
    } finally {
      proofButton.disabled = false;
    }
    return;
  }
  const verifyButton = event.target.closest("button[data-verify-payment-id]");
  if (verifyButton) {
    const order = adminOrdersCache.find((candidate) => String(candidate.id) === verifyButton.dataset.verifyPaymentId);
    if (!order || !window.confirm(`Confirmer que vous avez bien reçu ${formatFcfa(order.quoteTotalFcfa)} par MoMo pour ${order.reference} ?`)) return;
    const target = openBlankWindow();
    verifyButton.disabled = true;
    try {
      await api(`/api/orders/${order.id}/payment-status`, {
        method: "PATCH",
        body: JSON.stringify({ paymentStatus: "verified" })
      });
      sendWhatsapp(target, customerWhatsappUrl(order, [
        `Bonjour ${order.customerName},`,
        `Nous avons bien reçu votre paiement MoMo de ${formatFcfa(order.quoteTotalFcfa)} pour la commande ${order.reference}.`,
        "Nous commandons vos articles auprès du vendeur."
      ]));
      await loadOrders();
    } catch (error) {
      target?.close();
      window.alert(error.message);
      verifyButton.disabled = false;
    }
    return;
  }
  const shippingPaidButton = event.target.closest("button[data-shipping-paid-id]");
  if (shippingPaidButton) {
    if (!window.confirm("Confirmer que les frais d'expédition ont bien été reçus ?")) return;
    const order = adminOrdersCache.find((candidate) => String(candidate.id) === shippingPaidButton.dataset.shippingPaidId);
    const target = openBlankWindow();
    shippingPaidButton.disabled = true;
    try {
      await api(`/api/orders/${shippingPaidButton.dataset.shippingPaidId}/shipping-paid`, { method: "PATCH", body: "{}" });
      if (order) {
        sendWhatsapp(target, customerWhatsappUrl(order, [
          `Bonjour ${order.customerName},`,
          `Nous avons bien reçu les frais d'expédition de la commande ${order.reference}. Votre colis part très bientôt.`
        ]));
      } else target?.close();
      await loadOrders();
    } catch (error) {
      target?.close();
      window.alert(error.message);
      shippingPaidButton.disabled = false;
    }
    return;
  }
  const quoteButton = event.target.closest("button[data-quote-id]");
  const shippingButton = event.target.closest("button[data-shipping-id]");
  const button = quoteButton || shippingButton;
  if (!button) return;
  const orderId = quoteButton ? quoteButton.dataset.quoteId : shippingButton.dataset.shippingId;
  const order = adminOrdersCache.find((candidate) => String(candidate.id) === orderId);
  if (!order) return;
  const inputs = quoteButton
    ? [$(`#articles-eur-${orderId}`)]
    : [$(`#weight-kg-${orderId}`), $(`#shipping-eur-${orderId}`)].filter(Boolean);
  if (!inputs.every((input) => input.reportValidity())) return;
  const whatsappWindow = window.open("about:blank", "_blank");
  if (!whatsappWindow) {
    window.alert("Autorisez les fenêtres pop-up pour ouvrir WhatsApp.");
    return;
  }
  whatsappWindow.opener = null;
  button.disabled = true;
  try {
    let text;
    if (quoteButton) {
      const result = await api(`/api/orders/${orderId}/quote`, {
        method: "PATCH",
        body: JSON.stringify({ articlesEur: Number(inputs[0].value) })
      });
      const total = roundCents(result.articlesEur + result.commissionEur);
      text = [
        `Bonjour ${order.customerName},`,
        `Votre panier pour la commande ${order.reference} est prêt :`,
        `- Articles : ${formatEur(result.articlesEur)}`,
        `- Commission : ${formatEur(result.commissionEur)}`,
        `Total à payer par MoMo : ${formatEur(total)}, soit ${formatFcfa(result.quoteTotalFcfa)} (1 € = ${EUR_TO_FCFA} FCFA).`,
        "Après le paiement, envoyez votre reçu depuis le lien ci-dessous : nous commandons vos articles dès sa vérification."
      ].join("\n");
    } else {
      const weightInput = $(`#weight-kg-${orderId}`);
      const shippingInput = $(`#shipping-eur-${orderId}`);
      const result = await api(`/api/orders/${orderId}/shipping`, {
        method: "PATCH",
        body: JSON.stringify({
          weightKg: weightInput.value ? Number(weightInput.value) : null,
          shippingEur: shippingInput ? Number(shippingInput.value) : null
        })
      });
      const detail = order.shippingMode === "avion"
        ? `Expédition par avion : ${formatNumber(result.weightKg)} kg × ${AIR_RATE_EUR_PER_KG} € = ${formatEur(result.shippingEur)}`
        : `Expédition par bateau${result.weightKg ? ` (${formatNumber(result.weightKg)} kg)` : ""} : ${formatEur(result.shippingEur)}`;
      text = [
        `Bonjour ${order.customerName},`,
        `Votre commande ${order.reference} est arrivée à notre adresse en France.`,
        `${detail}, soit ${formatFcfa(result.shippingFcfa)}.`,
        "Merci de régler ce montant par MoMo et de nous envoyer le reçu : nous expédions votre colis dès réception."
      ].join("\n");
    }
    sendWhatsapp(whatsappWindow, customerWhatsappUrl(order, text.split("\n")));
    await loadOrders();
  } catch (error) {
    whatsappWindow.close();
    window.alert(error.message);
    button.disabled = false;
  }
});

// --- Gestion admin : filtres, modification, annulation, suppression, refus de reçu ---
document.querySelector(".admin-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-admin-filter]");
  if (!button) return;
  adminOrderFilter = button.dataset.adminFilter;
  document.querySelectorAll("[data-admin-filter]").forEach((chip) => {
    const active = chip === button;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", String(active));
  });
  lastAdminOrdersHtml = "";
  renderAdminOrders();
});

let editingOrderId = null;

function editItemRow(item = {}) {
  const off = item.available === false;
  return `<fieldset class="edit-item">
    <div class="edit-item-head">
      <strong>Article</strong>
      <label class="edit-available"><input type="checkbox" name="available" ${off ? "" : "checked"}> Disponible</label>
      <button class="text-button edit-remove-item" type="button">Retirer</button>
    </div>
    <label>Nom<input name="name" maxlength="120" value="${escapeHtml(item.name || "")}" placeholder="Nom de l'article"></label>
    <label>Lien<input name="link" type="url" required maxlength="2000" value="${escapeHtml(item.link || "")}" placeholder="https://…"></label>
    <div class="edit-row">
      <label>Quantité<input name="quantity" type="number" min="1" max="99" step="1" required value="${item.quantity || 1}"></label>
      <label>Prix unitaire (€)<input name="priceEur" type="number" min="0.01" step="0.01" value="${item.priceEur ?? ""}"></label>
    </div>
    <label>Commentaire (visible par le client)<input name="adminComment" maxlength="200" value="${escapeHtml(item.adminComment || "")}" placeholder="Ex. rupture de stock, taille épuisée…"></label>
  </fieldset>`;
}

function openAdminEdit(order) {
  editingOrderId = order.id;
  $("#admin-edit-title").textContent = `Réf. ${order.reference}`;
  $("#admin-edit-message").textContent = "";
  const shippingLocked = order.shippingEur !== null && order.shippingEur !== undefined;
  $("#admin-edit-fields").innerHTML = `
    <h3 class="edit-section">Articles</h3>
    <div id="edit-items">${order.items.map(editItemRow).join("")}</div>
    <button id="edit-add-item" class="text-button" type="button">+ Ajouter un article</button>
    <h3 class="edit-section">Livraison</h3>
    <label>Destinataire<input name="customerName" required maxlength="100" value="${escapeHtml(order.customerName)}"></label>
    <label>Téléphone<input name="phone" required maxlength="30" value="${escapeHtml(order.phone)}"></label>
    <label>Adresse<textarea name="location" required maxlength="300" rows="2">${escapeHtml(order.location)}</textarea></label>
    <div class="edit-row">
      <label>Pays<select name="destination">
        <option value="benin" ${order.destination === "benin" ? "selected" : ""}>Bénin</option>
        <option value="togo" ${order.destination === "togo" ? "selected" : ""}>Togo</option>
      </select></label>
      <label>Expédition<select name="shippingMode" ${shippingLocked ? "disabled" : ""}>
        <option value="avion" ${order.shippingMode === "avion" ? "selected" : ""}>Avion</option>
        <option value="bateau" ${order.shippingMode === "bateau" ? "selected" : ""}>Bateau</option>
      </select></label>
    </div>
    <h3 class="edit-section">Messages</h3>
    <label>Message affiché au client<textarea name="customerMessage" maxlength="500" rows="2" placeholder="Ex. L'article 2 est en rupture, le montant a été ajusté.">${escapeHtml(order.customerMessage || "")}</textarea></label>
    <label>Note interne (invisible pour le client)<textarea name="adminNote" maxlength="2000" rows="2" placeholder="Ex. remboursé 15 000 FCFA le 18/11, suivi colis…">${escapeHtml(order.adminNote || "")}</textarea></label>`;
  $("#admin-edit").showModal();
}

$("#admin-edit-fields").addEventListener("click", (event) => {
  if (event.target.closest("#edit-add-item")) {
    $("#edit-items").insertAdjacentHTML("beforeend", editItemRow());
    return;
  }
  const remove = event.target.closest(".edit-remove-item");
  if (remove) {
    if ($("#edit-items").children.length <= 1) {
      $("#admin-edit-message").textContent = "Une commande garde au moins un article : annulez-la plutôt.";
      return;
    }
    remove.closest(".edit-item").remove();
  }
});
$("#admin-edit-cancel").addEventListener("click", () => $("#admin-edit").close());
$("#admin-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const field = (name) => form.querySelector(`[name=${name}]`);
  const items = [...form.querySelectorAll(".edit-item")].map((row) => ({
    name: row.querySelector("[name=name]").value,
    link: row.querySelector("[name=link]").value,
    quantity: Number(row.querySelector("[name=quantity]").value),
    priceEur: row.querySelector("[name=priceEur]").value ? Number(row.querySelector("[name=priceEur]").value) : null,
    available: row.querySelector("[name=available]").checked,
    adminComment: row.querySelector("[name=adminComment]").value
  }));
  const body = {
    items,
    customerName: field("customerName").value,
    phone: field("phone").value,
    location: field("location").value,
    destination: field("destination").value,

    customerMessage: field("customerMessage").value,
    adminNote: field("adminNote").value
  };
  if (!field("shippingMode").disabled) body.shippingMode = field("shippingMode").value;
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  $("#admin-edit-message").textContent = "Enregistrement…";
  try {
    await api(`/api/orders/${editingOrderId}`, { method: "PATCH", body: JSON.stringify(body) });
    $("#admin-edit").close();
    lastAdminOrdersHtml = "";
    await loadOrders();
  } catch (error) {
    $("#admin-edit-message").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$("#admin-orders").addEventListener("click", async (event) => {
  const notify = event.target.closest("[data-notify-order-id]");
  if (notify) {
    const order = adminOrdersCache.find((candidate) => String(candidate.id) === notify.dataset.notifyOrderId);
    if (order) sendWhatsapp(openBlankWindow(), customerWhatsappUrl(order, statusWhatsappMessage(order)));
    return;
  }
  const button = event.target.closest("[data-edit-order-id], [data-cancel-order-id], [data-restore-order-id], [data-delete-order-id], [data-reject-payment-id]");
  if (!button) return;
  const id = button.dataset.editOrderId || button.dataset.cancelOrderId || button.dataset.restoreOrderId
    || button.dataset.deleteOrderId || button.dataset.rejectPaymentId;
  const order = adminOrdersCache.find((candidate) => String(candidate.id) === id);
  if (!order) return;
  if (button.dataset.editOrderId) {
    openAdminEdit(order);
    return;
  }
  let request;
  if (button.dataset.cancelOrderId) {
    const reason = window.prompt(`Motif d'annulation de ${order.reference} (visible par le client) :`, "Articles indisponibles");
    if (reason === null) return;
    request = [`/api/orders/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }];
  } else if (button.dataset.restoreOrderId) {
    request = [`/api/orders/${id}/restore`, { method: "POST", body: "{}" }];
  } else if (button.dataset.deleteOrderId) {
    const warning = order.paymentStatus === "verified"
      ? "\n\nAttention : cette commande a été payée. Préférez « Annuler » pour garder une trace."
      : "";
    if (!window.confirm(`Supprimer définitivement la commande ${order.reference} ? Cette action est irréversible.${warning}`)) return;
    request = [`/api/orders/${id}`, { method: "DELETE" }];
  } else {
    const reason = window.prompt("Pourquoi refuser ce reçu ? (le client verra ce message)", "le montant ne correspond pas");
    if (reason === null) return;
    request = [`/api/orders/${id}/payment-status`, { method: "PATCH", body: JSON.stringify({ paymentStatus: "rejected", reason }) }];
  }
  let whatsappLines = null;
  if (button.dataset.cancelOrderId) {
    whatsappLines = [`Bonjour ${order.customerName},`, `Votre commande ${order.reference} a été annulée : ${JSON.parse(request[1].body).reason || "voir le détail"}.`];
  } else if (button.dataset.rejectPaymentId) {
    whatsappLines = [`Bonjour ${order.customerName},`, `Votre reçu de paiement pour la commande ${order.reference} n'a pas pu être validé : ${JSON.parse(request[1].body).reason}.`, "Merci de nous renvoyer un reçu."];
  }
  const target = whatsappLines ? openBlankWindow() : null;
  button.disabled = true;
  try {
    await api(...request);
    if (whatsappLines) sendWhatsapp(target, customerWhatsappUrl(order, whatsappLines));
    lastAdminOrdersHtml = "";
    await loadOrders();
  } catch (error) {
    window.alert(error.message);
    button.disabled = false;
  }
});

// Le client peut annuler sa demande tant qu'il n'a rien payé.
$("#orders-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cancel-own-id]");
  if (!button) return;
  if (!window.confirm("Annuler cette demande ? Votre assistant en sera informé.")) return;
  button.disabled = true;
  try {
    await api(`/api/orders/${button.dataset.cancelOwnId}/cancel`, { method: "POST", body: "{}" });
    await loadOrders();
  } catch (error) {
    window.alert(error.message);
    button.disabled = false;
  }
});

$("#admin-orders").addEventListener("input", (event) => {
  const input = event.target;
  if (input.matches(".articles-eur-input")) {
    $(`#quote-preview-${input.dataset.previewId}`).textContent = quotePreviewText(input.value);
  } else if (input.matches(".weight-kg-input") && input.dataset.mode === "avion") {
    $(`#shipping-preview-${input.dataset.previewId}`).textContent = shippingPreviewText(input.value);
  }
});

if (isAdminRoute) {
  document.body.classList.add("admin-entry");
  $("#auth-view .eyebrow").textContent = "ESPACE ADMINISTRATEUR";
  $("#auth-view h1").textContent = "Administration";
  $("#auth-view .intro-copy").textContent = "Connectez-vous pour envoyer les paniers, vérifier les paiements MoMo et gérer les expéditions.";
  $("#auth-view .steps-note").hidden = true;
  $("#signup-tab").hidden = true;
  $("#auth-switch").hidden = true;
  $(".auth-panel .tabs").hidden = true;
  $("#auth-title").textContent = "Espace admin";
  $("#auth-subtitle").textContent = "Accès réservé à l'équipe CK";
  $("#auth-submit").textContent = "Accéder à l'administration";
}

api("/api/me").then(({ user }) => {
  if (!isAdminRoute || user.role === "admin") showApp(user);
}).catch((error) => {
  // Serveur mal configuré (ex. base non mise à jour) : on l'affiche au lieu d'échouer en silence.
  if (error.setup) $("#auth-message").textContent = error.message;
}).finally(hidePreloader);

$("#whatsapp-fallback").addEventListener("click", (event) => {
  if (event.target.closest("a, button")) $("#whatsapp-fallback").hidden = true;
});

$("#admin-orders").addEventListener("click", (event) => {
  const opener = event.target.closest("[data-open-sheet]");
  if (opener) {
    setAdminSheet(opener.dataset.openSheet);
    return;
  }
  if (event.target.closest("[data-close-sheet]")) setAdminSheet(null);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openAdminSheetId !== null && !$("#admin-edit").open) setAdminSheet(null);
});
