import * as maplibregl from "maplibre-gl";

const statusNames = {
  demande_recue: "Demande reçue · devis à préparer",
  devis_envoye: "Devis envoyé · attente de paiement",
  colis_en_commande: "Votre colis est en commande",
  commande_fournisseur: "Commandée auprès du fournisseur",
  dans_avion: "Dans l'avion",
  arrive: "Arrivé au pays",
  livre: "Livré"
};
const statusOrder = [
  "demande_recue",
  "devis_envoye",
  "colis_en_commande",
  "commande_fournisseur",
  "dans_avion",
  "arrive",
  "livre"
];
const $ = (selector) => document.querySelector(selector);
let currentUser = null;
let signupMode = false;
let refreshTimer = null;
let checkoutStep = 1;
let deliveryMap = null;
let deliveryMarker = null;
let selectedMapPoint = null;
let selectedMapLink = "";
let quoteNoticeConfirmed = false;
const customerPageHashes = {
  home: "#accueil",
  orders: "#mes-commandes",
  order: "#commander"
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
  $("#auth-form [name=password]").autocomplete = signup ? "new-password" : "current-password";
  $("#auth-message").textContent = "";
}

function addProductRow() {
  const row = document.createElement("div");
  row.className = "product-row";
  row.innerHTML = `
    <div class="product-card-header"><strong>Produit <span class="product-number"></span></strong>
      <button class="remove-product" type="button" aria-label="Supprimer ce produit">×</button>
    </div>
    <button class="image-picker" type="button" aria-label="Ajouter une image au produit">
      <img class="image-preview" alt="Aperçu du produit" hidden>
      <span class="image-placeholder"><span class="plus-icon">＋</span><span>Ajouter une image</span></span>
    </button>
    <input class="product-image-file" type="file" accept="image/jpeg,image/png,image/webp">
    <div class="ai-recognition" aria-live="polite">
      <span class="ai-status">L'identification par photo démarre automatiquement.</span>
      <button class="apply-ai-suggestion" type="button" hidden>Utiliser la suggestion</button>
    </div>
    <label>Nom du produit<input class="product-name" required maxlength="120" placeholder="Nom du produit"></label>
    <label>Prix indicatif en euros (facultatif)<input class="product-price" type="number" min="0.01" max="1000000" step="0.01" placeholder="Non obligatoire"></label>
    <div class="image-control">
      <input class="image-url" type="url" placeholder="Ou collez le lien de l'image">
      <span class="image-error" aria-live="polite"></span>
    </div>
    <a class="product-search" href="https://www.google.com/search?q=site%3Aalibaba.com" target="_blank" rel="noopener noreferrer">Rechercher ce produit sur Google ↗</a>`;
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
  const searchLink = row.querySelector(".product-search");
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
      aiStatus.textContent = "L'identification par photo démarre automatiquement.";
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
  nameInput.addEventListener("input", (event) => {
    const query = `site:alibaba.com ${event.target.value.trim()}`;
    searchLink.href = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
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
  $("#checkout-title").textContent = ["", "1. Vos produits", "2. Livraison", "3. Vérification"][step];
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
    const name = row.querySelector(".product-name");
    const price = row.querySelector(".product-price");
    if (!name.reportValidity()) return false;
    if (price.value && !price.reportValidity()) return false;
    const file = row.querySelector(".product-image-file").files[0];
    const imageUrl = row.querySelector(".image-url");
    if (file && (file.size > 4 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type))) {
      $("#order-message").textContent = "Choisissez une image JPG, PNG ou WEBP de moins de 4 Mo.";
      return false;
    }
    if (!file && !imageUrl.value.trim()) {
      $("#order-message").textContent = "Ajoutez une image ou un lien d'image pour chaque produit.";
      imageUrl.focus();
      return false;
    }
    if (!file && !imageUrl.checkValidity()) {
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
  const items = [...$("#product-list").children].map((row) => {
    return {
      name: row.querySelector(".product-name").value,
      price: row.querySelector(".product-price").value,
      image: row.querySelector(".image-preview").src
    };
  });
  const products = items.map((item) => `
    <div class="review-product">
      <img src="${escapeHtml(item.image)}" alt="">
      <div><strong>${escapeHtml(item.name || "Produit")}</strong><span>${item.price ? `${escapeHtml(item.price)} € (indicatif)` : "Prix non indiqué"}</span></div>
    </div>`).join("");
  const phone = form.get("phone") || "Non renseigné";
  const name = form.get("customerName") || "Non renseigné";
  const location = form.get("location") || "Non renseignée";
  $("#checkout-review").innerHTML = `${products}
    <div class="review-delivery"><strong>Livraison au ${destination}</strong>
      <span>${escapeHtml(name)} · ${escapeHtml(phone)}</span>
      <span>${escapeHtml(location)}</span>
    </div>`;
  const prices = items.map((item) => Number(item.price)).filter((price) => Number.isFinite(price) && price > 0);
  const indicativeTotal = prices.reduce((sum, price) => sum + price, 0);
  $("#quote-products").textContent = prices.length
    ? `${formatNumber(Math.round(indicativeTotal * 100) / 100)} € (indicatif)`
    : "Non renseigné";
  $("#quote-shipping").textContent = "Inclus au devis";
  $("#quote-total").textContent = "Devis à venir";
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

function refreshQuote() {
  if (!$("#product-list")) return;
  const prices = [...$("#product-list").querySelectorAll(".product-price")]
    .map((input) => Number(input.value))
    .filter((price) => Number.isFinite(price) && price > 0);
  const indicativeTotal = prices.reduce((sum, price) => sum + price, 0);
  $("#quote-products").textContent = prices.length
    ? `${formatNumber(Math.round(indicativeTotal * 100) / 100)} € (indicatif)`
    : "Non renseigné";
  $("#quote-shipping").textContent = "Inclus au devis";
  $("#quote-total").textContent = "Devis à venir";
}

function statusOptions(current) {
  return statusOrder.map((status) =>
    `<option value="${status}" ${status === current ? "selected" : ""}>${statusNames[status]}</option>`
  ).join("");
}

function renderOrder(order, isAdmin) {
  const items = order.items.map((item) => `
    <span class="item-chip"><img src="${escapeHtml(item.image)}" alt=""><span>${escapeHtml(item.name)}${item.priceEur ? ` · ${formatNumber(item.priceEur)} € indicatif` : ""}</span></span>
  `).join("");
  const date = new Date(`${order.createdAt.replace(" ", "T")}Z`).toLocaleDateString("fr-FR");
  const adminInfo = isAdmin ? `
    <div class="admin-meta">Client : <strong>${escapeHtml(order.username)}</strong> · ${escapeHtml(order.customerName)}<br>
      Tél. ${escapeHtml(order.phone)} · ${escapeHtml(order.location)}${order.notes ? `<br>Note : ${escapeHtml(order.notes)}` : ""}
    </div>` : `<div class="order-address">${escapeHtml(order.location)} · ${escapeHtml(order.phone)}</div>`;
  const controls = isAdmin ? `
    <div class="admin-controls">
      <label class="admin-quote-label" for="quote-total-${order.id}">Devis final (FCFA)
        <input id="quote-total-${order.id}" type="number" required min="1" max="1000000000" step="1" value="${order.quoteTotalFcfa || ""}" placeholder="Montant total">
      </label>
      <button class="button button-primary send-quote" type="button" data-quote-id="${order.id}"
        data-reference="${escapeHtml(order.reference)}" data-phone="${escapeHtml(order.phone)}" data-customer="${escapeHtml(order.customerName)}" data-destination="${order.destination}">
        Enregistrer le devis et ouvrir WhatsApp
      </button>
      <label class="admin-status-label">Suivi
        <select aria-label="Modifier le statut du colis ${escapeHtml(order.reference)}" data-order-id="${order.id}">${statusOptions(order.status)}</select>
      </label>
    </div>
  ` : `<div class="order-summary">
    ${order.quoteTotalFcfa
      ? `<span>Devis reçu</span><strong>À payer : ${formatNumber(order.quoteTotalFcfa)} FCFA</strong>`
      : "<span>Le devis final vous sera envoyé sur WhatsApp.</span>"}
  </div>`;
  return `<article class="order-card ${isAdmin ? "admin-card" : ""}">
    <div>
      <div class="order-top"><span class="order-id">Réf. ${escapeHtml(order.reference)}</span><span class="order-date">${date}</span><span class="order-destination">${order.destination === "benin" ? "Bénin" : "Togo"}</span><span class="status" data-status="${order.status}">${statusNames[order.status]}</span></div>
      <div class="order-items">${items}</div>${adminInfo}
    </div>${controls}
  </article>`;
}

function showOrderConfirmation(order) {
  const destination = order.destination === "benin" ? "Bénin" : "Togo";
  const products = order.items.map((item) => `
    <div class="confirmation-product">
      <img src="${escapeHtml(item.image)}" alt="">
      <div><strong>${escapeHtml(item.name)}</strong><span>${item.priceEur ? `${formatNumber(item.priceEur)} € (indicatif)` : "Prix à confirmer"}</span></div>
    </div>`).join("");
  $("#confirmation-reference").textContent = order.reference;
  $("#confirmation-summary").innerHTML = `
    <h2>Récapitulatif du colis</h2>
    <div class="confirmation-products">${products}</div>
    <div class="confirmation-delivery">
      <strong>Livraison au ${destination}</strong>
      <span>${escapeHtml(order.customerName)} · ${escapeHtml(order.phone)}</span>
      <span>${escapeHtml(order.location)}</span>
      ${order.notes ? `<span>Précisions : ${escapeHtml(order.notes)}</span>` : ""}
    </div>`;
  const whatsappNumber = order.destination === "benin" ? "22997158484" : "22890290081";
  const message = [
    `Bonjour, voici la référence de mon colis : ${order.reference}.`,
    `Destinataire : ${order.customerName}.`,
    `Produits : ${order.items.map((item) => item.name).join(", ")}.`,
    `Livraison au ${destination} : ${order.location}.`
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
    if (currentUser.role !== "admin") $("#home-order-count").textContent = String(orders.length);
    target.innerHTML = orders.length
      ? orders.map((order) => renderOrder(order, currentUser.role === "admin")).join("")
      : '<div class="empty-state">Aucune commande pour le moment.</div>';
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
$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#auth-message");
  message.textContent = "";
  const form = new FormData(event.currentTarget);
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
  history.replaceState(null, "", window.location.pathname + window.location.search);
});

$("#customer-view").addEventListener("click", (event) => {
  const button = event.target.closest("[data-page-link]");
  if (button) showCustomerPage(button.dataset.pageLink);
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
  if (event.target.matches(".product-price")) refreshQuote();
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
  const button = event.target.closest("button[data-quote-id]");
  if (!button) return;
  const totalInput = $(`#quote-total-${button.dataset.quoteId}`);
  if (!totalInput.reportValidity()) return;
  const whatsappWindow = window.open("about:blank", "_blank");
  if (!whatsappWindow) {
    window.alert("Autorisez les fenêtres pop-up pour ouvrir le devis dans WhatsApp.");
    return;
  }
  whatsappWindow.opener = null;
  button.disabled = true;
  try {
    const total = Number(totalInput.value);
    await api(`/api/orders/${button.dataset.quoteId}/quote`, {
      method: "PATCH",
      body: JSON.stringify({ quoteTotalFcfa: total })
    });
    let phone = button.dataset.phone.replace(/\D/g, "");
    if (phone.length === 8) phone = `${button.dataset.destination === "benin" ? "229" : "228"}${phone}`;
    const text = [
      `Bonjour ${button.dataset.customer},`,
      `Votre devis pour le colis ${button.dataset.reference} est prêt.`,
      `Montant total à payer : ${formatNumber(total)} FCFA.`,
      "Après réception de votre paiement et vérification, nous lancerons la commande auprès du fournisseur."
    ].join("\n");
    whatsappWindow.location.href = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
    await loadOrders();
  } catch (error) {
    whatsappWindow.close();
    window.alert(error.message);
    button.disabled = false;
  }
});

if (isAdminRoute) {
  document.body.classList.add("admin-entry");
  $("#auth-view .eyebrow").textContent = "ESPACE ADMINISTRATEUR";
  $("#auth-view h1").textContent = "Administration";
  $("#auth-view .intro-copy").textContent = "Connectez-vous pour gérer les commandes et mettre à jour leur suivi.";
  $("#auth-view .steps-note").hidden = true;
  $("#signup-tab").hidden = true;
  $("#auth-submit").textContent = "Accéder à l'administration";
}

api("/api/me").then(({ user }) => {
  if (!isAdminRoute || user.role === "admin") showApp(user);
}).catch(() => {});
