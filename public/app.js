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
let deliveryMarker = null;
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
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Une erreur est survenue.");
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
  const remaining = reducedMotion ? 0 : Math.max(0, 1600 - (performance.now() - preloaderStartedAt));
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
  $("#previous-step").hidden = step === 1;
  $("#next-step").hidden = step === 3;
  $("#submit-order").hidden = step !== 3;
  $("#order-message").textContent = "";
  if (step === 3) updateCheckoutReview();
}

function updateMapSelection(latlng) {
  selectedMapPoint = { lat: latlng.lat, lng: latlng.lng };
  if (!deliveryMarker) {
    deliveryMarker = new maplibregl.Marker({ draggable: true })
      .setLngLat([latlng.lng, latlng.lat])
      .addTo(deliveryMap);
    deliveryMarker.on("dragend", () => {
      const position = deliveryMarker.getLngLat();
      updateMapSelection({ lat: position.lat, lng: position.lng });
    });
  } else {
    deliveryMarker.setLngLat([latlng.lng, latlng.lat]);
  }
  const coordinates = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  selectedMapLink = "";
  $("#map-position-link").value = "";
  $("#map-selection-title").textContent = "Emplacement sélectionné";
  $("#map-selection-detail").textContent = `Coordonnées : ${coordinates}`;
  $("#confirm-map").disabled = false;
}

function mapDefaultLocation() {
  const savedLat = Number($("#map-latitude").value);
  const savedLng = Number($("#map-longitude").value);
  if (Number.isFinite(savedLat) && Number.isFinite(savedLng) && savedLat && savedLng) {
    return [savedLat, savedLng];
  }
  return destinationMapCenter();
}

function destinationMapCenter() {
  return $("#order-form [name=destination]").value === "togo"
    ? [6.1375, 1.2123]
    : [6.3703, 2.3912];
}

function mapCoordinates([lat, lng]) {
  return [lng, lat];
}

function resetMapSelection() {
  selectedMapPoint = null;
  selectedMapLink = "";
  $("#map-position-link").value = "";
  if (deliveryMarker) {
    deliveryMap.removeLayer(deliveryMarker);
    deliveryMarker = null;
  }
  $("#map-selection-title").textContent = "Lien de position";
  $("#map-selection-detail").textContent = "Collez un lien Google Maps ou choisissez un point sur la carte.";
  $("#confirm-map").disabled = true;
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
  if (deliveryMarker) {
    deliveryMap.removeLayer(deliveryMarker);
    deliveryMarker = null;
  }
  selectedMapPoint = null;
  selectedMapLink = url.toString();
  const coordinates = coordinatesFromMapUrl(url);
  if (coordinates) {
    deliveryMap.flyTo({ center: [coordinates.lng, coordinates.lat], zoom: 16 });
    updateMapSelection(coordinates);
    selectedMapLink = url.toString();
    input.value = selectedMapLink;
    $("#map-selection-title").textContent = "Lien de position prêt";
    $("#map-selection-detail").textContent = "Le repère a été placé aux coordonnées du lien.";
  } else {
    $("#map-latitude").value = "";
    $("#map-longitude").value = "";
    $("#map-selection-title").textContent = "Lien de position prêt";
    $("#map-selection-detail").textContent = "Ce lien sera enregistré avec la commande.";
  }
  $("#confirm-map").disabled = false;
}

function openDeliveryMap() {
  $("#map-modal").hidden = false;
  document.body.classList.add("map-open");
  if (!deliveryMap) {
    deliveryMap = new maplibregl.Map({
      container: "delivery-map",
      style: "https://tiles.openfreemap.org/styles/positron",
      center: mapCoordinates(mapDefaultLocation()),
      zoom: 14,
      attributionControl: false
    });
    deliveryMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    deliveryMap.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    deliveryMap.getContainer().classList.add("map-grayscale");
    deliveryMap.on("click", (event) => updateMapSelection(event.lngLat));
  } else {
    deliveryMap.jumpTo({ center: mapCoordinates(mapDefaultLocation()), zoom: 14 });
  }
  const savedLat = Number($("#map-latitude").value);
  const savedLng = Number($("#map-longitude").value);
  if (selectedMapLink) {
    if (Number.isFinite(savedLat) && Number.isFinite(savedLng) && savedLat && savedLng) {
      updateMapSelection({ lat: savedLat, lng: savedLng });
      selectedMapLink = $("#order-form [name=location]").value;
    }
    $("#map-position-link").value = selectedMapLink;
    $("#map-selection-title").textContent = "Lien de position prêt";
    $("#map-selection-detail").textContent = "Ce lien sera enregistré avec la commande.";
    $("#confirm-map").disabled = false;
  } else if (Number.isFinite(savedLat) && Number.isFinite(savedLng) && savedLat && savedLng) {
    updateMapSelection({ lat: savedLat, lng: savedLng });
  } else {
    resetMapSelection();
  }
  window.setTimeout(() => deliveryMap.resize(), 0);
  $("#close-map").focus();
}

