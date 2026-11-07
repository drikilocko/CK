const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const bcrypt = require("bcryptjs");

const ROOT = __dirname;
const STATUSES = [
  "demande_recue",
  "devis_envoye",
  "colis_en_commande",
  "commande_fournisseur",
  "dans_avion",
  "arrive",
  "livre"
];

function loadLocalEnv() {
  const envFile = path.join(ROOT, ".env");
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

loadLocalEnv();
const PORT = Number(process.env.PORT || 3000);
const secureCookie = process.env.NODE_ENV === "production" ? "; Secure" : "";

const supabaseUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const supabaseKey = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const geminiApiKey = (process.env.GEMINI_API_KEY || "").trim();
const geminiModel = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
const recognitionUsage = new Map();
let initialization;

function supabaseQuery(table, query = {}) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
}

async function supabaseRequest(table, { method = "GET", query, body, prefer } = {}) {
  const response = await fetch(supabaseQuery(table, query), {
    method,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const responseText = await response.text();
  let data;
  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(`Supabase a renvoyé une réponse invalide (${response.status}).`);
    }
  }
  if (!response.ok) {
    const error = new Error(data?.message || data?.hint || `Erreur Supabase (${response.status}).`);
    error.code = data?.code;
    throw error;
  }
  return data;
}

async function createProductImageBucket() {
  const response = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: "ck-product-images",
      name: "ck-product-images",
      public: true,
      file_size_limit: 4194304,
      allowed_mime_types: ["image/jpeg", "image/png", "image/webp"]
    })
  });
  if (response.ok || response.status === 409) return;
  const data = await response.json().catch(() => ({}));
  throw new Error(data.message || `Impossible de créer le bucket ck-product-images (${response.status}).`);
}

async function uploadProductImage(filename, mimeType, image, createBucketOnMissing = true) {
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/ck-product-images/${encodeURIComponent(filename)}`,
    {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": mimeType,
        "x-upsert": "false"
      },
      body: image
    }
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (createBucketOnMissing && response.status === 404 && /bucket not found/i.test(data.message || "")) {
      try {
        await createProductImageBucket();
      } catch (error) {
        throw new Error(`Le bucket d'images Supabase est introuvable et n'a pas pu être créé. Exécutez supabase-schema.sql dans Supabase > SQL Editor. Détail : ${error.message}`);
      }
      return uploadProductImage(filename, mimeType, image, false);
    }
    throw new Error(data.message || `Impossible d'enregistrer l'image dans Supabase Storage (${response.status}).`);
  }
  return `${supabaseUrl}/storage/v1/object/public/ck-product-images/${encodeURIComponent(filename)}`;
}

async function verifySupabaseConfig() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Renseignez SUPABASE_URL et SUPABASE_SECRET_KEY dans .env.");
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    throw new Error("SUPABASE_URL doit être une URL valide de projet Supabase.");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") {
    throw new Error("SUPABASE_URL doit utiliser HTTPS.");
  }
  if (supabaseKey.startsWith("sb_publishable_")) {
    throw new Error("La clé Publishable ne convient pas au serveur. Utilisez une clé Secret Supabase.");
  }
  if (supabaseKey.startsWith("sb_secret_")) return;
  try {
    const payload = JSON.parse(Buffer.from(supabaseKey.split(".")[1], "base64url").toString("utf8"));
    if (payload.role === "service_role") return;
  } catch {
    throw new Error("Utilisez une clé Secret Supabase ou une ancienne clé service_role dans .env.");
  }
  throw new Error("La clé Supabase doit être une clé Secret ou service_role, pas une clé Publishable.");
}

async function checkSupabaseTables() {
  try {
    await supabaseRequest("ck_users", { query: { select: "id", limit: 0 } });
    await supabaseRequest("ck_sessions", { query: { select: "token_hash", limit: 0 } });
    await supabaseRequest("ck_orders", { query: { select: "id", limit: 0 } });
    await supabaseRequest("ck_orders", { query: { select: "quote_total_fcfa,quote_sent_at", limit: 0 } });
  } catch (error) {
    if (["42P01", "PGRST205"].includes(error.code)) {
      throw new Error("Tables CK manquantes dans Supabase. Exécutez supabase-schema.sql dans Supabase > SQL Editor.");
    }
    if (["42703", "PGRST204"].includes(error.code)) {
      throw new Error("Schéma CK incomplet. Exécutez supabase-schema.sql dans Supabase > SQL Editor.");
    }
    throw error;
  }
}

function initializeServer() {
  if (!initialization) {
    initialization = verifySupabaseConfig()
      .then(checkSupabaseTables)
      .then(ensureAdmin);
  }
  return initialization;
}

async function ensureAdmin() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username && !password) return;
  if (!username || !password || password.length < 12) {
    throw new Error("Configurez ADMIN_USERNAME et un ADMIN_PASSWORD d'au moins 12 caracteres dans .env.");
  }
  const [existing] = await supabaseRequest("ck_users", {
    query: { select: "id,role,password_hash", username: `eq.${username}`, limit: 1 }
  });
  if (existing) {
    if (existing.role !== "admin" || !(await bcrypt.compare(password, existing.password_hash))) {
      const passwordHash = await bcrypt.hash(password, 12);
      await supabaseRequest("ck_users", {
        method: "PATCH",
        query: { id: `eq.${existing.id}` },
        body: { role: "admin", password_hash: passwordHash }
      });
    }
    return;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await supabaseRequest("ck_users", {
    method: "POST",
    body: { username, password_hash: passwordHash, role: "admin" }
  });
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));
app.use((req, res, next) => {
  initializeServer().then(() => next()).catch(next);
});
app.use("/maplibre", express.static(path.join(ROOT, "node_modules", "maplibre-gl", "dist")));
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});
app.use(express.static(path.join(ROOT, "public")));

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readCookie(req, name) {
  const cookie = (req.headers.cookie || "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : "";
}

async function requireAuth(req, res, next) {
  try {
    const token = readCookie(req, "sid");
    if (!token) return res.status(401).json({ error: "Connectez-vous pour continuer." });
    const [session] = await supabaseRequest("ck_sessions", {
      query: {
        select: "user_id",
        token_hash: `eq.${hashToken(token)}`,
        expires_at: `gt.${Date.now()}`,
        limit: 1
      }
    });
    if (!session) return res.status(401).json({ error: "Session expirée. Veuillez vous reconnecter." });
    const [user] = await supabaseRequest("ck_users", {
      query: { select: "id,username,role", id: `eq.${session.user_id}`, limit: 1 }
    });
    if (!user) return res.status(401).json({ error: "Session expirée. Veuillez vous reconnecter." });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Accès réservé à l'administration." });
  next();
}

async function makeSession(userId, res) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await supabaseRequest("ck_sessions", {
    method: "POST",
    body: { token_hash: hashToken(token), user_id: userId, expires_at: expiresAt }
  });
  res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secureCookie}`);
}

