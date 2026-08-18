/**
 * Bot automático de achadinhos Shopee Affiliate Open API (Brasil)
 *
 * Descobre produtos sem links manuais:
 * - busca várias palavras-chave configuradas em bot-config.json
 * - também pode usar o feed "Top performing" sem palavra-chave
 * - filtra por preço, avaliação, vendas e comissão
 * - ranqueia os melhores achados
 * - usa offerLink como link afiliado oficial; gera shortLink como fallback
 * - grava products.json para o frontend consumir como arquivo estático
 *
 * Credenciais SOMENTE via variáveis de ambiente:
 *   SHOPEE_APP_ID
 *   SHOPEE_APP_SECRET
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'bot-config.json');
const OUTPUT_FILE = path.join(ROOT, 'products.json');
const LINKS_FILE = path.join(ROOT, 'links.json');
const LEGACY_LINKS_FILE = path.join(ROOT, 'links.json');
const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';

const APP_ID = process.env.SHOPEE_APP_ID;
const APP_SECRET = process.env.SHOPEE_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('Credenciais ausentes. Configure SHOPEE_APP_ID e SHOPEE_APP_SECRET.');
  process.exit(1);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const config = readJson(CONFIG_FILE, {});

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
      'User-Agent': 'achadosshopeebsf/3.0'
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

  if (!response.ok) throw new Error(`Shopee HTTP ${response.status}: ${raw.slice(0, 500)}`);
  if (json.errors?.length) {
    throw new Error(`Shopee GraphQL: ${json.errors[0].message || 'erro desconhecido'}`);
  }
  return json.data;
}

function escapeGraphQLString(value) {
  return JSON.stringify(String(value));
}

function buildProductQuery({ keyword = '', page = 1, limit, sortType, listType, productCatId }) {
  const args = [];
  if (keyword) args.push(`keyword: ${escapeGraphQLString(keyword)}`);
  if (Number.isInteger(listType)) args.push(`listType: ${listType}`);
  if (Number.isInteger(productCatId)) args.push(`productCatId: ${productCatId}`);
  args.push(`sortType: ${sortType}`);
  args.push(`page: ${page}`);
  args.push(`limit: ${limit}`);

  return `query {
    productOfferV2(${args.join(', ')}) {
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

async function fetchProducts({ keyword = '', pages = 2, limit, sortType, listType, productCatId }) {
  const rows = [];
  const maxPages = Math.max(1, Number(pages) || 1);
  for (let page = 1; page <= maxPages; page++) {
    const data = await shopeeGraphQL(buildProductQuery({ keyword, page, limit, sortType, listType, productCatId }));
    const connection = data?.productOfferV2;
    const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
    rows.push(...nodes);
    if (!connection?.pageInfo?.hasNextPage) break;
  }
  return rows;
}

async function generateShortLink(originUrl) {
  if (!originUrl) return '';
  try {
    const mutation = `mutation {
      generateShortLink(input: {
        originUrl: ${escapeGraphQLString(originUrl)}
        subIds: ["achadosshopeebsf"]
      }) { shortLink }
    }`;
    const data = await shopeeGraphQL(mutation);
    return data?.generateShortLink?.shortLink || '';
  } catch (error) {
    console.warn(`  Não foi possível gerar shortLink: ${error.message}`);
    return '';
  }
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatBRL(value) {
  const n = toNumber(value);
  if (!n) return '';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function salesLabel(sales) {
  const n = toNumber(sales);
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace('.', ',')} mi vendidos`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.', ',')} mil vendidos`;
  return `${Math.round(n)} vendidos`;
}

function normalizeProduct(item, affLink, categoryHint = 'Shopee') {
  const priceMin = toNumber(item.priceMin);
  const priceMax = toNumber(item.priceMax);
  const discount = Math.max(0, toNumber(item.priceDiscountRate));
  const referencePrice = priceMin || priceMax;
  const oldPrice = referencePrice > 0 && discount > 0
    ? referencePrice / Math.max(0.01, 1 - discount / 100)
    : 0;
  const commissionRate = toNumber(item.commissionRate) * 100;
  const rating = toNumber(item.ratingStar);
  const sales = Math.max(0, toNumber(item.sales));

  return {
    id: item.itemId ? String(item.itemId) : `${item.shopId || 'shop'}-${item.productName || 'produto'}`,
    affLink: affLink || item.offerLink || item.productLink || '',
    productLink: item.productLink || '',
    title: item.productName || 'Produto Shopee',
    desc: `${item.shopName || 'Loja Shopee'}${rating ? ` · ${rating.toFixed(1)}★` : ''}${sales ? ` · ${salesLabel(sales)}` : ''}`,
    image: item.imageUrl || '',
    tag: categoryHint || 'Shopee',
    accent: '#ee4d2d',
    icon: '🛍️',
    now: formatBRL(referencePrice),
    old: oldPrice > referencePrice ? formatBRL(oldPrice) : '',
    off: discount > 0 ? `-${Math.round(discount)}%` : '',
    rating: rating ? rating.toFixed(1) : '',
    sales,
    commissionRate: commissionRate ? Number(commissionRate.toFixed(2)) : '',
    shopName: item.shopName || '',
    shopId: item.shopId ? String(item.shopId) : '',
    itemId: item.itemId ? String(item.itemId) : '',
    category1: categoryHint || 'Shopee',
    category2: '',
    category3: '',
    updatedAt: new Date().toISOString()
  };
}

function passesFilters(item, rules) {
  const price = toNumber(item.priceMin || item.priceMax);
  const rating = toNumber(item.ratingStar);
  const sales = toNumber(item.sales);
  const commission = toNumber(item.commissionRate) * 100;

  if (price <= 0) return false;
  if (rules.minPrice > 0 && price < rules.minPrice) return false;
  if (rules.maxPrice > 0 && price > rules.maxPrice) return false;
  if (rating < rules.minRating) return false;
  if (sales < rules.minSales) return false;
  if (commission < rules.minCommissionRate) return false;
  if (!item.productLink && !item.offerLink) return false;
  return true;
}

function scoreProduct(item, rules) {
  const price = Math.max(0.01, toNumber(item.priceMin || item.priceMax));
  const rating = Math.min(5, Math.max(0, toNumber(item.ratingStar)));
  const sales = Math.max(0, toNumber(item.sales));
  const discount = Math.max(0, Math.min(100, toNumber(item.priceDiscountRate)));
  const commission = Math.max(0, toNumber(item.commissionRate) * 100);

  // Peso orientado a "achado barato e bom": avaliação + vendas + desconto,
  // com preço baixo e comissão ajudando a desempatar.
  const ratingScore = (rating / 5) * 35;
  const salesScore = Math.min(20, Math.log10(sales + 1) * 6);
  const discountScore = Math.min(15, discount * 0.6);
  const priceScore = Math.max(0, 15 - Math.log10(price + 1) * 5);
  const commissionScore = Math.min(15, commission * 0.75);

  let score = ratingScore + salesScore + discountScore + priceScore + commissionScore;
  if (rules.preferMall && Array.isArray(item.shopType) && item.shopType.includes(1)) score += 4;
  return Number(score.toFixed(4));
}

function dedupe(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = row.itemId ? String(row.itemId) : `${row.shopId}|${row.productName}`;
    if (!id) continue;
    const existing = map.get(id);
    if (!existing || scoreProduct(row, config.rules || {}) > scoreProduct(existing, config.rules || {})) {
      map.set(id, row);
    }
  }
  return [...map.values()];
}

async function enrichAffiliateLinks(products, maxShortLinks) {
  let generated = 0;
  for (const product of products) {
    if (product.offerLink) continue;
    if (generated >= maxShortLinks) break;
    const shortLink = await generateShortLink(product.productLink);
    if (shortLink) {
      product.offerLink = shortLink;
      generated++;
    }
  }
  return generated;
}

function stableSort(products) {
  return products
    .map((item) => ({ item, score: scoreProduct(item, config.rules || {}) }))
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

async function main() {
  const rules = {
    minRating: 4.6,
    minSales: 100,
    minCommissionRate: 0,
    minPrice: 0,
    maxPrice: 250,
    preferMall: true,
    ...(config.rules || {})
  };

  const keywords = Array.isArray(config.keywords) ? config.keywords.filter(Boolean) : [];
  const search = {
    resultsPerKeyword: 40,
    pagesPerKeyword: 1,
    sortTypes: [2, 4, 5],
    topPerformingResults: 60,
    ...(config.search || {})
  };

  console.log('🤖 Bot de achadinhos Shopee iniciado');
  console.log(`🔎 ${keywords.length} palavras-chave | alvo ${config.output?.maxProducts || 60} produtos`);

  const raw = [];
  const tasks = [];

  if (config.topPerforming?.enabled !== false) {
    tasks.push({ label: 'top-performing', keyword: '', listType: 2, sortType: 2, pages: 1, limit: Math.min(500, search.topPerformingResults) });
    tasks.push({ label: 'menor-preço', keyword: '', listType: 0, sortType: 4, pages: 1, limit: Math.min(500, search.topPerformingResults) });
  }

  for (const keyword of keywords) {
    for (const sortType of search.sortTypes) {
      tasks.push({
        label: keyword,
        keyword,
        listType: 0,
        sortType,
        pages: search.pagesPerKeyword,
        limit: Math.min(500, search.resultsPerKeyword)
      });
    }
  }

  // Paralelismo controlado para evitar sobrecarga do runner e da API.
  const concurrency = Math.max(1, Math.min(4, Number(config.search?.concurrency) || 3));
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const responses = await Promise.all(batch.map(async (task) => {
      try {
        const rows = await fetchProducts(task);
        for (const row of rows) row.__categoryHint = task.label && task.keyword ? task.label : (task.label === 'menor-preço' ? 'Ofertas' : 'Mais vendidos');
        console.log(`  ✓ ${task.label || 'geral'} (${task.sortType}): ${rows.length}`);
        return rows;
      } catch (error) {
        console.warn(`  ⚠ ${task.label || 'geral'}: ${error.message}`);
        return [];
      }
    }));
    raw.push(...responses.flat());
  }

  const filtered = dedupe(raw).filter((item) => passesFilters(item, rules));
  const ranked = stableSort(filtered);
  const maxProducts = Math.max(1, Math.min(500, Number(config.output?.maxProducts) || 60));
  const minUnique = Math.max(1, Math.min(maxProducts, Number(config.output?.minimumProducts) || 30));

  let selected = ranked.slice(0, maxProducts);
  if (selected.length < minUnique && rules.minRating > 0) {
    // Caso a Shopee retorne poucos itens com filtros rígidos, reduzimos apenas
    // o filtro de vendas para preservar variedade e nunca inventamos produto.
    const relaxed = dedupe(raw)
      .filter((item) => passesFilters(item, { ...rules, minSales: 0, minRating: Math.max(4.4, rules.minRating - 0.2) }))
      .map((item) => ({ item, score: scoreProduct(item, rules) }))
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
    selected = ranked.concat(relaxed).filter((item, idx, arr) => arr.findIndex((x) => x.itemId === item.itemId) === idx).slice(0, maxProducts);
  }

  // offerLink já é o link de afiliado retornado pela API. ShortLink só entra como fallback.
  const maxShortLinks = Math.max(0, Number(config.output?.maxShortLinks) || 10);
  const generated = await enrichAffiliateLinks(selected, maxShortLinks);

  const normalized = selected
    .map((item) => normalizeProduct(item, item.offerLink || item.productLink, item.__categoryHint || 'Shopee'))
    .filter((item) => item.affLink && item.image && item.now)
    .map((item) => ({ ...item, score: scoreProduct(item, rules) }));

  normalized.sort((a, b) => b.score - a.score);
  const output = normalized.slice(0, maxProducts);
  for (const item of output) delete item.score;

  const existingProducts = readJson(OUTPUT_FILE, []);
  const existingLinks = readJson(LINKS_FILE, []);

  // Nunca apaga um catálogo válido por causa de uma falha/retorno vazio da API.
  // Isso evita que o site fique sem produtos durante uma instabilidade temporária.
  if (output.length > 0) {
    fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    const affiliateLinks = [...new Set(output.map((item) => item.affLink).filter(Boolean))];
    fs.writeFileSync(LINKS_FILE, `${JSON.stringify(affiliateLinks, null, 2)}\n`, 'utf8');
  } else {
    console.warn('⚠️ Nenhum produto elegível retornado. Mantendo catálogo anterior.');
    const fallback = readJson(path.join(ROOT, 'fallback-products.json'), []);
    const safeProducts = Array.isArray(existingProducts) && existingProducts.length ? existingProducts : fallback;
    if (!Array.isArray(safeProducts) || safeProducts.length === 0) {
      throw new Error('A Shopee não retornou produtos e não existe catálogo de fallback.');
    }
    if (!Array.isArray(existingProducts) || existingProducts.length === 0) {
      fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(safeProducts, null, 2)}\n`, 'utf8');
    }
    const fallbackLinks = [...new Set(safeProducts.map((item) => item.affLink || item.productLink).filter(Boolean))];
    if (fallbackLinks.length) fs.writeFileSync(LINKS_FILE, `${JSON.stringify(fallbackLinks, null, 2)}\n`, 'utf8');
  }

  // Mantém a variável de compatibilidade para versões antigas do projeto.
  if (!fs.existsSync(LEGACY_LINKS_FILE)) fs.writeFileSync(LEGACY_LINKS_FILE, '[]\n', 'utf8');

  console.log(`\n✅ ${output.length} achadinhos publicados em products.json`);
  console.log(`🔗 ${generated} shortLinks gerados como fallback`);
  console.log(`📦 ${raw.length} resultados coletados → ${filtered.length} após filtros`);
}

main().catch((error) => {
  console.error('Erro fatal:', error);
  process.exit(1);
});