function locateOnMap() {
  const button = $("#locate-on-map");
  const detail = $("#map-selection-detail");
  if (!navigator.geolocation) {
    detail.textContent = "La géolocalisation n'est pas prise en charge par ce navigateur.";
    return;
  }

  button.disabled = true;
  button.textContent = "Localisation…";
  detail.textContent = "Recherche de votre position GPS…";
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const point = { lat: coords.latitude, lng: coords.longitude };
      deliveryMap.flyTo({ center: [point.lng, point.lat], zoom: 17 });
      updateMapSelection(point);
      $("#map-selection-title").textContent = "Votre position est sélectionnée";
      detail.textContent = "Le repère indique votre position. Vous pouvez le déplacer avant de confirmer.";
      button.disabled = false;
      button.textContent = "◎ Me localiser";
    },
    (error) => {
      const messages = {
        1: "Autorisez l'accès à votre position dans les réglages du navigateur, puis réessayez.",
        2: "Votre position est indisponible. Vérifiez le GPS ou la connexion, puis réessayez.",
        3: "La recherche a pris trop de temps. Réessayez."
      };
      detail.textContent = messages[error.code] || "Impossible d'obtenir votre position. Réessayez.";
      button.disabled = false;
      button.textContent = "◎ Me localiser";
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

function closeDeliveryMap() {
  $("#map-modal").hidden = true;
  document.body.classList.remove("map-open");
  $("#open-map").focus();
}

async function confirmDeliveryLocation() {
  if (!selectedMapPoint && !selectedMapLink) return;
  $("#confirm-map").disabled = true;
  if (selectedMapLink) {
    $("#order-form [name=location]").value = selectedMapLink;
    if (selectedMapPoint) {
      $("#map-latitude").value = selectedMapPoint.lat.toFixed(5);
      $("#map-longitude").value = selectedMapPoint.lng.toFixed(5);
    } else {
      $("#map-latitude").value = "";
      $("#map-longitude").value = "";
    }
    $("#location-coordinates").textContent = "Lien de position ajouté.";
    closeDeliveryMap();
    return;
  }
  const { lat, lng } = selectedMapPoint;
  const latitude = lat.toFixed(5);
  const longitude = lng.toFixed(5);
  let address = `Position GPS ${latitude}, ${longitude}`;
  $("#confirm-map").textContent = "Recherche de l'adresse…";
  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", latitude);
    url.searchParams.set("lon", longitude);
    url.searchParams.set("zoom", "18");
    url.searchParams.set("accept-language", "fr");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Le service d'adresse a répondu ${response.status}.`);
    const result = await response.json();
    if (result.display_name) address = result.display_name;
  } catch (error) {
    console.warn("Adresse automatique indisponible :", error);
    $("#location-coordinates").textContent = "Adresse automatique indisponible ; les coordonnées GPS seront utilisées.";
  }
  const compactAddress = `${address.slice(0, 245)} (${latitude}, ${longitude})`;
  $("#order-form [name=location]").value = compactAddress;
  $("#map-latitude").value = latitude;
  $("#map-longitude").value = longitude;
  if (!$("#location-coordinates").textContent) {
    $("#location-coordinates").textContent = `Position GPS : ${latitude}, ${longitude}`;
  }
  $("#confirm-map").textContent = "Confirmer cette adresse";
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

function whatsappNumberFor(destination) {
  return destination === "benin" ? "22997158484" : "22890290081";
}

function renderItems(order) {
  return order.items.map((item) => {
    const quantity = item.quantity || 1;
    const label = `${quantity > 1 ? `${quantity} × ` : ""}${escapeHtml(item.name)}${item.priceEur ? ` · ${escapeHtml(formatEur(item.priceEur))}` : ""}`;
    const content = `${itemThumb(item.image)}<span>${label}</span>`;
    return item.link
      ? `<a class="item-chip" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${content}<span class="item-chip-arrow" aria-hidden="true">↗</span></a>`
      : `<span class="item-chip">${content}</span>`;
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
  return `<a class="button button-primary shipping-whatsapp" href="https://wa.me/${whatsappNumberFor(order.destination)}?text=${encodeURIComponent(message)}" target="_blank" rel="noopener noreferrer">Envoyer le reçu d'expédition sur WhatsApp</a>`;
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
  const paymentSection = order.paymentStatus === "proof_received" ? `
    <div class="payment-review">
      <strong>Reçu MoMo à vérifier</strong>
      <button class="button button-outline view-payment-proof" type="button" data-proof-order-id="${order.id}">Consulter le reçu</button>
      <button class="button button-primary verify-payment" type="button" data-verify-payment-id="${order.id}">Confirmer le paiement</button>
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
  return `<div class="admin-controls">
    ${quoteSection}${paymentSection}${shippingSection}
    ${order.shippingPaid ? '<div class="payment-verified">✓ Expédition payée</div>' : ""}
    <label class="admin-status-label">Suivi
      <select aria-label="Modifier le statut de la commande ${escapeHtml(order.reference)}" data-order-id="${order.id}">${statusOptions(order)}</select>
    </label>
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

function renderOrder(order, isAdmin) {
  const items = renderItems(order);
  if (!isAdmin) return renderTicket(order, items);
  const date = new Date(`${order.createdAt.replace(" ", "T")}Z`).toLocaleDateString("fr-FR");
  return `<article class="order-card admin-card">
    <div>
      <div class="order-top"><span class="order-id">Réf. ${escapeHtml(order.reference)}</span><span class="order-date">${date}</span><span class="order-destination">${order.destination === "benin" ? "Bénin" : "Togo"} · ${shippingModeNames[order.shippingMode]}</span><span class="status" data-status="${order.status}">${statusNames[order.status]}</span></div>
      <div class="order-items">${items}</div>
      <div class="admin-meta">Client : <strong>${escapeHtml(order.username)}</strong> · ${escapeHtml(order.customerName)}<br>
        Tél. ${escapeHtml(order.phone)} · ${escapeHtml(order.location)}${order.notes ? `<br>Note : ${escapeHtml(order.notes)}` : ""}
        ${order.subtotalEur ? `<br>Estimation client : ${escapeHtml(formatEur(order.subtotalEur))}` : ""}
      </div>
      <div class="cost-blocks">${quoteBreakdown(order)}${shippingBreakdown(order)}</div>
    </div>${adminControls(order)}
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
  const created = new Date(`${order.createdAt.replace(" ", "T")}Z`);
  const shortDate = created.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }).replace(".", "").toUpperCase();
  const isBenin = order.destination === "benin";
  const delivered = order.status === "livre";
  const stub = ticketStub(order);
  const costs = `${quoteBreakdown(order)}${shippingBreakdown(order)}`;
  const foot = `${costs ? `<div class="cost-blocks">${costs}</div>` : ""}${paymentProofFormFor(order)}${shippingProofLink(order)}`;
  return `<article class="order-card ticket${delivered ? " is-delivered" : ""}" data-group="${delivered ? "delivered" : "active"}">
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
          <div><dt>Statut</dt><dd><span class="status" data-status="${order.status}">${statusNames[order.status]}</span></dd></div>
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

let customerOrdersCache = [];
let customerOrderFilter = "all";
let lastCustomerOrdersHtml = "";

function renderCustomerOrders() {
  const orders = customerOrdersCache;
  const delivered = orders.filter((order) => order.status === "livre").length;
  $("#count-all").textContent = String(orders.length);
  $("#count-active").textContent = String(orders.length - delivered);
  $("#count-delivered").textContent = String(delivered);
  const visible = orders.filter((order) => {
    if (customerOrderFilter === "active") return order.status !== "livre";
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

function renderAdminOrders() {
  const search = $("#admin-order-search").value.trim();
  const normalizedSearch = search.toLocaleLowerCase("fr");
  const phoneSearch = search.replace(/\D/g, "");
  const orders = adminOrdersCache.filter((order) => {
    const matchesReference = order.reference.toLocaleLowerCase("fr").includes(normalizedSearch);
    const matchesPhone = phoneSearch && order.phone.replace(/\D/g, "").includes(phoneSearch);
    return matchesReference || matchesPhone;
  });
  $("#admin-search-results").textContent = search
    ? `${orders.length} commande(s) trouvée(s) sur ${adminOrdersCache.length}.`
    : `${adminOrdersCache.length} commande(s) au total.`;
  const html = orders.length
    ? orders.map((order) => renderOrder(order, true)).join("")
    : '<div class="empty-state">Aucune commande ne correspond à cette recherche.</div>';
  if (html === lastAdminOrdersHtml || isEditingInside("#admin-orders")) return;
  lastAdminOrdersHtml = html;
  $("#admin-orders").innerHTML = html;
}

let lastAdminOrdersHtml = "";
// Évite d'effacer une saisie en cours lors de l'actualisation automatique (toutes les 20 s).
function isEditingInside(selector) {
  const active = document.activeElement;
  return Boolean(active && active.matches("input, select, textarea") && $(selector).contains(active));
}

function showOrderConfirmation(order) {
  const destination = order.destination === "benin" ? "Bénin" : "Togo";
  const products = order.items.map((item) => `
    <div class="confirmation-product">
      ${itemThumb(item.image)}
      <div><strong>${item.quantity || 1} × ${escapeHtml(item.name)}</strong>
        <a class="review-link" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.link)}</a>
        <span>${item.priceEur ? `${escapeHtml(formatEur(item.priceEur))} l'unité (indicatif)` : "Prix à confirmer"}</span></div>
    </div>`).join("");
  $("#confirmation-reference").textContent = order.reference;
  $("#confirmation-summary").innerHTML = `
    <h2>Récapitulatif de la commande</h2>
    <div class="confirmation-products">${products}</div>
    <div class="confirmation-delivery">
      <strong>Livraison au ${destination} · ${shippingModeNames[order.shippingMode] || "Avion"}</strong>
      <span>${escapeHtml(order.customerName)} · ${escapeHtml(order.phone)}</span>
      <span>${escapeHtml(order.location)}</span>
      ${order.notes ? `<span>Précisions : ${escapeHtml(order.notes)}</span>` : ""}
    </div>`;
  const whatsappNumber = whatsappNumberFor(order.destination);
  const message = [
    `Bonjour, voici ma commande ${order.reference}.`,
    ...order.items.map((item) => `- ${item.quantity || 1} × ${item.name} : ${item.link}`),
    `Expédition : ${shippingModeNames[order.shippingMode] || "Avion"}.`,
    `Destinataire : ${order.customerName}, livraison au ${destination} : ${order.location}.`,
    "Merci de m'envoyer le montant exact de mon panier."
  ].join("\n");
  $("#send-order-whatsapp").href = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
  document.querySelectorAll(".customer-page").forEach((section) => { section.hidden = true; });
  $("#customer-nav").hidden = true;
  $("#customer-page-confirmation").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadOrders() {
  if (!currentUser) return;
  try {
    const { orders } = await api("/api/orders");
    const target = currentUser.role === "admin" ? $("#admin-orders") : $("#orders-list");
    if (currentUser.role === "admin") {
      adminOrdersCache = orders;
      $("#admin-quotes-pending").textContent = String(orders.filter((order) => order.status === "demande_recue").length);
      $("#admin-payments-pending").textContent = String(orders.filter((order) => order.paymentStatus === "proof_received").length);
      $("#admin-orders-to-ship").textContent = String(orders.filter((order) => order.status === "recu_france").length);
      renderAdminOrders();
    } else {
      $("#home-order-count").textContent = String(orders.length);
      customerOrdersCache = orders;
      renderCustomerOrders();
    }
  } catch (error) {
    console.error(error);
  }
}

function showCustomerPage(page, updateHash = true) {
  if (!Object.hasOwn(customerPageHashes, page)) page = "order";
  $("#customer-nav").hidden = false;
  $("#customer-page-confirmation").hidden = true;
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
    const initialPage = Object.keys(customerPageHashes).find((page) => customerPageHashes[page] === window.location.hash) || "order";
    showCustomerPage(initialPage, window.location.hash !== customerPageHashes[initialPage]);
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
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") })
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
  const page = Object.keys(customerPageHashes).find((key) => customerPageHashes[key] === window.location.hash) || "order";
  showCustomerPage(page, false);
});

$("#add-product").addEventListener("click", addProductRow);
$("#open-map").addEventListener("click", openDeliveryMap);
$("#locate-on-map").addEventListener("click", locateOnMap);
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
    showOrderConfirmation(order);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#admin-orders").addEventListener("change", async (event) => {
  const select = event.target.closest("select[data-order-id]");
  if (!select) return;
  select.disabled = true;
  try {
    await api(`/api/orders/${select.dataset.orderId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: select.value })
    });
    await loadOrders();
  } catch (error) {
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
    verifyButton.disabled = true;
    try {
      await api(`/api/orders/${verifyButton.dataset.verifyPaymentId}/payment-status`, {
        method: "PATCH",
        body: JSON.stringify({ paymentStatus: "verified" })
      });
      await loadOrders();
    } catch (error) {
      window.alert(error.message);
      verifyButton.disabled = false;
    }
    return;
  }
  const shippingPaidButton = event.target.closest("button[data-shipping-paid-id]");
  if (shippingPaidButton) {
    if (!window.confirm("Confirmer que les frais d'expédition ont bien été reçus ?")) return;
    shippingPaidButton.disabled = true;
    try {
      await api(`/api/orders/${shippingPaidButton.dataset.shippingPaidId}/shipping-paid`, { method: "PATCH", body: "{}" });
      await loadOrders();
    } catch (error) {
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
        "Après le paiement, envoyez votre reçu depuis « Mes commandes » : nous commandons vos articles dès sa vérification."
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
    let phone = order.phone.replace(/\D/g, "");
    if (phone.length === 8) phone = `${order.destination === "benin" ? "229" : "228"}${phone}`;
    whatsappWindow.location.href = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
    await loadOrders();
  } catch (error) {
    whatsappWindow.close();
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
}).catch(() => {}).finally(hidePreloader);