async function validateImage(item) {
  if (typeof item.imageUrl === "string" && item.imageUrl.trim()) {
    let url;
    try {
      url = new URL(item.imageUrl);
    } catch {
      throw new Error("L'adresse de l'image n'est pas valide.");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("L'image doit utiliser une adresse HTTP ou HTTPS.");
    }
    return url.toString();
  }
  if (typeof item.imageData !== "string") {
    throw new Error("Ajoutez une image ou un lien vers l'image de chaque produit.");
  }
  const match = item.imageData.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("Format d'image invalide. Utilisez JPG, PNG ou WEBP.");
  const image = Buffer.from(match[2], "base64");
  if (!image.length || image.length > 4 * 1024 * 1024) {
    throw new Error("Chaque image doit peser moins de 4 Mo.");
  }
  const extension = match[1] === "jpeg" ? "jpg" : match[1];
  const filename = `${crypto.randomUUID()}.${extension}`;
  return uploadProductImage(filename, `image/${match[1]}`, image);
}

app.post("/api/signup", async (req, res, next) => {
  try {
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!/^[\p{L}\p{N}_.-]{3,30}$/u.test(username)) {
      return res.status(400).json({ error: "Le nom d'utilisateur doit contenir 3 à 30 lettres, chiffres, points, tirets ou underscores." });
    }
    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({ error: "Le mot de passe doit contenir entre 8 et 72 caractères." });
    }
    const hash = await bcrypt.hash(password, 12);
    const [user] = await supabaseRequest("ck_users", {
      method: "POST",
      body: { username, password_hash: hash },
      prefer: "return=representation"
    });
    await makeSession(user.id, res);
    res.status(201).json({ user: { username, role: "customer" } });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Ce nom d'utilisateur existe déjà." });
    }
    next(error);
  }
});

