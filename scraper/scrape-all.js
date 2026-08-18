/**
 * Bot de catálogo FIXO + atualização por item da Shopee Affiliate Open API (Brasil)
 *
 * NÃO pesquisa palavras-chave.
 * O catálogo base é fixo em ../fixed-products.json e cada item contém:
 *   - shopId/itemId (extraídos do productLink)
 *   - link de afiliado (offerLink) fornecido por você
 *
 * A cada execução o bot consulta a Shopee SOMENTE para esses itens e atualiza:
 *   imagem, nome, preço, desconto, vendas, avaliação, loja e comissão.
 * O offerLink fixo NÃO é substituído por link de busca nem por outro link.
 *
 * Credenciais SOMENTE via variáveis de ambiente:
 *   SHOPEE_APP_ID
 *   SHOPEE_APP_SECRET
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const FIXED_FILE = path.join(ROOT, 'fixed-products.json');
const OUTPUT_FILE = path.join(ROOT, 'products.json');
const LINKS_FILE = path.join(ROOT, 'links.json');
const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';

const APP_ID = process.env.SHOPEE_APP_ID;
const APP_SECRET = process.env.SHOPEE_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('❌ Credenciais ausentes. Configure SHOPEE_APP_ID e SHOPEE_APP_SECRET.');
  process.exit(1);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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
      'User-Agent': 'achadosshopeebsf/4.0'
    },
    body,
    signal: AbortSignal.timeout(20000)
  });

  const raw = await response.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Resposta não-JSON da Shopee (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(`Shopee HTTP ${response.status}: ${raw.slice(0, 500)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Shopee GraphQL: ${json.errors[0].message || 'erro desconhecido'}`);
  }
  return json.data;
}

function escapeGraphQLString(value) {
  return JSON.stringify(String(value));
}

function buildExactProductQuery({ shopId, itemId }) {
  return `query {
    productOfferV2(
      shopId: ${Number(shopId)},
      itemId: ${Number(itemId)},
      page: 1,
      limit: 1
    ) {
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
        sellerCommissionRate
        shopeeCommissionRate
        commission
        shopId
        shopName
        shopType
      }
      pageInfo {
        page
        limit
        hasNextPage
      }
    }
  }`;
}

function parseProductIdentity(productLink, itemId) {
  const match = String(productLink || '').match(/\/product\/(\d+)\/(\d+)/i);
  if (match) return { shopId: match[1], itemId: match[2] };
  return { shopId: '', itemId: String(itemId || '') };
}

async function fetchExactProduct(item) {
  const identity = parseProductIdentity(item.productLink, item.itemId);
  if (!identity.shopId || !identity.itemId) {
    throw new Error('productLink sem shopId/itemId reconhecíveis');
  }

  const data = await shopeeGraphQL(buildExactProductQuery(identity));
  return data?.productOfferV2?.nodes?.[0] || null;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseSalesSeed(value) {
  const text = String(value || '').toLowerCase().replace(',', '.');
  const match = text.match(/([0-9.]+)\s*(mi|mil)/);
  if (!match) return toNumber(text.replace(/\D/g, ''), 0);
  const n = Number(match[1]);
  if (match[2] === 'mi') return Math.round(n * 1000000);
  return Math.round(n * 1000);
}

function formatBRL(value) {
  const n = toNumber(value);
  if (!n) return '';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatSales(value, fallbackLabel) {
  const n = toNumber(value);
  if (n > 0) {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace('.', ',')} mi`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.', ',')} mil`;
    return String(Math.round(n));
  }
  return fallbackLabel || '';
}

function inferTag(name) {
  const n = String(name || '').toLowerCase();
  if (/fone|bluetooth|watch|relógio|relogio|nfc|smart/i.test(n)) return 'Eletrônicos';
  if (/chinel|tênis|tenis|calça|bermuda|roupa/i.test(n)) return 'Moda';
  if (/manta|lençol|lencol|cozinha|garrafa|trava óculos|oculos|organizador/i.test(n)) return 'Casa';
  if (/barbeador|beleza/i.test(n)) return 'Beleza';
  if (/whey|creatina|bcaa/i.test(n)) return 'Fitness';
  if (/capacete/i.test(n)) return 'Acessórios';
  if (/areia|catbio/i.test(n)) return 'Pets';
  if (/devocional|livro/i.test(n)) return 'Livros';
  return 'Achado';
}

function mergeProduct(seed, live) {
  const currentPrice = live ? toNumber(live.priceMin || live.priceMax) : 0;
  const seedPrice = toNumber(String(seed.price || '').replace('.', '').replace(',', '.'));
  const discount = live ? toNumber(live.priceDiscountRate) : 0;
  const price = currentPrice || seedPrice;
  const oldPrice = discount > 0 ? price / Math.max(0.01, 1 - discount / 100) : 0;
  const sales = live?.sales ? toNumber(live.sales) : parseSalesSeed(seed.sales);
  const rating = live?.ratingStar ? toNumber(live.ratingStar) : 0;
  const commissionRate = live?.commissionRate ? toNumber(live.commissionRate) * 100 : toNumber(String(seed.commissionRate).replace('%', ''));
  const commission = live?.commission || seed.commission || '';
  const title = live?.productName || seed.itemName;
  const shopName = live?.shopName || seed.shopName;
  const productLink = live?.productLink || seed.productLink;

  return {
    id: String(seed.itemId),
    title,
    desc: `${shopName}${rating ? ` · ${rating.toFixed(1)}★` : ''}${sales ? ` · ${formatSales(sales, seed.sales)} vendidos` : ''}`,
    image: live?.imageUrl || seed.image || '',
    tag: inferTag(title),
    accent: '#ee4d2d',
    icon: '🛍️',
    now: formatBRL(price) || `R$ ${seed.price}`,
    old: oldPrice > price ? formatBRL(oldPrice) : '',
    off: discount > 0 ? `-${Math.round(discount)}%` : '',
    rating: rating ? rating.toFixed(1) : '',
    sales,
    salesLabel: sales ? formatSales(sales, seed.sales) : seed.sales,
    commissionRate: commissionRate ? Number(commissionRate.toFixed(2)) : '',
    commission,
    shopName,
    shopId: String(parseProductIdentity(productLink, seed.itemId).shopId || ''),
    itemId: String(seed.itemId),
    productLink,
    affLink: seed.offerLink,
    category1: inferTag(title),
    category2: '',
    category3: '',
    updatedAt: new Date().toISOString()
  };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const fixed = readJson(FIXED_FILE, []);
  const previous = readJson(OUTPUT_FILE, []);

  if (!Array.isArray(fixed) || fixed.length === 0) {
    throw new Error('fixed-products.json está vazio. O catálogo fixo precisa ter produtos.');
  }

  console.log('🤖 Bot de catálogo fixo Shopee iniciado');
  console.log(`📦 ${fixed.length} produtos fixos | atualização somente por Item ID + Shop ID`);

  const previousById = new Map(Array.isArray(previous) ? previous.map(p => [String(p.itemId || p.id), p]) : []);
  const concurrency = 4;
  const results = await mapWithConcurrency(fixed, concurrency, async (seed) => {
    try {
      const live = await fetchExactProduct(seed);
      if (!live) {
        console.warn(`  ⚠ ${seed.itemId}: produto não retornado; mantendo dados anteriores/fixos.`);
        return { seed, live: null };
      }
      console.log(`  ✓ ${seed.itemId}: ${live.productName || seed.itemName}`);
      return { seed, live };
    } catch (error) {
      console.warn(`  ⚠ ${seed.itemId}: ${error.message}`);
      return { seed, live: null, error };
    }
  });

  const output = results.map(({ seed, live }) => {
    const prior = previousById.get(String(seed.itemId));
    const base = live ? mergeProduct(seed, live) : mergeProduct(seed, prior ? {
      productName: prior.title,
      imageUrl: prior.image,
      priceMin: prior.now,
      sales: prior.sales,
      ratingStar: prior.rating,
      commissionRate: prior.commissionRate ? Number(prior.commissionRate) / 100 : undefined,
      commission: prior.commission,
      shopName: prior.shopName,
      shopId: prior.shopId,
      productLink: prior.productLink
    } : null);
    // Regra principal: o link de afiliado é sempre o que você forneceu no fixed-products.json.
    base.affLink = seed.offerLink;
    base.productLink = live?.productLink || seed.productLink;
    return base;
  });

  // Nunca grava links de busca. links.json contém somente links de afiliado dos produtos fixos.
  const affiliateLinks = [...new Set(fixed.map(item => item.offerLink).filter(Boolean))];
  writeJson(OUTPUT_FILE, output);
  writeJson(LINKS_FILE, affiliateLinks);

  const liveImages = output.filter(p => p.image).length;
  console.log(`\n✅ ${output.length} produtos fixos publicados em products.json`);
  console.log(`🖼️ ${liveImages}/${output.length} com imagem disponível após a consulta`);
  console.log('🔗 links.json contém somente Offer Links de afiliado');
  console.log('⏱️ Próxima atualização: executada pelo GitHub Actions a cada 1 hora');
}

main().catch((error) => {
  console.error('Erro fatal:', error);
  process.exit(1);
});
