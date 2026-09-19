/**
 * Avaliações REAIS + vídeo de cada produto publicado (melhor esforço).
 *
 * De onde vêm os dados: a Shopee Affiliate Open API NÃO devolve avaliações nem
 * vídeo. Estes dados só existem nos endpoints públicos que a própria página do
 * produto usa (shopee.com.br/api/...). Eles não são oficiais, não têm
 * documentação e a Shopee pode bloquear/alterar a qualquer momento — sobretudo
 * para IPs de datacenter, como os do GitHub Actions.
 *
 * Regras deste script:
 *  - NUNCA inventa nada. Só entra no product-media.json o que a Shopee devolveu.
 *  - Só avaliações com comentário de verdade (texto próprio do cliente), sem
 *    links/telefones/contato, e com nota >= media.minReviewStars.
 *  - Requisições sequenciais e espaçadas (requestDelayMs). Não tenta burlar
 *    proteção anti-robô: se vier bloqueio (403/429/captcha) várias vezes
 *    seguidas, PARA (blockedStreakLimit) e registra o motivo em diagnostics.
 *  - Falha aqui nunca afeta products.json: o workflow roda este passo separado
 *    (continue-on-error) e o site simplesmente não mostra notificações/vídeo
 *    dos produtos sem dados.
 *
 * Saída: product-media.json  { generatedAt, diagnostics, items: { [itemId]: {
 *   fetchedAt, video: { url, duration } | null, reviews: [ { user, avatar,
 *   stars, text, at } ] } }, checked: { [itemId]: epochMs } }
 *
 * Uso local (IP residencial no Brasil costuma funcionar melhor que datacenter):
 *   node scraper/fetch-media.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PRODUCTS_FILE = path.join(ROOT, 'products.json');
const MEDIA_FILE = path.join(ROOT, 'product-media.json');
const CONFIG_FILE = path.join(ROOT, 'bot-config.json');

// Sobrescrevível só para testes locais com servidor de mentira.
const WEB_BASE = (process.env.SHOPEE_WEB_BASE || 'https://shopee.com.br').replace(/\/$/, '');
const AVATAR_BASE = process.env.SHOPEE_AVATAR_BASE || 'https://cf.shopee.com.br/file/';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ALLOWED_VIDEO_HOST = /(^|\.)(susercontent\.com|shopee\.com\.br|shopee\.com|shopeemobile\.com)$/i;
const BLOCK_ERROR_CODES = new Set([90309999, 90309998, 90309997, 403, 429]);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data)}\n`, 'utf8');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ---------- HTTP ----------

async function webGet(pathAndQuery, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${WEB_BASE}${pathAndQuery}`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5',
        'Referer': referer,
        'X-Requested-With': 'XMLHttpRequest',
        'X-API-SOURCE': 'pc'
      }
    });
    const type = String(res.headers.get('content-type') || '');
    if (res.status === 403 || res.status === 429 || res.status === 418) {
      return { ok: false, blocked: true, status: res.status, error: `HTTP ${res.status}` };
    }
    if (!res.ok) return { ok: false, blocked: false, status: res.status, error: `HTTP ${res.status}` };
    if (!/json/i.test(type)) {
      // Página HTML no lugar do JSON = captcha / verificação anti-robô.
      return { ok: false, blocked: true, status: res.status, error: 'resposta não-JSON (verificação anti-robô)' };
    }
    const json = await res.json();
    const code = num(json?.error, 0);
    if (code && BLOCK_ERROR_CODES.has(code)) {
      return { ok: false, blocked: true, status: res.status, error: `Shopee error ${code}` };
    }
    if (code) return { ok: false, blocked: false, status: res.status, error: `Shopee error ${code}` };
    return { ok: true, blocked: false, status: res.status, json };
  } catch (error) {
    // Rede fora / timeout / conexão recusada: conta como "sem acesso" para o
    // disjuntor, senão o script insistiria em todos os produtos à toa.
    return { ok: false, blocked: true, status: 0, error: error?.name === 'AbortError' ? 'timeout' : `rede: ${String(error?.cause?.code || error?.message || error)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Avaliações ----------

function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Comentários com contato/spam ficam de fora (privacidade e qualidade).
const CONTACT_LIKE = /https?:\/\/|www\.|@\w|\b\d{8,}\b|whats\s?app|telegram|instagram|\bzap\b|chama no|me chama/i;

function truncateAtWord(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).replace(/[\s,;:.\-–]+$/, '')}…`;
}

function safeUsername(raw) {
  const name = cleanText(raw).slice(0, 24);
  if (!name) return 'Cliente Shopee';
  if (/@/.test(name) || /\d{7,}/.test(name)) return 'Cliente Shopee';
  return name;
}

function extractReviews(json, itemId, cfg) {
  const list = json?.data?.ratings;
  if (!Array.isArray(list)) return [];
  const minStars = num(cfg.minReviewStars, 4);
  const minChars = num(cfg.minCommentChars, 15);
  const maxChars = num(cfg.maxCommentChars, 220);
  const seen = new Set();
  const out = [];
  for (const r of list) {
    if (!r || r.is_hidden) continue;
    // Garante que a avaliação é DESTE produto (o endpoint às vezes agrega variações).
    if (r.itemid != null && String(r.itemid) !== String(itemId)) continue;
    const stars = num(r.rating_star, 0);
    if (stars < minStars || stars > 5) continue;
    const text = cleanText(r.comment);
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (text.length < minChars || letters < 8) continue;
    if (CONTACT_LIKE.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const portrait = cleanText(r.author_portrait);
    out.push({
      user: safeUsername(r.author_username),
      avatar: cfg.includeAvatars !== false && /^[a-z0-9_-]{8,}$/i.test(portrait) ? `${AVATAR_BASE}${portrait}` : '',
      stars,
      text: truncateAtWord(text, maxChars),
      at: num(r.ctime, 0) || null
    });
    if (out.length >= num(cfg.reviewsPerProduct, 6)) break;
  }
  return out;
}

// ---------- Vídeo ----------

function isPlayableVideoUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_VIDEO_HOST.test(u.hostname) && /\.mp4(\?|$)/i.test(u.pathname + u.search);
  } catch { return false; }
}

function extractVideo(json, cfg) {
  const data = json?.data || {};
  const list = data.video_info_list || data.item?.video_info_list || data.item_basic?.video_info_list || [];
  if (!Array.isArray(list) || !list.length) return null;
  const target = num(cfg.videoTargetWidth, 480);
  for (const v of list) {
    const candidates = [];
    for (const f of Array.isArray(v?.formats) ? v.formats : []) {
      if (f?.url) candidates.push({ url: f.url, width: num(f.width, 0) });
    }
    if (v?.default_format?.url) candidates.push({ url: v.default_format.url, width: num(v.default_format.width, 0) });
    if (v?.video_url) candidates.push({ url: v.video_url, width: 0 });
    const playable = candidates.filter((c) => isPlayableVideoUrl(c.url));
    if (!playable.length) continue;
    // Prefere o formato mais próximo de ~480px de largura (leve, mas nítido no
    // círculo do scanner). Sem largura informada, fica por último.
    playable.sort((a, b) => {
      const da = a.width ? Math.abs(a.width - target) : 9999;
      const db = b.width ? Math.abs(b.width - target) : 9999;
      return da - db;
    });
    return { url: playable[0].url, duration: num(v.duration, 0) || null };
  }
  return null;
}

// ---------- Fluxo principal ----------

async function fetchOne(product, cfg, state) {
  const itemId = String(product.itemId || product.id);
  const shopId = String(product.shopId || '');
  if (!itemId || !shopId) return { reviews: [], video: null, skipped: true };
  const referer = `${WEB_BASE}/product/${shopId}/${itemId}`;
  const result = { reviews: [], video: null, anyOk: false };

  async function call(url) {
    const r = await webGet(url, referer);
    if (r.blocked) { state.blockedStreak++; state.blockedResponses++; state.lastError = r.error; }
    else if (r.ok) state.blockedStreak = 0;
    else state.lastError = r.error;
    if (r.ok) result.anyOk = true;
    await sleep(num(cfg.requestDelayMs, 1200) + Math.floor(Math.random() * 300));
    return r;
  }

  const q = (o) => new URLSearchParams(o).toString();
  const limit = 20;

  let r = await call(`/api/v2/item/get_ratings?${q({ filter: 1, flag: 1, itemid: itemId, limit, offset: 0, shopid: shopId, type: 0 })}`);
  if (!r.ok && !r.blocked && state.blockedStreak === 0) {
    r = await call(`/api/v4/item/get_ratings?${q({ filter: 1, flag: 1, itemid: itemId, limit, offset: 0, shopid: shopId, type: 0 })}`);
  }
  if (r.ok) result.reviews = extractReviews(r.json, itemId, cfg);
  if (state.blockedStreak >= num(cfg.blockedStreakLimit, 6)) return result;

  let v = await call(`/api/v4/item/get?${q({ itemid: itemId, shopid: shopId })}`);
  if (!v.ok && !v.blocked && state.blockedStreak === 0) {
    v = await call(`/api/v4/pdp/get_pc?${q({ item_id: itemId, shop_id: shopId, tz_offset_minutes: -180, detail_level: 0 })}`);
  }
  if (v.ok) result.video = extractVideo(v.json, cfg);
  return result;
}

async function main() {
  const startedAt = Date.now();
  const config = readJson(CONFIG_FILE, {});
  const cfg = { enabled: true, maxProductsPerRun: 160, timeBudgetSeconds: 420, requestDelayMs: 1200, blockedStreakLimit: 6, ...(config.media || {}) };

  const products = readJson(PRODUCTS_FILE, []);
  const previous = readJson(MEDIA_FILE, {});
  const catalogIds = new Set(products.map((p) => String(p.itemId || p.id)));

  // Mantém só o que ainda está no catálogo publicado (o catálogo troca a cada ciclo).
  const items = {};
  for (const [id, entry] of Object.entries(previous.items || {})) if (catalogIds.has(id)) items[id] = entry;
  const checked = {};
  for (const [id, ts] of Object.entries(previous.checked || {})) if (catalogIds.has(id)) checked[id] = ts;

  const diagnostics = {
    enabled: cfg.enabled !== false,
    catalogSize: products.length,
    attempted: 0,
    withReviews: 0,
    withVideo: 0,
    blockedResponses: 0,
    stoppedEarly: null,
    lastError: null
  };
  const state = { blockedStreak: 0, blockedResponses: 0, lastError: null };

  if (cfg.enabled === false) {
    console.log('ℹ️ media.enabled=false — coleta de avaliações/vídeo desligada.');
  } else {
    // Fila: categoria obrigatória (Cabelo Liso) primeiro, depois mais vendidos.
    const queue = products
      .filter((p) => !items[String(p.itemId || p.id)] && !checked[String(p.itemId || p.id)])
      .sort((a, b) => {
        const ah = a.tag === 'Cabelo Liso' ? 1 : 0;
        const bh = b.tag === 'Cabelo Liso' ? 1 : 0;
        if (ah !== bh) return bh - ah;
        return num(b.sales) - num(a.sales);
      })
      .slice(0, num(cfg.maxProductsPerRun, 160));

    console.log(`🎞️ Coletando avaliações/vídeo: ${queue.length} produtos na fila (de ${products.length}).`);
    for (const product of queue) {
      if ((Date.now() - startedAt) / 1000 > num(cfg.timeBudgetSeconds, 420)) { diagnostics.stoppedEarly = 'time-budget'; break; }
      if (state.blockedStreak >= num(cfg.blockedStreakLimit, 6)) { diagnostics.stoppedEarly = 'blocked'; break; }
      const id = String(product.itemId || product.id);
      const res = await fetchOne(product, cfg, state);
      diagnostics.attempted++;
      if (res.skipped) continue;
      if (res.reviews.length || res.video) {
        items[id] = { fetchedAt: new Date().toISOString(), video: res.video, reviews: res.reviews };
        if (res.reviews.length) diagnostics.withReviews++;
        if (res.video) diagnostics.withVideo++;
      } else if (res.anyOk) {
        checked[id] = Date.now(); // respondeu, mas o produto não tem comentário/vídeo elegível
      }
    }
    if (state.blockedStreak >= num(cfg.blockedStreakLimit, 6)) diagnostics.stoppedEarly = 'blocked';
  }

  diagnostics.blockedResponses = state.blockedResponses;
  diagnostics.lastError = state.lastError;
  diagnostics.itemsPublished = Object.keys(items).length;
  diagnostics.elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

  writeJson(MEDIA_FILE, {
    generatedAt: new Date().toISOString(),
    source: 'shopee-web-best-effort',
    diagnostics,
    items,
    checked
  });

  console.log(`✅ product-media.json: ${diagnostics.itemsPublished} produtos com avaliações/vídeo (${diagnostics.withReviews} novos com avaliações, ${diagnostics.withVideo} com vídeo).`);
  if (diagnostics.stoppedEarly === 'blocked') {
    console.warn(`⚠️ A Shopee bloqueou as consultas (${state.lastError}). Coleta interrompida de propósito; o site segue normal, só sem notificações/vídeo desses produtos.`);
  }
}

main().catch((error) => {
  // Nunca derruba o workflow por causa disto.
  console.error('Aviso: coleta de mídia falhou:', error);
  process.exit(0);
});
