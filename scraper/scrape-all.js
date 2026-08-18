/**
 * Atualizador de produtos Shopee Affiliate Open API (Brasil)
 *
 * - Usa productOfferV2 para dados reais de produto/preço/imagem/rating.
 * - Usa generateShortLink quando precisa criar/atualizar o link afiliado.
 * - Não usa Puppeteer/scraping de HTML: menos CPU, menos memória e menos falhas.
 * - Lê links.json e grava products.json.
 *
 * Credenciais SOMENTE via variáveis de ambiente:
 *   SHOPEE_APP_ID
 *   SHOPEE_APP_SECRET
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const LINKS_FILE = path.join(ROOT, 'links.json');
const OUTPUT_FILE = path.join(ROOT, 'products.json');
const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';

const APP_ID = process.env.SHOPEE_APP_ID;
const APP_SECRET = process.env.SHOPEE_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('Credenciais ausentes. Configure SHOPEE_APP_ID e SHOPEE_APP_SECRET.');
  process.exit(1);
}

function sign(payload, timestamp) {
  const base = `${APP_ID}${timestamp}${payload}${APP_SECRET}`;
  return crypto.createHash('sha256').update(base, 'utf8').digest('hex');
}

async function shopeeGraphQL(query) {
  const body = JSON.stringify({ query });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = sign(body, timestamp);

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`,
      'User-Agent': 'achadosshopeebsf/2.0'
    },
    body,
    signal: AbortSignal.timeout(20000)
  });

  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error(`Resposta não-JSON da Shopee (${response.status})`); }

  if (!response.ok) throw new Error(`Shopee HTTP ${response.status}: ${raw.slice(0, 500)}`);
  if (json.errors?.length) throw new Error(`Shopee GraphQL: ${json.errors[0].message || 'erro desconhecido'}`);
  return json.data;
}

async function resolveUrl(url) {
  let current = url;
  for (let i = 0; i < 5; i++) {
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(12000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      if (!next) break;
      current = new URL(next, current).toString();
      continue;
    }
    return response.url || current;
  }
  return current;
}

function parseProductIds(url) {
  const u = new URL(url);
  const qpShop = u.searchParams.get('shopid') || u.searchParams.get('shop_id');
  const qpItem = u.searchParams.get('itemid') || u.searchParams.get('item_id');

  if (qpShop && qpItem) return { shopId: qpShop, itemId: qpItem };

  const productPath = u.pathname.match(/\/product\/(\d+)\/(\d+)/i);
  if (productPath) return { shopId: productPath[1], itemId: productPath[2] };

  const slugPath = u.pathname.match(/-i\.(\d+)\.(\d+)(?:\/|$)/i);
  if (slugPath) return { shopId: slugPath[1], itemId: slugPath[2] };

  const lastTwo = u.pathname.match(/\/(\d+)\/(\d+)(?:\/|$)/);
  if (lastTwo) return { shopId: lastTwo[1], itemId: lastTwo[2] };

  return null;
}

function escapeGraphQLString(value) {
  return JSON.stringify(String(value));
}

async function fetchOfferByIds(ids) {
  if (!ids?.itemId) return null;
  const args = [
    `itemId: ${ids.itemId}`,
    ids.shopId ? `shopId: ${ids.shopId}` : ''
  ].filter(Boolean).join(', ');

  const query = `query {
    productOfferV2(${args}, page: 1, limit: 1) {
      nodes {
        itemId
        productName
        productLink
        offerLink
        imageUrl
        priceMin
        priceMax
        priceDiscountRate
        sales
        ratingStar
        commissionRate
        shopId
        shopName
      }
    }
  }`;

  const data = await shopeeGraphQL(query);
  return data?.productOfferV2?.nodes?.[0] || null;
}

async function fetchOfferByKeyword(keyword) {
  if (!keyword) return null;
  const query = `query {
    productOfferV2(keyword: ${escapeGraphQLString(keyword)}, sortType: 5, page: 1, limit: 1) {
      nodes {
        itemId
        productName
        productLink
        offerLink
        imageUrl
        priceMin
        priceMax
        priceDiscountRate
        sales
        ratingStar
        commissionRate
        shopId
        shopName
      }
    }
  }`;
  const data = await shopeeGraphQL(query);
  return data?.productOfferV2?.nodes?.[0] || null;
}

async function generateShortLink(originUrl) {
  const mutation = `mutation {
    generateShortLink(input: {
      originUrl: ${escapeGraphQLString(originUrl)}
      subIds: ["site"]
    }) { shortLink }
  }`;

  const data = await shopeeGraphQL(mutation);
  return data?.generateShortLink?.shortLink || '';
}

function priceBRL(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normalize(item, sourceUrl) {
  const current = Number(item.priceMin ?? item.priceMax);
  const discount = Number(item.priceDiscountRate || 0);
  const old = current > 0 && discount > 0
    ? current / (1 - discount / 100)
    : 0;

  return {
    affLink: item.offerLink || sourceUrl,
    productLink: item.productLink || sourceUrl,
    title: item.productName || 'Produto Shopee',
    desc: item.shopName ? `Oferta da loja ${item.shopName}.` : 'Oferta encontrada na Shopee.',
    image: item.imageUrl || '',
    tag: 'Shopee',
    accent: '#ee4d2d',
    icon: '🛍️',
    now: priceBRL(current),
    old: old > current ? priceBRL(old) : '',
    off: discount > 0 ? `-${Math.round(discount)}%` : '',
    rating: item.ratingStar ? `${Number(item.ratingStar).toFixed(1)}` : '',
    sales: Number.isFinite(Number(item.sales)) ? Number(item.sales) : '',
    commissionRate: item.commissionRate || '',
    updatedAt: new Date().toISOString()
  };
}

async function processLink(sourceUrl, index) {
  console.log(`\n[${index + 1}] ${sourceUrl}`);
  try {
    const resolved = await resolveUrl(sourceUrl);
    const ids = parseProductIds(resolved);
    let offer = ids ? await fetchOfferByIds(ids) : null;

    // Algumas URLs curtas não expõem IDs no primeiro redirect.
    // Nesse caso, a API ainda pode gerar um link afiliado, mas sem
    // identificação suficiente para buscar preço por item.
    let affLink = '';
    try { affLink = await generateShortLink(resolved); } catch (err) {
      console.warn('  Link afiliado não gerado:', err.message);
    }

    if (!offer) {
      console.warn('  Oferta por ID não encontrada; tentando palavra-chave da URL.');
      const slug = new URL(resolved).pathname
        .replace(/[-_]+/g, ' ')
        .replace(/[^a-zA-ZÀ-ÿ0-9 ]/g, ' ')
        .trim()
        .slice(0, 80);
      if (slug) offer = await fetchOfferByKeyword(slug);
    }

    if (!offer) {
      console.warn('  Produto não retornado pela API. Mantendo link para próxima execução.');
      return null;
    }

    const product = normalize(offer, affLink || sourceUrl);
    product.affLink = affLink || offer.offerLink || sourceUrl;
    return product;
  } catch (err) {
    console.error('  Falha:', err.message);
    return null;
  }
}

async function main() {
  const links = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
  if (!Array.isArray(links) || !links.length) {
    fs.writeFileSync(OUTPUT_FILE, '[]\n', 'utf8');
    console.log('Nenhum link configurado.');
    return;
  }

  const results = [];
  const seen = new Set();

  // Paralelismo pequeno para não pressionar a API nem o runner.
  for (let i = 0; i < links.length; i += 3) {
    const batch = links.slice(i, i + 3);
    const rows = await Promise.all(batch.map((url, offset) => processLink(String(url).trim(), i + offset)));
    for (const row of rows) {
      if (!row) continue;
      const key = `${row.title}|${row.affLink}`;
      if (!seen.has(key)) { seen.add(key); results.push(row); }
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2) + '\n', 'utf8');
  console.log(`\nProntos: ${results.length}/${links.length} produtos em products.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