app.post("/api/login", async (req, res, next) => {
  try {
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const [user] = await supabaseRequest("ck_users", {
      query: { select: "id,username,password_hash,role", username: `eq.${username}`, limit: 1 }
    });
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Nom d'utilisateur ou mot de passe incorrect." });
    }
    await makeSession(user.id, res);
    res.json({ user: { username: user.username, role: user.role } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/logout", async (req, res, next) => {
  try {
    const token = readCookie(req, "sid");
    if (token) {
      await supabaseRequest("ck_sessions", {
        method: "DELETE",
        query: { token_hash: `eq.${hashToken(token)}` }
      });
    }
    res.setHeader("Set-Cookie", `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie}`);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: { username: req.user.username, role: req.user.role } });
});

app.post("/api/recognize-product", requireAuth, async (req, res, next) => {
  try {
    if (!geminiApiKey) {
      return res.status(503).json({ error: "La reconnaissance photo n'est pas configurée. Ajoutez GEMINI_API_KEY dans .env." });
    }
    const now = Date.now();
    const usage = recognitionUsage.get(req.user.id);
    if (usage && now - usage.startedAt < 60_000 && usage.count >= 20) {
      return res.status(429).json({ error: "Limite de 20 analyses photo par minute atteinte. Réessayez dans un instant." });
    }
    recognitionUsage.set(req.user.id, usage && now - usage.startedAt < 60_000
      ? { startedAt: usage.startedAt, count: usage.count + 1 }
      : { startedAt: now, count: 1 });
    if (recognitionUsage.size > 1000) {
      for (const [userId, entry] of recognitionUsage) {
        if (now - entry.startedAt >= 60_000) recognitionUsage.delete(userId);
      }
    }
    const imageData = req.body.imageData;
    const match = typeof imageData === "string"
      ? imageData.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/)
      : null;
    if (!match) return res.status(400).json({ error: "Image invalide. Utilisez JPG, PNG ou WEBP." });
    const image = Buffer.from(match[2], "base64");
    if (!image.length || image.length > 4 * 1024 * 1024) {
      return res.status(400).json({ error: "L'image doit peser moins de 4 Mo." });
    }
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiApiKey },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: "Identifie l'objet principal visible. Réponds uniquement par un nom de produit court et descriptif en français (marque/modèle seulement si clairement lisibles). Si c'est impossible, réponds exactement : Produit à préciser." },
              { inline_data: { mime_type: `image/${match[1]}`, data: match[2] } }
            ]
          }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 80 }
        }),
        signal: AbortSignal.timeout(25000)
      }
    );
    const data = await response.json();
    if (!response.ok) {
      console.error("Erreur Gemini:", data.error?.status || response.status);
      return res.status(response.status === 429 ? 503 : 502).json({
        error: response.status === 429
          ? "La reconnaissance est momentanément limitée. Réessayez plus tard."
          : "Le service de reconnaissance n'a pas pu analyser cette image."
      });
    }
    const suggestion = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join(" ")
      .trim()
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .slice(0, 120);
    if (!suggestion) return res.status(502).json({ error: "Aucun nom de produit n'a pu être proposé pour cette image." });
    res.json({ suggestion });
  } catch (error) {
    next(error);
  }
});

