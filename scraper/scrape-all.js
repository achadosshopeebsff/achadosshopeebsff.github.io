/**
 * Catálogo inicial + descoberta automática pela Shopee Affiliate Open API.
 *
 * FASE 1 (primeira carga): usa os produtos fixos fornecidos pelo dono do site
 * para nunca abrir vazio.
 * FASE 2 (a cada 30 min): consulta productOfferV2 por palavras-chave e
 * top-performing, escolhe os melhores produtos e publica o catálogo dinâmico.
 * Cada produto usa o offerLink afiliado devolvido pela API; se ausente,
 * generateShortLink é usado como fallback.
 *
 * Em caso de falha total da API, products.json e links.json anteriores são
 * preservados para o site nunca ficar vazio.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const FIXED_FILE = path.join(ROOT, 'fixed-products.json');
const CONFIG_FILE = path.join(ROOT, 'bot-config.json');
const OUTPUT_FILE = path.join(ROOT, 'products.json');
const LINKS_FILE = path.join(ROOT, 'links.json');
const META_FILE = path.join(ROOT, 'sync-meta.json');
const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';

const APP_ID = process.env.SHOPEE_APP_ID;
const APP_SECRET = process.env.SHOPEE_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('❌ Credenciais ausentes. Configure SHOPEE_APP_ID e SHOPEE_APP_SECRET.');
  process.exit(1);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function sign(payload, timestamp) {
  const base = `${APP_ID}${timestamp}${payload}${APP_SECRET}`;
  return crypto.createHash('sha256').update(base, 'utf8').digest('hex');
}

async function graphql(query) {
  const body = JSON.stringify({ query });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = sign(body, timestamp);

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`,
      'User-Agent': 'achadosshopeebsf/6.0'
    },
    body,
    signal: AbortSignal.timeout(20000)
  });

  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error(`Resposta não-JSON da Shopee (${response.status})`); }

  if (!response.ok) throw new Error(`Shopee HTTP ${response.status}: ${raw.slice(0, 500)}`);
  if (json.errors?.length) throw new Error(`Shopee GraphQL: ${json.errors[0].message || 'erro desconhecido'}`);
  return json.data;
}

function productFields() {
  return `
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
    periodStartTime
    periodEndTime
  `;
}

function buildSearchQuery({ keyword, sortType = 1, page = 1, limit = 50, listType = null }) {
  const safeKeyword = JSON.stringify(String(keyword));
  const listTypeArg = Number.isInteger(listType) ? `, listType: ${listType}` : '';
  return `query {
    productOfferV2(
      keyword: ${safeKeyword},
      sortType: ${sortType},
      page: ${page},
      limit: ${limit}${listTypeArg}
    ) {
      nodes { ${productFields()} }
      pageInfo { page limit hasNextPage }
    }
  }`;
}

function buildTopQuery({ page = 1, limit = 50 }) {
  return `query {
    productOfferV2(
      listType: 2,
      sortType: 2,
      page: ${page},
      limit: ${limit}
    ) {
      nodes { ${productFields()} }
      pageInfo { page limit hasNextPage }
    }
  }`;
}

function buildShortLinkMutation(originUrl) {
  const safeUrl = JSON.stringify(String(originUrl));
  return `mutation {
    generateShortLink(input: { originUrl: ${safeUrl} }) { shortLink }
  }`;
}

async function generateAffiliateLink(product) {
  if (product?.offerLink) return product.offerLink;
  if (!product?.productLink) return '';
  try {
    const data = await graphql(buildShortLinkMutation(product.productLink));
    return data?.generateShortLink?.shortLink || '';
  } catch (error) {
    console.warn(`  ⚠ link afiliado não gerado para ${product.itemId}: ${error.message}`);
    return '';
  }
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parsePrice(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  if (raw.includes(',')) return toNumber(raw.replace(/\./g, '').replace(',', '.'));
  return toNumber(raw);
}

function formatBRL(value) {
  const n = toNumber(value);
  if (!n) return '';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatSales(value) {
  const n = toNumber(value);
  if (!n) return '';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace('.', ',')} mi`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.', ',')} mil`;
  return String(Math.round(n));
}

function ratingNumber(value) {
  return toNumber(value);
}

function commissionPct(value) {
  const n = toNumber(value);
  return n > 1 ? n : n * 100;
}

function inferTag(name) {
  const n = String(name || '').toLowerCase();
  if (/fone|bluetooth|watch|relógio|relogio|nfc|smart|eletr/i.test(n)) return 'Eletrônicos';
  if (/chinel|tênis|tenis|calça|bermuda|roupa|moda/i.test(n)) return 'Moda';
  if (/manta|lençol|lencol|cozinha|garrafa|trava|óculos|oculos|organizador|casa/i.test(n)) return 'Casa';
  if (/barbeador|beleza|maquiagem|cabelo/i.test(n)) return 'Beleza';
  if (/whey|creatina|bcaa|fitness|academia/i.test(n)) return 'Fitness';
  if (/capacete|carro|ferramenta/i.test(n)) return 'Acessórios';
  if (/areia|gato|cachorro|pet/i.test(n)) return 'Pets';
  if (/devocional|livro/i.test(n)) return 'Livros';
  return 'Achado';
}

function scoreProduct(p) {
  const price = toNumber(p.priceMin);
  const sales = toNumber(p.sales);
  const rating = ratingNumber(p.ratingStar);
  const discount = toNumber(p.priceDiscountRate);
  const commission = commissionPct(p.commissionRate);

  const priceScore = price > 0 ? Math.max(0, 30 - Math.min(price, 300) / 10) : 0;
  const salesScore = Math.min(30, Math.log10(Math.max(1, sales)) * 6);
  const ratingScore = Math.min(20, rating * 4);
  const discountScore = Math.min(10, discount / 2);
  const commissionScore = Math.min(10, commission / 2);
  return priceScore + salesScore + ratingScore + discountScore + commissionScore;
}

function normalizeProduct(product, affiliateLink) {
  const price = toNumber(product.priceMin || product.priceMax);
  const discount = toNumber(product.priceDiscountRate);
  const oldPrice = discount > 0 && price > 0 ? price / Math.max(0.01, 1 - discount / 100) : 0;
  const rating = ratingNumber(product.ratingStar);
  const sales = toNumber(product.sales);
  const commissionRate = commissionPct(product.commissionRate);

  return {
    id: String(product.itemId),
    title: product.productName || 'Produto Shopee',
    desc: `${product.shopName || 'Loja Shopee'}${rating ? ` · ${rating.toFixed(1)}★` : ''}${sales ? ` · ${formatSales(sales)} vendidos` : ''}`,
    image: product.imageUrl || '',
    tag: inferTag(product.productName),
    accent: '#ee4d2d',
    icon: '🛍️',
    now: formatBRL(price),
    old: oldPrice > price ? formatBRL(oldPrice) : '',
    off: discount > 0 ? `-${Math.round(discount)}%` : '',
    rating: rating ? rating.toFixed(1) : '',
    sales,
    salesLabel: formatSales(sales),
    commissionRate: commissionRate ? Number(commissionRate.toFixed(2)) : '',
    commission: product.commission || '',
    shopName: product.shopName || '',
    shopId: String(product.shopId || ''),
    itemId: String(product.itemId),
    productLink: product.productLink || '',
    affLink: affiliateLink || product.offerLink || '',
    category1: inferTag(product.productName),
    category2: '',
    category3: '',
    updatedAt: new Date().toISOString()
  };
}

function fixedAsFallback(fixed) {
  return fixed.map((p) => ({
    id: String(p.itemId),
    title: p.itemName,
    desc: `${p.shopName || 'Shopee'} · ${p.sales || ''} vendidos`,
    image: p.image || '',
    tag: inferTag(p.itemName),
    accent: '#ee4d2d',
    icon: '🛍️',
    now: p.price ? `R$ ${p.price}` : 'Consultar',
    old: '',
    off: '',
    rating: p.rating || '',
    sales: 0,
    salesLabel: p.sales || '',
    commissionRate: commissionPct(String(p.commissionRate || '').replace('%', '')),
    commission: p.commission || '',
    shopName: p.shopName || '',
    shopId: String(String(p.productLink || '').match(/\/product\/(\d+)\//)?.[1] || ''),
    itemId: String(p.itemId),
    productLink: p.productLink || '',
    affLink: p.offerLink || '',
    category1: inferTag(p.itemName),
    category2: '',
    category3: '',
    updatedAt: new Date().toISOString()
  }));
}

async function searchKeyword(keyword, config) {
  const results = [];
  const pages = Math.max(1, Math.min(config.pagesPerKeyword || 2, 5));
  const limit = Math.max(1, Math.min(config.limitPerQuery || 50, 500));
  for (let page = 1; page <= pages; page++) {
    const data = await graphql(buildSearchQuery({ keyword, sortType: 2, page, limit }));
    const connection = data?.productOfferV2;
    results.push(...(connection?.nodes || []));
    if (!connection?.pageInfo?.hasNextPage) break;
  }
  return results;
}

async function topPerforming(config) {
  const limit = Math.max(1, Math.min(config.topPerformingLimit || 50, 500));
  const data = await graphql(buildTopQuery({ page: 1, limit }));
  return data?.productOfferV2?.nodes || [];
}

async function collectDynamicProducts(config) {
  const map = new Map();
  const keywords = Array.isArray(config.keywords) ? config.keywords : [];

  for (const keyword of keywords) {
    try {
      const nodes = await searchKeyword(keyword, config);
      console.log(`  ✓ ${keyword}: ${nodes.length} produtos encontrados`);
      for (const node of nodes) {
        const id = String(node.itemId || '');
        if (id) map.set(id, node);
      }
    } catch (error) {
      console.warn(`  ⚠ ${keyword}: ${error.message}`);
    }
  }

  if (config.includeTopPerforming !== false) {
    try {
      const nodes = await topPerforming(config);
      console.log(`  ✓ top-performing: ${nodes.length} produtos encontrados`);
      for (const node of nodes) {
        const id = String(node.itemId || '');
        if (id) map.set(id, node);
      }
    } catch (error) {
      console.warn(`  ⚠ top-performing: ${error.message}`);
    }
  }

  return [...map.values()];
}

async function buildDynamicCatalog(nodes, config) {
  const ranked = nodes
    .filter((p) => p && p.itemId && p.productLink && p.imageUrl)
    .map((p) => ({ p, score: scoreProduct(p) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, config.maxProducts || 80));

  const results = [];
  for (const { p } of ranked) {
    const affiliateLink = await generateAffiliateLink(p);
    if (!affiliateLink) continue;
    results.push(normalizeProduct(p, affiliateLink));
  }
  return results;
}

function writeSyncMeta({ startedAt, completedAt, productsCount, source }) {
  const intervalMinutes = 30;
  const nextUpdateAt = new Date(Date.parse(completedAt) + intervalMinutes * 60 * 1000).toISOString();
  writeJson(META_FILE, {
    status: 'success',
    source,
    intervalMinutes,
    startedAt,
    completedAt,
    nextUpdateAt,
    productsCount
  });
}

async function main() {
  const config = readJson(CONFIG_FILE, {
    refreshIntervalMinutes: 30,
    maxProducts: 80,
    minDynamicProducts: 20,
    pagesPerKeyword: 1,
    limitPerQuery: 50,
    topPerformingLimit: 50,
    includeTopPerforming: true,
    keywords: []
  });
  const fixed = readJson(FIXED_FILE, []);
  const previous = readJson(OUTPUT_FILE, []);
  const startedAt = new Date().toISOString();

  if (!Array.isArray(fixed) || fixed.length === 0) throw new Error('fixed-products.json está vazio.');

  console.log('🤖 Bot de achadinhos Shopee iniciado');
  console.log(`🟢 Catálogo inicial: ${fixed.length} produtos fixos`);
  console.log(`🔄 Depois, catálogo dinâmico: até ${config.maxProducts || 80} produtos`);
  console.log(`⏱️ Atualização programada: a cada ${config.refreshIntervalMinutes || 30} minutos`);

  let dynamic = [];
  try {
    const candidates = await collectDynamicProducts(config);
    console.log(`\n📊 ${candidates.length} candidatos únicos após coleta.`);
    dynamic = await buildDynamicCatalog(candidates, config);
    console.log(`✅ ${dynamic.length} produtos dinâmicos com link de afiliado e imagem.`);
  } catch (error) {
    console.warn(`⚠️ Falha total na coleta dinâmica: ${error.message}`);
  }

  const hasEnoughDynamic = dynamic.length >= Math.max(1, config.minDynamicProducts || 20);
  const previousIsDynamic = Array.isArray(previous) && previous.some((p) => p?.source === 'api-dynamic');

  let output;
  let source;
  if (hasEnoughDynamic) {
    output = dynamic.map((p) => ({ ...p, source: 'api-dynamic' }));
    source = 'api-dynamic';
  } else if (Array.isArray(previous) && previous.length > 0) {
    output = previous;
    source = previousIsDynamic ? 'previous-dynamic' : 'previous-fallback';
    console.warn(`⚠️ Só ${dynamic.length} produtos dinâmicos válidos; mantendo catálogo anterior.`);
  } else {
    output = fixedAsFallback(fixed).map((p) => ({ ...p, source: 'fixed-fallback' }));
    source = 'fixed-fallback';
    console.warn('⚠️ Primeira execução sem retorno suficiente da API; publicando catálogo inicial fixo.');
  }

  const affiliateLinks = output.map((p) => p.affLink).filter(Boolean);
  writeJson(OUTPUT_FILE, output);
  writeJson(LINKS_FILE, affiliateLinks);
  const completedAt = new Date().toISOString();
  writeSyncMeta({ startedAt, completedAt, productsCount: output.length, source });

  console.log(`\n✅ products.json: ${output.length} produtos`);
  console.log(`🔗 links.json: ${affiliateLinks.length} links de afiliado`);
  console.log(`📦 fonte publicada: ${source}`);
  console.log(`⏱️ próxima atualização: 30 minutos após esta conclusão.`);
}

main().catch((error) => {
  console.error('Erro fatal:', error);
  process.exit(1);
});
