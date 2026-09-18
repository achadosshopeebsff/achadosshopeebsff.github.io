const crypto = require('node:crypto');

const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';
const APP_ID = process.env.SHOPEE_APP_ID;
const APP_SECRET = process.env.SHOPEE_APP_SECRET;
const ALLOWED_SHOP_TYPES = new Set([1, 2, 4]);
const BLOCKED_SHOP_WORDS = ['international','importadora','importado','imports','china','japao','japão','usa','united','global','world','mundo mix','temu','aliexpress','shein','shop global','overseas'];

function normalize(v) {
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function commissionPct(v) {
  const x = n(v);
  return x > 1 ? x : x * 100;
}

function priceLabel(v) {
  return n(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function salesLabel(v) {
  const x = n(v);
  if (x >= 1e6) return `${(x / 1e6).toFixed(1).replace('.', ',')} mi`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1).replace('.', ',')} mil`;
  return String(Math.round(x));
}

function signature(body, ts) {
  return crypto.createHash('sha256').update(`${APP_ID}${ts}${body}${APP_SECRET}`, 'utf8').digest('hex');
}

function fields() {
  return `itemId productName productLink offerLink imageUrl priceMin priceMax priceDiscountRate sales ratingStar commissionRate sellerCommissionRate shopeeCommissionRate commission shopId shopName shopType periodStartTime periodEndTime`;
}

async function graphql(keyword, sortType, page, limit) {
  const query = `query { productOfferV2(keyword: ${JSON.stringify(keyword)}, sortType: ${sortType}, page: ${page}, limit: ${limit}) { nodes { ${fields()} } pageInfo { page limit hasNextPage } } }`;
  const body = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000).toString();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${ts}, Signature=${signature(body, ts)}` },
    body,
    signal: AbortSignal.timeout(14000)
  });
  const raw = await res.text();
  let json; try { json = JSON.parse(raw); } catch { throw new Error(`Shopee HTTP ${res.status}`); }
  if (!res.ok || json?.errors?.length) throw new Error(json?.errors?.[0]?.message || `Shopee HTTP ${res.status}`);
  return Array.isArray(json?.data?.productOfferV2?.nodes) ? json.data.productOfferV2.nodes : [];
}

function eligible(p) {
  const price = n(p.priceMin || p.priceMax);
  const rating = n(p.ratingStar);
  const link = String(p.productLink || '');
  const offer = String(p.offerLink || '');
  const types = Array.isArray(p.shopType) ? p.shopType.map(Number) : [n(p.shopType)];
  const shopName = normalize(p.shopName);
  return price >= 10 && rating >= 4.5 && /^https:\/\/(?:www\.)?shopee\.com\.br\//i.test(link) && /^https?:\/\//i.test(offer) && types.some(t => ALLOWED_SHOP_TYPES.has(t)) && !BLOCKED_SHOP_WORDS.some(w => shopName.includes(normalize(w)));
}

function identity(p) {
  return normalize(p.productName).replace(/\b(kit|par|unidade|unidades|pcs|pc)\b/g, '').trim();
}

function mapProduct(p) {
  const price = n(p.priceMin || p.priceMax);
  const discount = n(p.priceDiscountRate);
  const old = discount > 0 ? price / Math.max(0.01, 1 - discount / 100) : 0;
  const rating = n(p.ratingStar);
  return {
    id: String(p.itemId), itemId: String(p.itemId), title: p.productName || 'Produto Shopee',
    desc: `${p.shopName || 'Loja Shopee'} · ${rating.toFixed(1)}★${p.sales ? ` · ${salesLabel(p.sales)} vendidos` : ''}`,
    image: p.imageUrl || '', tag: 'Shopee', accent: '#ee4d2d', icon: '🛍️',
    now: priceLabel(price), old: old > price ? priceLabel(old) : '', off: discount > 0 ? `-${Math.round(discount)}%` : '',
    rating: rating.toFixed(1), sales: n(p.sales), salesLabel: salesLabel(p.sales),
    commissionRate: commissionPct(p.commissionRate), commission: p.commission || '', shopName: p.shopName || '', shopId: String(p.shopId || ''),
    shopType: Array.isArray(p.shopType) ? p.shopType : [], marketplace: 'BR', productLink: p.productLink || '', affLink: p.offerLink || '',
    category1: 'Shopee', category2: '', category3: '', updatedAt: new Date().toISOString(), reviews: [], reviewVideos: [], productVideos: [], live: true
  };
}

module.exports = async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });
  if (!APP_ID || !APP_SECRET) return res.status(503).json({ error: 'API de afiliados não configurada.' });

  const q = String(req.query?.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Digite pelo menos 2 caracteres.' });
  const limit = Math.max(8, Math.min(Number(req.query?.limit || 80), 100));

  try {
    const sorts = [1, 2, 5];
    const pages = [1, 2];
    const batches = [];
    for (const sort of sorts) for (const page of pages) batches.push(graphql(q, sort, page, 50));
    const responses = await Promise.allSettled(batches);
    const raw = responses.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    const bestByIdentity = new Map();
    for (const p of raw) {
      if (!eligible(p)) continue;
      const key = identity(p);
      const existing = bestByIdentity.get(key);
      if (!existing || n(p.priceMin || p.priceMax) < n(existing.priceMin || existing.priceMax)) bestByIdentity.set(key, p);
    }
    const products = Array.from(bestByIdentity.values())
      .sort((a, b) => (n(b.sales) * 0.25 + commissionPct(b.commissionRate) * 2 + n(b.ratingStar) * 10) - (n(a.sales) * 0.25 + commissionPct(a.commissionRate) * 2 + n(a.ratingStar) * 10))
      .slice(0, limit)
      .map(mapProduct);
    return res.status(200).json({ query: q, products, source: 'Shopee Affiliate Open API', generatedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'Falha ao consultar a Shopee.' });
  }
};