app.post("/api/orders", requireAuth, async (req, res, next) => {
  try {
    const { customerName, phone, destination, location, notes, items } = req.body;
    if (typeof customerName !== "string" || !customerName.trim() || customerName.trim().length > 100) {
      return res.status(400).json({ error: "Indiquez le nom complet du destinataire." });
    }
    if (typeof phone !== "string" || !phone.trim() || phone.trim().length > 30) {
      return res.status(400).json({ error: "Indiquez un numéro de téléphone valide." });
    }
    if (!["benin", "togo"].includes(destination)) {
      return res.status(400).json({ error: "Choisissez le Bénin ou le Togo comme destination." });
    }
    if (typeof location !== "string" || !location.trim() || location.trim().length > 300) {
      return res.status(400).json({ error: "Indiquez la ville et l'adresse de livraison." });
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
      return res.status(400).json({ error: "Un panier doit contenir entre 1 et 20 produits." });
    }
    let subtotal = 0;
    const cleanItems = await Promise.all(items.map(async (item) => {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const priceEur = item.priceEur === "" || item.priceEur === null || item.priceEur === undefined
        ? null
        : Number(item.priceEur);
      if (!name || name.length > 120
        || (priceEur !== null && (!Number.isFinite(priceEur) || priceEur <= 0 || priceEur > 1000000))) {
        throw new Error("Chaque produit doit avoir un nom et, si indiqué, un prix en euros valide.");
      }
      const image = await validateImage(item);
      if (priceEur !== null) subtotal += priceEur;
      return { name, priceEur, image };
    }));
    subtotal = Math.round(subtotal * 100) / 100;
    const [savedOrder] = await supabaseRequest("ck_orders", {
      method: "POST",
      prefer: "return=representation",
      body: {
        user_id: req.user.id,
        customer_name: customerName.trim(),
        phone: phone.trim(),
        destination,
        location: location.trim(),
        notes: typeof notes === "string" ? notes.trim().slice(0, 1000) : "",
        items_json: cleanItems,
        subtotal_eur: subtotal,
        shipping_fcfa: 0,
        total_fcfa: 0,
        status: "demande_recue"
      }
    });
    res.status(201).json({
      order: {
        id: savedOrder.id,
        reference: savedOrder.reference,
        customerName: customerName.trim(),
        phone: phone.trim(),
        destination,
        location: location.trim(),
        notes: typeof notes === "string" ? notes.trim().slice(0, 1000) : "",
        items: cleanItems,
        subtotalEur: subtotal,
        shippingFcfa: null,
        totalFcfa: null,
        quoteTotalFcfa: null,
        status: "demande_recue"
      }
    });
  } catch (error) {
    if (error instanceof Error && !error.code) return res.status(400).json({ error: error.message });
    next(error);
  }
});

function mapOrder(row) {
  return {
    id: row.id,
    reference: row.reference,
    username: row.username,
    customerName: row.customer_name,
    phone: row.phone,
    destination: row.destination,
    location: row.location,
    notes: row.notes,
    items: typeof row.items_json === "string" ? JSON.parse(row.items_json) : row.items_json,
    subtotalEur: row.subtotal_eur,
    shippingFcfa: row.shipping_fcfa,
    totalFcfa: row.total_fcfa,
    quoteTotalFcfa: row.quote_total_fcfa,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

app.get("/api/orders", requireAuth, async (req, res, next) => {
  try {
    const query = { select: "*", order: "created_at.desc,id.desc" };
    if (req.user.role !== "admin") query.user_id = `eq.${req.user.id}`;
    const rows = await supabaseRequest("ck_orders", { query });
    const userIds = [...new Set(rows.map((row) => row.user_id))];
    const usernames = new Map();
    if (userIds.length) {
      const users = await supabaseRequest("ck_users", {
        query: { select: "id,username", id: `in.(${userIds.join(",")})` }
      });
      for (const user of users) usernames.set(user.id, user.username);
    }
    res.json({
      orders: rows.map((row) => mapOrder({ ...row, username: usernames.get(row.user_id) || "" }))
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/orders/:id/quote", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: "Commande introuvable." });
    const quoteTotalFcfa = Number(req.body.quoteTotalFcfa);
    if (!Number.isSafeInteger(quoteTotalFcfa) || quoteTotalFcfa < 1 || quoteTotalFcfa > 1000000000) {
      return res.status(400).json({ error: "Indiquez le montant du devis en FCFA (de 1 à 1 000 000 000)." });
    }
    const updated = await supabaseRequest("ck_orders", {
      method: "PATCH",
      query: {
        id: `eq.${req.params.id}`,
        status: "in.(demande_recue,devis_envoye)",
        select: "id"
      },
      body: {
        quote_total_fcfa: quoteTotalFcfa,
        status: "devis_envoye",
        quote_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      prefer: "return=representation"
    });
    if (!updated.length) return res.status(404).json({ error: "Commande introuvable." });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/orders/:id/status", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const status = req.body.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: "Étape de livraison invalide." });
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: "Commande introuvable." });
    const updated = await supabaseRequest("ck_orders", {
      method: "PATCH",
      query: { id: `eq.${req.params.id}`, select: "id" },
      body: { status, updated_at: new Date().toISOString() },
      prefer: "return=representation"
    });
    if (!updated.length) return res.status(404).json({ error: "Commande introuvable." });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Route API introuvable." }));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Une erreur interne est survenue." });
});

if (require.main === module) {
  initializeServer().then(() => {
  app.listen(PORT, () => {
    console.log(`Site disponible sur http://localhost:${PORT}`);
  });
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = app;
