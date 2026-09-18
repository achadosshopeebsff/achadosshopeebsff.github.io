const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(process.cwd(), '.');
const CACHE_FILE = path.join(ROOT, 'review-cache.json');

function safeMedia(url) {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    const host = new URL(value).hostname.toLowerCase();
    return /(^|\.)shopee\.com(?:\.br)?$|(^|\.)susercontent\.com$/i.test(host) ? value : '';
  } catch { return ''; }
}

function sanitizeReview(value) {
  if (!value || !String(value.comment || '').trim()) return null;
  return {
    author: String(value.author || 'comprador anônimo').slice(0, 80),
    comment: String(value.comment).trim().slice(0, 500),
    rating: Math.max(1, Math.min(5, Number(value.rating || 5))),
    ctime: Number(value.ctime || 0)
  };
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}

async function providerFetch(req, shopId, itemId) {
  const base = String(process.env.SHOPEE_REVIEW_PROVIDER_URL || '').trim();
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set('shopId', shopId); url.searchParams.set('itemId', itemId);
  const headers = { Accept: 'application/json' };
  if (process.env.SHOPEE_REVIEW_PROVIDER_TOKEN) headers.Authorization = `Bearer ${process.env.SHOPEE_REVIEW_PROVIDER_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Review provider HTTP ${response.status}`);
  let data; try { data = JSON.parse(raw); } catch { throw new Error('Review provider JSON inválido'); }
  return data;
}

module.exports = async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const shopId = String(req.query?.shopId || '').trim();
  const itemId = String(req.query?.itemId || '').trim();
  if (!shopId || !itemId) return res.status(400).json({ error: 'shopId e itemId são obrigatórios.' });

  const cache = readCache();
  const cached = cache[itemId];
  if (cached) {
    return res.status(200).json({
      reviews: (Array.isArray(cached.reviews) ? cached.reviews : []).map(sanitizeReview).filter(Boolean).slice(0, 6),
      reviewVideos: (Array.isArray(cached.reviewVideos) ? cached.reviewVideos : []).map(safeMedia).filter(Boolean).slice(0, 4),
      productVideos: (Array.isArray(cached.productVideos) ? cached.productVideos : []).map(safeMedia).filter(Boolean).slice(0, 4),
      totalCount: Number(cached.totalCount || 0), source: cached.reviewSource || 'Shopee-authorized'
    });
  }

  try {
    const data = await providerFetch(req, shopId, itemId);
    if (!data) return res.status(404).json({ error: 'Nenhuma avaliação real sincronizada para este produto.' });
    return res.status(200).json({
      reviews: (Array.isArray(data.reviews) ? data.reviews : []).map(sanitizeReview).filter(Boolean).slice(0, 6),
      reviewVideos: (Array.isArray(data.reviewVideos) ? data.reviewVideos : []).map(safeMedia).filter(Boolean).slice(0, 4),
      productVideos: (Array.isArray(data.productVideos) ? data.productVideos : []).map(safeMedia).filter(Boolean).slice(0, 4),
      totalCount: Number(data.totalCount || 0), source: 'Shopee-authorized'
    });
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'Falha ao carregar avaliações reais.' });
  }
};
